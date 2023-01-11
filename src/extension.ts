

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
const axios = require('axios').default;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	// const axios = await require('axios').default;
	const serverPort = 5042;

	const coeditorClient = new CoeditorClient(context, serverPort);

	const disposables = [
		vscode.commands.registerCommand('vscode-coeditor.suggestEdit', coeditorClient.suggestEdit, coeditorClient),
		vscode.commands.registerCommand('vscode-coeditor.applySuggestion', coeditorClient.applySuggestion, coeditorClient),
	];
	context.subscriptions.push(...disposables);
}

// This method is called when your extension is deactivated
export function deactivate() { }

const SCHEME = "coeditor";
const suggestionFilePath = "/CoeditorSuggestions";


class CoeditorClient {
	serverPort: number;
	codeLensProvider: vscode.CodeLensProvider;
	lastResponse: ServerResponse | undefined = undefined;
	suggestionSnippets: string[] = [];
	virtualFiles: { [name: string] : string; } = {};
	fileChangeEmitter = new vscode.EventEmitter<vscode.Uri>();


	constructor(context: vscode.ExtensionContext, serverPort: number) {
		this.serverPort = serverPort;
		if (axios === undefined) {
			throw new Error('axios is undefined');
		}
		const client = this;
		const codeLensProvider: vscode.CodeLensProvider = {
			provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
				if(document.uri.scheme !== SCHEME || document.uri.path !== suggestionFilePath) {
					return [];
				}
				let offset = 0;
				const actions = client.suggestionSnippets.map((snippet, i) => {
					const pos = document.positionAt(offset);
					const range = new vscode.Range(pos, pos);
					offset += snippet.length;
					return new vscode.CodeLens(range, {
						title: 'Apply suggestion',
						command: 'vscode-coeditor.applySuggestion',
						arguments: [i]
					});
				});

				return actions;
			}
		};
		this.codeLensProvider = codeLensProvider;

		const vFiles = this.virtualFiles;

		const contentProvider = new (class implements vscode.TextDocumentContentProvider {
  			onDidChange = client.fileChangeEmitter.event;
			provideTextDocumentContent(uri: vscode.Uri): string {
				return vFiles[uri.path];
			}
		})();

		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider('*', codeLensProvider),
			vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
		);
	}

	
	async suggestEdit() {
		// if the activeText Editor is undefined, display an error
		if (vscode.window.activeTextEditor === undefined) {
			vscode.window.showErrorMessage('No active text editor. This command uses the ' +
			'location of the cursor to determine which code element to edit.');
			return;
		}

		const project = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
		if (project === undefined) {
			vscode.window.showErrorMessage('Unable to determine the project folder for the active editor.');
			return;
		}

		const editor = vscode.window.activeTextEditor;
		const lineNumber = editor.selection.start.line + 1;
		const filePath = editor.document.fileName;
		const relPath = vscode.workspace.asRelativePath(filePath);

		const saved = await editor.document.save();
		if (!saved) {
			vscode.window.showErrorMessage('Unable to proceed: failed to save the active editor.');
			return;
		}
		
		vscode.window.showInformationMessage(`Suggesting edit at line ${lineNumber} in ${relPath}`);

		const req = {
			"jsonrpc": "2.0",
			"method": "suggestEdits",
			"params": {
				"project": project.uri.fsPath,
				"file": relPath,
				"line": lineNumber
			},
			"id": 1,
		};
		const fullResponse = await axios.post(`http://localhost:${this.serverPort}`, req);
		if(fullResponse.data.error !== undefined) {
			vscode.window.showErrorMessage("Coeditor failed with error: " + fullResponse.data.error.message);
			return;
		}
		const response: ServerResponse = fullResponse.data.result;
		response.target_file = project.uri.fsPath + "/" + response.target_file;
		console.log(response.suggestions);
		const suggestionSnippets = response.suggestions.map((suggestion) => {
			return `================= Score: ${suggestion.score.toPrecision(3)} =================\n${suggestion.change_preview}\n\n`;
		});
		this.lastResponse = response;
		this.suggestionSnippets = suggestionSnippets;
		this.virtualFiles[suggestionFilePath] = suggestionSnippets.join("");
		
		// open a new document
		const suggestionUri = vscode.Uri.from({scheme: SCHEME, path: suggestionFilePath});
		this.fileChangeEmitter.fire(suggestionUri);
		const resultDoc = await vscode.workspace.openTextDocument(suggestionUri);
		const viewColumn = editor.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
		vscode.window.showTextDocument(resultDoc, {preserveFocus: false, preview: false, viewColumn: viewColumn});
	}

	async applySuggestion(index: number) {
		if (this.lastResponse === undefined) {
			vscode.window.showErrorMessage('No suggestions to apply.');
			return;
		}
		const uri = vscode.Uri.file(this.lastResponse.target_file);
		const viewColumn = vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
		const doc = await vscode.workspace.openTextDocument(uri) ;
		const editor = await vscode.window.showTextDocument(doc, {preserveFocus: true, viewColumn: viewColumn});

		const suggestion = this.lastResponse.suggestions[index];
		const start = new vscode.Position(this.lastResponse.edit_start[0] - 1, this.lastResponse.edit_start[1]);
		const end = new vscode.Position(this.lastResponse.edit_end[0] - 1, this.lastResponse.edit_end[1]);
		const range = new vscode.Range(start, end);
		const current = editor.document.getText(range);
		if (current !== this.lastResponse.old_code) {
			vscode.window.showWarningMessage(`The code to be replaced at range ${prettyPrintRange(range)} has changed. The applied edit may no longer be valid.`);
		}
		await (await editor).edit((editBuilder) => {
			editBuilder.replace(range, suggestion.new_code);
		});
	}
}

function prettyPrintRange(range: vscode.Range) {
	return `(${range.start.line+1}:${range.start.character})-(${range.end.line+1}:${range.end.character})`;
}

/* eslint-disable @typescript-eslint/naming-convention */

interface EditSuggestion {
	score: number;
	change_preview: string;
	new_code: string;
}

interface ServerResponse {
	target_file: string;
	edit_start: number[];
	edit_end: number[];
	old_code: string;
	suggestions: EditSuggestion[];
}


const fakeResponse: ServerResponse = {
	target_file: "simple.py",
	edit_start: [1, 0],
	edit_end: [2, 0],
	old_code: "x = 5\n",
	suggestions: [
		{
			score: 0.5,
			change_preview: "- x = 5\n+ x = 6\n",
			new_code: "x = 6\n",
		},
		{
			score: 0.15,
			change_preview: "  x = 5\n+ y = x + 1\n",
			new_code: "x = 5\ny = x + 1\n",
		}
	]
};