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
		vscode.commands.registerCommand(
			'coeditor.suggestEditsForSelection',
			coeditorClient.suggestEditsForSelection,
			coeditorClient
		),
		vscode.commands.registerCommand(
			'coeditor.suggestEdits',
			coeditorClient.suggestEditsAgain,
			coeditorClient
		),
		vscode.commands.registerCommand(
			'coeditor.trySuggestEdits',
			coeditorClient.trySuggestEditsAgain,
			coeditorClient
		),
		vscode.commands.registerCommand(
			'coeditor.applySuggestion',
			coeditorClient.applySuggestion,
			coeditorClient
		),
	];
	context.subscriptions.push(...disposables);
}

// This method is called when your extension is deactivated
export function deactivate() { }

const SCHEME = "coeditor";
const suggestionFilePath = "/CoeditorSuggestions";
type ErrorMsg = string;


class CoeditorClient {
	codeLensProvider: vscode.CodeLensProvider;
	virtualFiles: { [name: string]: string; } = {};
	fileChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	channel: vscode.OutputChannel;
	targetDecoration: vscode.TextEditorDecorationType;

	lastResponse: ServerResponse | undefined = undefined;
	lastSuggestions: string[] = [];
	lastTargetUri: vscode.Uri | undefined = undefined;
	lastTargetLines: number[] | undefined = undefined;

	async suggestEditsAgain() {
		await this.suggestEdits(true);
	}

	async trySuggestEditsAgain() {
		await this.suggestEdits(true, true);
	}

	async suggestEditsForSelection() {
		await this.suggestEdits(false);
	}

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
				const actions = client.lastSuggestions.map((snippet, i) => {
					const pos = document.positionAt(offset);
					const range = new vscode.Range(pos, pos);
					offset += snippet.length;
					return new vscode.CodeLens(range, {
						title: 'Apply suggestion',
						command: 'coeditor.applySuggestion',
						arguments: [i]
					});
				});

				return actions;
			}
		};
		this.codeLensProvider = codeLensProvider;

		const contentProvider = new (class implements vscode.TextDocumentContentProvider {
			onDidChange = client.fileChangeEmitter.event;
			provideTextDocumentContent(uri: vscode.Uri): string {
				return client.virtualFiles[uri.path];
			}
		})();

		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider('*', codeLensProvider),
			vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
		);

		this.targetDecoration = this._createDecoration(context);

		// update decorations on theme change
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('workbench.colorTheme')) {
				// get color theme
				client.targetDecoration.dispose();
				client.targetDecoration = this._createDecoration(context);
				const editor = vscode.window.activeTextEditor;
				client._addDecorationToEditor(editor);
			}
		}));

		// add decorations to active editor
		vscode.window.onDidChangeActiveTextEditor(editor => {
			client._addDecorationToEditor(editor);
		}, client, context.subscriptions);

		// optionally suggestEdits on file save
		vscode.workspace.onDidSaveTextDocument(doc => {
			const runOnSave = vscode.workspace.getConfiguration().get('coeditor.runOnSave');
			const editor = vscode.window.activeTextEditor;
			client.channel.appendLine(`Document saved: ${doc.uri.fsPath}`);
			if (!(runOnSave && editor && editor.document.uri === doc.uri)) {
				return;
			}
			client.suggestEdits(true, true);
		}, client, context.subscriptions);

		this.channel.appendLine("Coeditor client initialized.");
	}


	async suggestEdits(tryReuseTargets: boolean, silentFail: boolean = false) {
		const client = this;
		function show_error(msg: string) {
			if (!silentFail) {
				vscode.window.showErrorMessage(msg);
			}
			const tag = silentFail ? "[error]" : "[silent error]";
			client.channel.appendLine(tag + " " + msg);
		}

		// if the activeText Editor is undefined, display an error
		const editor = vscode.window.activeTextEditor;
		if (editor === undefined) {
			show_error('No active text editor. This command uses the ' +
				'location of the cursor to determine which code element to edit.');
			return;
		}
		const targetLines = this._getTargetlines(editor, tryReuseTargets);
		if (typeof targetLines === "string") {
			show_error(targetLines);
			return;
		}
		const targetUri = editor.document.uri;
		const targetEditor = editor;

		this.lastTargetUri = targetUri;
		const viewColumn = targetEditor.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
		// check the type of targetLines
		const targetDesc = (
			(typeof targetLines === 'number') ? 
			`at line ${targetLines}` : 
			`for line ${targetLines[0]}--${targetLines[targetLines.length - 1]}`
		);

		const project = vscode.workspace.getWorkspaceFolder(targetUri);
		if (project === undefined) {
			show_error(
				'Unable to determine the project folder for the active editor.'
			);
			return;
		}
		
		const filePath = targetUri.fsPath;
		const relPath = vscode.workspace.asRelativePath(filePath);

		if (targetEditor.document.isDirty){
			const saved = await targetEditor.document.save();
			if (!saved) {
				show_error('Unable to proceed: failed to save the active editor.');
				return;
			}
		}

		const prompt = `Suggesting edits for '${relPath}' (${targetDesc})...`;
		const panelUri = this._updateSuggestPanel(prompt);
		const panelDoc = await vscode.workspace.openTextDocument(panelUri);
		// open a new document
		await vscode.window.showTextDocument(panelDoc, { preserveFocus: false, preview: false, viewColumn: viewColumn });

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
			show_error(
				"Coeditor failed with error: " + fullResponse.data.error.message
			);
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
		this.lastSuggestions = suggestionSnippets;
		this.lastTargetLines = response.target_lines;
		client._setTargetLines(targetEditor);
		this._updateSuggestPanel(suggestionSnippets.join(""));
		// todo: notify the change
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

	_createDecoration(context: vscode.ExtensionContext){
		const theme = vscode.workspace.getConfiguration().get('workbench.colorTheme');
		const isLight = (typeof theme === "string") ? theme.toLowerCase().includes('light') : false;
		const icon = isLight ? "images/pencil-light.svg" : "images/pencil-dark.svg";
		const rulerColor = isLight ? "#d6d6d6" : "white";

		return vscode.window.createTextEditorDecorationType({
			gutterIconPath: context.asAbsolutePath(icon),
			overviewRulerColor: rulerColor,
			gutterIconSize: "contain",
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			overviewRulerLane: vscode.OverviewRulerLane.Right,
		});
	}

	_addDecorationToEditor(editor: vscode.TextEditor | undefined) {
		if (!editor) {
			return;
		}
		if (editor.document.uri === this.lastTargetUri) {
			this._setTargetLines(editor);
		}
	}


	_getTargetlines(editor: vscode.TextEditor, tryReuseTargets: boolean): number | number[] | ErrorMsg {
		if (editor.document.languageId !== "python") {
			return "Coeditor can only be run on Python files";
		}
		if (!editor.selections) {
			return "Current editor has no selection";
		}

		// try reuse targets if current selection is inside the last target
		if (tryReuseTargets && this.lastTargetUri === editor.document.uri && this.lastTargetLines) {
			const line = editor.selection.start.line;
			if (this.lastTargetLines.includes(line)) {
				return this.lastTargetLines;
			}
		}

		const lineBegin = editor.selection.start.line + 1;
		const lineEnd = editor.selection.end.line + 1;
		if (lineBegin !== lineEnd) {
			return Array.from(
				{ length: lineEnd - lineBegin + 1 }, (_, i) => i + lineBegin
			);
		} else {
			return lineBegin;
		}
	}

	_updateSuggestPanel(content: string) {
		this.virtualFiles[suggestionFilePath] = content;
		const suggestionUri = vscode.Uri.from({ scheme: SCHEME, path: suggestionFilePath });
		this.fileChangeEmitter.fire(suggestionUri);
		return suggestionUri;
	}


	_setTargetLines(editor: vscode.TextEditor) {
		if (this.lastTargetLines === undefined) {
			this.channel.appendLine("Clearing decorations.");
			editor.setDecorations(this.targetDecoration, []);
			return;
		}
		
		editor.setDecorations(this.targetDecoration, this.lastTargetLines.map((line) => {
			const start = new vscode.Position(line - 1, 0);
			const end = new vscode.Position(line - 1, 0);
			return new vscode.Range(start, end);
		}));
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