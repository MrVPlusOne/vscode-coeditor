/* eslint-disable @typescript-eslint/naming-convention */

// The UI front-end for the coeditor extension.
import * as vscode from 'vscode';
const axios = require('axios').default;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	// const axios = await require('axios').default;
	const coeditorClient = new CoeditorClient(context);

	vscode.workspace.workspaceFolders?.forEach(folder => {
		requestServer("initialize", { "project": folder.uri.fsPath });
	});

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

	counter: number = 0;
	initialized: string[] = [];
	inputDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
	outputDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
	lastResponse: ServerResponse | undefined = undefined;
	lastSuggestions: string[] = [];
	lastTargetUri: vscode.Uri | undefined = undefined;
	inputStatus: [number, string][] | undefined = undefined;
	outputStatus: [number, string][] | undefined = undefined;

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
				const actions = client.lastSuggestions.flatMap((snippet, i) => {
					const start = document.positionAt(offset);
					const startRange = new vscode.Range(start, start);
					offset += snippet.length;
					const end = document.positionAt(offset - 2);
					const endRange = new vscode.Range(end, end);
					return [
						new vscode.CodeLens(startRange, {
							title: 'Apply suggestion',
							command: 'coeditor.applySuggestion',
							arguments: [i]
						}),
						new vscode.CodeLens(endRange, {
							title: 'Apply above suggestion',
							command: 'coeditor.applySuggestion',
							arguments: [i]
						})
					];
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

		this._recreateDecorations(context);

		// update decorations on theme change
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('workbench.colorTheme')) {
				// get color theme
				this._recreateDecorations(context);
				const editor = vscode.window.activeTextEditor;
				client._setLineStatus(editor);
			}
		}));

		// add decorations to active editor
		vscode.window.onDidChangeActiveTextEditor(editor => {
			client._setLineStatus(editor);
		}, client, context.subscriptions);

		// remove target lines when suggestion panel is not visible
		// ideally we want to do this when the panel is closed, but there is no reliable 
		// event for that at the moment
		vscode.window.onDidChangeVisibleTextEditors(editors => {
			const suggestPanelVisible = editors.some(e => e.document.uri.scheme === SCHEME && e.document.uri.fsPath === suggestionFilePath);
			if (!suggestPanelVisible) {
				client.inputStatus = undefined;
				const targetEditor = editors.find(e => e.document.uri === client.lastTargetUri);
				if (targetEditor) {
					client._setLineStatus(targetEditor);
				}
			}
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
			const tag = silentFail ? "[silent error]" : "[error]";
			const toDisplay = tag + " " + msg;
			client.channel.appendLine(toDisplay);
			client._updateSuggestPanel(toDisplay);
		}

		try {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { throw new Error("No active editor"); }

			const targetUri = editor.document.uri;
			const targetEditor = editor;
			this.lastTargetUri = targetUri;

			const targetLines = this._getTargetlines(editor, tryReuseTargets);
			if (typeof targetLines === "string") {
				throw new Error(targetLines);
			}
			if (typeof targetLines === "number") {
				this.inputStatus = [[targetLines, " "]];
			} else {
				this.inputStatus = targetLines.map(i => [i, " "]);
			}
			client._setLineStatus(targetEditor);

			const viewColumn = targetEditor.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
			// check the type of targetLines
			const targetDesc = (
				(typeof targetLines === 'number') ?
					`at line ${targetLines}` :
					`for line ${targetLines[0]}--${targetLines[targetLines.length - 1]}`
			);

			const project = vscode.workspace.getWorkspaceFolder(targetUri);
			if (project === undefined) {
				throw new Error("Unable to determine the project folder for the active editor.");
			}
			const projectPath = project.uri.fsPath;

			const filePath = targetUri.fsPath;
			const relPath = vscode.workspace.asRelativePath(filePath);

			if (targetEditor.document.isDirty) {
				const saved = await targetEditor.document.save();
				if (!saved) {
					throw new Error("Unable to proceed: failed to save the active editor.");
				}
			}

			const config = vscode.workspace.getConfiguration();
			const writeLogs = config.get("coeditor.writeLogs");
			const id = client.counter;
			client.counter += 1;

			let timeout = config.get<number>("coeditor.requestTimeout", 10);
			timeout *= 1000;

			const linesP: number[] | string = await requestServer(
				"submit_problem", {
				"time": Date.now(),
				"project": projectPath,
				"file": relPath,
				"lines": targetLines,
				"writeLogs": writeLogs,
			}, timeout);
			if (typeof linesP === "string") {
				return;
			}

			this.inputStatus = linesP.map(i => [i, " "]);
			client._setLineStatus(targetEditor);

			const prompt = `Suggesting edits for '${relPath}' (${targetDesc})...`;
			const panelUri = this._updateSuggestPanel(prompt);
			const panelDoc = await vscode.workspace.openTextDocument(panelUri);
			// open a new document asynchronously
			this.outputStatus = undefined;
			vscode.window.showTextDocument(
				panelDoc, { preserveFocus: true, preview: true, viewColumn: viewColumn }
			).then((editor) => client._setLineStatus(editor));

			const response: ServerResponse | string = await requestServer(
				"get_result",
				{ "time": Date.now(), "project": projectPath },
				timeout,
			);
			if (typeof response === "string") {
				return;
			}
			const res_to_show = {
				server_response: {
					target_file: response.target_file,
					edit_start: response.edit_start,
					edit_end: response.edit_end,
					target_lines: response.target_lines,
					outputStatus: response.suggestions ? response.suggestions[0].output_status : undefined,
				}
			};
			console.log(res_to_show);
			this.channel.appendLine(JSON.stringify(res_to_show));
			const suggestionSnippets = response.suggestions.map((suggestion) => {
				return `================= Score: ${suggestion.score.toPrecision(3)} =================\n${suggestion.change_preview}\n\n`;
			});
			this.lastResponse = response;
			this.lastSuggestions = suggestionSnippets;
			if (this.inputStatus !== undefined) {
				// if the suggestion panel was not closed
				this.inputStatus = response.suggestions[0].input_status;
				this.outputStatus = response.suggestions[0].output_status.map(([i, tag]) => [i + 2, tag]);
				client._setLineStatus(targetEditor);
				this._updateSuggestPanel(suggestionSnippets.join(""));
			}
		} catch (e: any) {
			show_error(
				"Coeditor failed with error: " + e.message
			);
			this.inputStatus = undefined;
			this.outputStatus = undefined;
			client._setLineStatus(vscode.window.activeTextEditor);
			return;
		}
	}

	async applyTopSuggestion() {
		await this.applySuggestion(0);
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
		this._setLineStatus(editor);
	}

	_recreateDecorations(context: vscode.ExtensionContext) {
		this.inputDecorations.forEach(dec => dec.dispose());
		this.outputDecorations.forEach(dec => dec.dispose());

		this.inputDecorations = this._createInputDecorations(context);
		this.outputDecorations = this._createOutputDecorations(context);
	}

	_createInputDecorations(context: vscode.ExtensionContext) {
		const theme = vscode.workspace.getConfiguration().get('workbench.colorTheme');
		const isLight = (typeof theme === "string") ? theme.toLowerCase().includes('light') : false;
		const rulerColor = isLight ? "#d6d6d6" : "white";
		const iconDefault = isLight ? "images/pencil-light.png" : "images/pencil-dark.png";
		const iconMap = {
			" ": iconDefault,
			"R": "images/pencil-blue.png",
			"A": "images/pencil-green.png",
			"D": "images/pencil-red.png",
		};

		const result = new Map<string, vscode.TextEditorDecorationType>();
		Object.entries(iconMap).forEach(([tag, path]) => {
			result.set(tag, vscode.window.createTextEditorDecorationType({
				gutterIconPath: context.asAbsolutePath(path),
				overviewRulerColor: rulerColor,
				gutterIconSize: "contain",
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
				overviewRulerLane: vscode.OverviewRulerLane.Right,
			}));
		});

		return result;
	}

	_createOutputDecorations(context: vscode.ExtensionContext) {
		const theme = vscode.workspace.getConfiguration().get('workbench.colorTheme');

		const colorMap = {
			" ": "rgba(0, 0, 0, 0.0)",
			"RD": "rgba(6, 184, 250, 0.06)",
			"RA": "rgba(6, 184, 250, 0.15)",
			"A": "rgba(119, 187, 65, 0.15)",
			"D": "rgba(255, 98, 81, 0.15)",
		};

		const result = new Map<string, vscode.TextEditorDecorationType>();
		Object.entries(colorMap).forEach(([tag, color]) => {
			result.set(tag, vscode.window.createTextEditorDecorationType({
				backgroundColor: color,
				isWholeLine: true,
				// rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			}));
		});

		return result;
	}


	_getTargetlines(editor: vscode.TextEditor, tryReuseTargets: boolean): number | number[] | ErrorMsg {
		if (editor.document.languageId !== "python") {
			return "Coeditor can only be run on Python files";
		}
		if (!editor.selections) {
			return "Current editor has no selection";
		}

		// try reuse targets if current selection is inside the last target
		if (tryReuseTargets && this.lastTargetUri === editor.document.uri && this.inputStatus) {
			const line = editor.selection.start.line;
			const lastLines = this.inputStatus.map(x => x[0]);
			if (lastLines.includes(line)) {
				return lastLines;
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


	_setLineStatus(editor: vscode.TextEditor | undefined) {
		if (!editor) {
			return;
		}
		const uri = editor.document.uri;
		const isOutput = uri.scheme === SCHEME && uri.path === suggestionFilePath;
		const isInput = editor.document.uri === this.lastTargetUri;
		if (!isInput && !isOutput) {
			return;
		}
		const status = isInput ? this.inputStatus : this.outputStatus;
		const decorations = isInput ? this.inputDecorations : this.outputDecorations;
		decorations.forEach((decoration) => {
			editor.setDecorations(decoration, []);
		});
		if (status === undefined) {
			return;
		}
		const tag2lines = new Map<string, number[]>();
		status.forEach(([line, tag]) => {
			const ls = tag2lines.get(tag) || [];
			tag2lines.set(tag, ls);
			ls.push(line);
		});

		tag2lines.forEach((lines, tag) => {
			const dec = decorations.get(tag);
			if (!dec) {
				console.log("Unknown tag: " + tag);
				return;
			}
			editor.setDecorations(dec, lines.map((line) => {
				const start = new vscode.Position(line - 1, 0);
				const end = new vscode.Position(line - 1, 0);
				return new vscode.Range(start, end);
			}));
		});
	}
}

function prettyPrintRange(range: vscode.Range) {
	return `(${range.start.line + 1}:${range.start.character})-(${range.end.line + 1}:${range.end.character})`;
}

async function requestServer(method: string, params: any, timeout?: number) {
	const request = {
		"jsonrpc": "2.0",
		"method": method,
		"params": params,
		"id": 1,
	};

	const serverLink = vscode.workspace.getConfiguration().get("coeditor.serverURL");
	const task = axios.post(serverLink, request);
	const timer = new Promise((resolve, reject) => {
		setTimeout(() => reject(new Error("Server response timed out.")), timeout);
	});
	const res = await Promise.race([task, timer]);
	if (res.data.error !== undefined) {
		throw new Error(res.data.error.message);
	}
	return res.data.result;
}

/* eslint-disable @typescript-eslint/naming-convention */

interface EditSuggestion {
	score: number;
	change_preview: string;
	new_code: string;
	input_status: Array<[number, string]>;
	output_status: Array<[number, string]>;
}

interface ServerResponse {
	target_file: string;
	edit_start: number[];
	edit_end: number[];
	old_code: string;
	suggestions: EditSuggestion[];
	target_lines: number[];
}