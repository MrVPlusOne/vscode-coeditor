/* eslint-disable @typescript-eslint/naming-convention */


// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
const axios = require('axios').default;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	// const axios = await require('axios').default;
	const coeditorClient = new CoeditorClient(context);

	const disposables = [
		vscode.commands.registerCommand('vscode-coeditor.suggestEditsForSelection', coeditorClient.suggestEditsForSelection, coeditorClient),
		vscode.commands.registerCommand('vscode-coeditor.suggestEditsAgain', coeditorClient.suggestEditsAgain, coeditorClient),
		vscode.commands.registerCommand('vscode-coeditor.applySuggestion', coeditorClient.applySuggestion, coeditorClient),
	];
	context.subscriptions.push(...disposables);
}

// This method is called when your extension is deactivated
export function deactivate() { }

const SCHEME = "coeditor";
const suggestionFilePath = "/CoeditorSuggestions";


class CoeditorClient {
	codeLensProvider: vscode.CodeLensProvider;
	lastResponse: ServerResponse | undefined = undefined;
	suggestionSnippets: string[] = [];
	virtualFiles: { [name: string]: string; } = {};
	fileChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	channel: vscode.OutputChannel;
	targetDecoration: vscode.TextEditorDecorationType;
	target_lines: number[] | undefined = undefined;
	targetEditor: vscode.TextEditor | undefined = undefined;


	constructor(context: vscode.ExtensionContext) {
		if (axios === undefined) {
			throw new Error('axios is undefined');
		}
		this.channel = vscode.window.createOutputChannel("Coeditor");
		const client = this;
		const codeLensProvider: vscode.CodeLensProvider = {
			provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
				if (document.uri.scheme !== SCHEME || document.uri.path !== suggestionFilePath) {
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

		this.targetDecoration = vscode.window.createTextEditorDecorationType({
			gutterIconPath: context.asAbsolutePath("images/pen.svg"),
			gutterIconSize: "contain",
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});

		vscode.workspace.onDidCloseTextDocument(doc => {
			console.log(`onDidCloseTextDocument: ${doc.uri}`);
			if (doc.uri.scheme === SCHEME && doc.uri.path === suggestionFilePath) {
				console.log("onDidCloseTextDocument (coeditor)");
				client.target_lines = undefined;
				client.show_edit_lines();
			}
		}, client, context.subscriptions);

		this.channel.appendLine("Coeditor client initialized.");
	}

	async suggestEditsAgain() {
		await this.suggestEdits(true);
	}

	async suggestEditsForSelection() {
		await this.suggestEdits(false);
	}

	async suggestEdits(reuseLastTargets: boolean) {
		let editor: vscode.TextEditor;
		let targetLines: number[] | number;
		let targetDesc: string;
		if (reuseLastTargets){
			if (this.targetEditor === undefined) {
				vscode.window.showErrorMessage('No target editor found.');
				return;
			}
			if (this.target_lines === undefined) {
				vscode.window.showErrorMessage('No target lines found.');
				return;
			}
			editor = this.targetEditor;
			targetLines = this.target_lines;
			targetDesc = `for line ${targetLines[0]}--${targetLines[targetLines.length - 1]}`;
		} else {
		// if the activeText Editor is undefined, display an error
			if (vscode.window.activeTextEditor === undefined) {
				vscode.window.showErrorMessage('No active text editor. This command uses the ' +
					'location of the cursor to determine which code element to edit.');
				return;
			}
			editor = vscode.window.activeTextEditor;
			const lineBegin = editor.selection.start.line + 1;
			const lineEnd = editor.selection.end.line + 1;
			if (lineBegin !== lineEnd) {
				targetLines = Array.from({length: lineEnd - lineBegin + 1}, (_, i) => i + lineBegin);
				targetDesc = `for line ${lineBegin}--${lineEnd}`;
			} else {
				targetLines = lineBegin;
				targetDesc = `at line ${targetLines}`;
			}
		}

		const project = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (project === undefined) {
			vscode.window.showErrorMessage('Unable to determine the project folder for the active editor.');
			return;
		}
		
		const filePath = editor.document.fileName;
		const relPath = vscode.workspace.asRelativePath(filePath);
		this.targetEditor = editor;

		const saved = await editor.document.save();
		if (!saved) {
			vscode.window.showErrorMessage('Unable to proceed: failed to save the active editor.');
			return;
		}

		vscode.window.showInformationMessage(`Suggesting edit ${targetDesc} in ${relPath}`);
		const writeLogs = vscode.workspace.getConfiguration().get("coeditor.writeLogs");

		const req = {
			"jsonrpc": "2.0",
			"method": "suggestEdits",
			"params": {
				"project": project.uri.fsPath,
				"file": relPath,
				"lines": targetLines,
				"writeLogs": writeLogs,
			},
			"id": 1,
		};
		const serverLink = vscode.workspace.getConfiguration().get("coeditor.serverURL");
		const fullResponse = await axios.post(serverLink, req);
		if (fullResponse.data.error !== undefined) {
			vscode.window.showErrorMessage("Coeditor failed with error: " + fullResponse.data.error.message);
			return;
		}
		const response: ServerResponse = fullResponse.data.result;
		const res_to_show = {
			server_response: {
				target_file: response.target_file,
				edit_start: response.edit_start,
				edit_end: response.edit_end,
				target_lines: response.target_lines
			}
		};
		console.log(res_to_show);
		this.channel.appendLine(JSON.stringify(res_to_show));
		const suggestionSnippets = response.suggestions.map((suggestion) => {
			return `================= Score: ${suggestion.score.toPrecision(3)} =================\n${suggestion.change_preview}\n\n`;
		});
		this.lastResponse = response;
		this.suggestionSnippets = suggestionSnippets;
		this.virtualFiles[suggestionFilePath] = suggestionSnippets.join("");
		this.target_lines = response.target_lines;
		this.show_edit_lines();

		// open a new document
		const suggestionUri = vscode.Uri.from({ scheme: SCHEME, path: suggestionFilePath });
		this.fileChangeEmitter.fire(suggestionUri);
		const resultDoc = await vscode.workspace.openTextDocument(suggestionUri);
		const viewColumn = editor.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
		await vscode.window.showTextDocument(resultDoc, { preserveFocus: false, preview: false, viewColumn: viewColumn });
	}

	async applySuggestion(index: number) {
		if (this.lastResponse === undefined) {
			vscode.window.showErrorMessage('No suggestions to apply.');
			return;
		}
		const uri = vscode.Uri.file(this.lastResponse.target_file);
		const viewColumn = vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, viewColumn: viewColumn });

		const suggestion = this.lastResponse.suggestions[index];
		const start = new vscode.Position(this.lastResponse.edit_start[0] - 1, this.lastResponse.edit_start[1]);
		const end = new vscode.Position(this.lastResponse.edit_end[0] - 1, this.lastResponse.edit_end[1]);
		const range = new vscode.Range(start, end);
		const current = editor.document.getText(range);
		if (current !== this.lastResponse.old_code) {
			vscode.window.showWarningMessage(`The code to be replaced at range ${prettyPrintRange(range)} has changed. The applied edit may no longer be valid.`);
			this.channel.appendLine(`The code to be replaced at range ${prettyPrintRange(range)} has changed.\nCurrent code: ${current}<END>, expected code: ${this.lastResponse.old_code}<END>`);
		}
		const newEnd = [start.line + suggestion.new_code.split("\n").length, suggestion.new_code.split("\n").slice(-1)[0].length];
		await editor.edit((editBuilder) => {
			editBuilder.replace(range, suggestion.new_code);
		});
		this.lastResponse.edit_end = newEnd;
		this.lastResponse.old_code = suggestion.new_code;
	}

	show_edit_lines() {
		if (this.targetEditor === undefined) {
			return;
		}
		const editor = this.targetEditor;
		if (this.target_lines === undefined) {
			this.channel.appendLine("Clearing decorations.");
			editor.setDecorations(this.targetDecoration, []);
			return;
		}
		const start = new vscode.Position(this.target_lines[0] - 1, 0);
		const end = new vscode.Position(this.target_lines.slice(-1)[0] - 1, 0);
		editor.setDecorations(this.targetDecoration, [new vscode.Range(start, end)]);
	}

}

function prettyPrintRange(range: vscode.Range) {
	return `(${range.start.line + 1}:${range.start.character})-(${range.end.line + 1}:${range.end.character})`;
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
	target_lines: number[];
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
	],
	target_lines: [1, 2],
};