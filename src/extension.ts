/* eslint-disable @typescript-eslint/naming-convention */

// The UI front-end for the coeditor extension.
import * as vscode from 'vscode';
const axios = require('axios').default;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
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
			'coeditor.suggestEditsAgain',
			coeditorClient.suggestEditsAgain,
			coeditorClient
		),
		vscode.commands.registerCommand(
			"coeditor.viewSuggestions",
			coeditorClient.viewSuggestions,
			coeditorClient
		),
		vscode.commands.registerCommand(
			'coeditor.applySuggestion',
			coeditorClient.applySuggestion,
			coeditorClient
		),
		vscode.commands.registerCommand(
			'coeditor.applySuggestionAndClose',
			coeditorClient.applySuggestionAndClose,
			coeditorClient
		),
	];
	context.subscriptions.push(...disposables);
}

// This method is called when your extension is deactivated
export function deactivate() { }

const SCHEME = "coeditor";
const suggestionFilePath = "/CoeditorSuggestions";
const suggestionUri = vscode.Uri.from({ scheme: SCHEME, path: suggestionFilePath });
type ErrorMsg = string;


class CoeditorClient {
	virtualFiles: { [name: string]: string; } = {};
	fileChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	codeLensEmitter: vscode.EventEmitter<void>;
	channel: vscode.OutputChannel;

	counter: number = 0;
	initialized: string[] = [];
	inputDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
	outputDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
	lastResponse: ServerResponse | undefined = undefined;
	lastSuggestions: string[] = [];
	lastTargetUri: vscode.Uri | undefined = undefined;
	lastTargetLines: number[] | number | undefined = undefined;
	inputStatus: [number, string][] | undefined = undefined;
	outputStatus: [number, string][] | undefined = undefined;

	async suggestEditsAgain() {
		await this.suggestEdits(true);
	}

	async suggestEditsForSelection() {
		await this.suggestEdits(false);
	}

	async applySuggestionAndClose(index?: number) {
		await this.applySuggestion(index);
		vscode.window.visibleTextEditors.forEach(async (editor) => {
			const uri = editor.document.uri;
			if (uri.scheme === suggestionUri.scheme && uri.fsPath === suggestionUri.fsPath) {
				await vscode.window.showTextDocument(editor.document, editor.viewColumn);
				await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			}
		});
	}

	constructor(context: vscode.ExtensionContext) {
		if (axios === undefined) {
			throw new Error('axios is undefined');
		}
		this.channel = vscode.window.createOutputChannel("Coeditor");
		const client = this;
		const codeLensEmitter = new vscode.EventEmitter<void>();
		const codeLensProvider: vscode.CodeLensProvider = {
			onDidChangeCodeLenses: codeLensEmitter.event,

			provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
				if (document.uri === client.lastTargetUri && client.inputStatus) {
					if (client.lastResponse === undefined) {
						return [];
					}
					// add code lenses for changed lines
					const suggestion = client.lastResponse.suggestions[0];
					let lastLine = -100;
					return suggestion.input_status.flatMap((lineTag) => {
						const [line, tag] = lineTag;
						if(tag === " "){
							return [];
						}
						if (line === lastLine + 1) {
							// skip lens for consecutive lines
							lastLine = line;
							return [];
						}
						const start = new vscode.Position(line-1, 0);
						const startRange = new vscode.Range(start, start);
						lastLine = line;
						return [
							new vscode.CodeLens(startRange, {
								title: 'View changes',
								command: 'coeditor.viewSuggestions'
							})
						];
					});
				} else if (document.uri.scheme === SCHEME && document.uri.fsPath === suggestionFilePath) {
					// add a code lens for each suggestion
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
				} else {
					return [];
				}
			}
		};
		this.codeLensEmitter = codeLensEmitter;

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
			if (!client._suggestPanelVisible(editors)) {
				client.inputStatus = undefined;
				client.lastTargetLines = undefined;
				client.codeLensEmitter.fire();
				const targetEditor = editors.find(e => e.document.uri === client.lastTargetUri);
				if (targetEditor) {
					client._setLineStatus(targetEditor);
				}
			}
		}, client, context.subscriptions);

		// optionally suggestEdits on file save
		vscode.workspace.onDidSaveTextDocument(doc => {
			const editor = vscode.window.activeTextEditor;
			if (
				client._suggestPanelVisible()
				&& editor
				&& editor.document.uri === doc.uri
				&& editor.document.languageId === "python"
				&& vscode.workspace.getConfiguration().get('coeditor.rerunOnSave')
			) {
				client.suggestEdits(true, false);
			} else if (
				editor 
				&& editor.document.uri === doc.uri
				&& editor.document.languageId === "python"
				&& vscode.workspace.getConfiguration().get('coeditor.backgroundRunOnSave')
			) {
				client.suggestEdits(true, true);
			}
		}, client, context.subscriptions);

		this.channel.appendLine("Coeditor client initialized.");
	}

	_suggestPanelVisible(editors?: readonly vscode.TextEditor[]) {
		if (editors === undefined) {
			editors = vscode.window.visibleTextEditors;
		}
		return editors.some(e => e.document.uri.scheme === SCHEME && e.document.uri.fsPath === suggestionFilePath);
	}


	async suggestEdits(reuseTargets: boolean, backgroundRun: boolean = false) {
		const client = this;
		function show_error(msg: string) {
			const toDisplay = "[error] " + msg;
			client.channel.appendLine(toDisplay);
			if (!backgroundRun) {
				vscode.window.showErrorMessage(msg);
				client._updateSuggestPanel(toDisplay);
			}
		}

		try {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { throw new Error("No active editor"); }

			const targetUri = editor.document.uri;
			const targetEditor = editor;
			this.lastTargetUri = targetUri;

			const targetLines = this._getTargetlines(editor, reuseTargets);
			if (typeof targetLines === "string") {
				throw new Error(targetLines);
			}
			if (typeof targetLines === "number") {
				this.inputStatus = [[targetLines, "?"]];
			} else {
				this.inputStatus = targetLines.map(i => [i, "?"]);
			}
			client._setLineStatus(targetEditor);
			this.lastTargetLines = targetLines;

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
			const writeLogs = config.get<boolean>("coeditor.writeLogs");
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

			this.inputStatus = linesP.map(i => [i, "?"]);
			this._setLineStatus(targetEditor);

			const prompt = `Suggesting edits for '${relPath}' (${targetDesc})...`;
			this.outputStatus = undefined;
			this.channel.appendLine(prompt);
			this._updateSuggestPanel(prompt);

			const response: ServerResponse = await requestServer(
				"get_result",
				{ "time": Date.now(), "project": projectPath },
				timeout,
			);

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
			this.inputStatus = response.suggestions[0].input_status;
			this.outputStatus = response.suggestions[0].output_status.map(([i, tag]) => [i + 2, tag]);
			client._setLineStatus(targetEditor);
			this._updateSuggestPanel(suggestionSnippets.join(""));
			if (!backgroundRun) {
				this.viewSuggestions();
			}
			client.codeLensEmitter.fire();
		} catch (e: any) {
			show_error(
				"Coeditor failed with error: " + e.message
			);
			this.lastTargetLines = undefined;
			this.inputStatus = undefined;
			this.outputStatus = undefined;
			client._setLineStatus(vscode.window.activeTextEditor);
			return;
		}
	}

	async viewSuggestions() {
		const editor = vscode.window.activeTextEditor;
		let viewColumn = vscode.ViewColumn.One;
		if (editor) {
			viewColumn = editor.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
		}
		const panelDoc = await vscode.workspace.openTextDocument(suggestionUri);
		vscode.window.showTextDocument(
			panelDoc, { preserveFocus: true, preview: true, viewColumn: viewColumn }
		).then((editor) => this._setLineStatus(editor));
	}


	async applySuggestion(index?: number) {
		if (this.lastResponse === undefined) {
			vscode.window.showErrorMessage('No suggestions to apply.');
			return;
		}
		if (index === undefined) {
			index = 0;
		}
		const uri = vscode.Uri.file(this.lastResponse.target_file);

		let editor: vscode.TextEditor;
		if (vscode.window.activeTextEditor?.document.uri.fsPath === uri.fsPath) {
			editor = vscode.window.activeTextEditor;
		} else {
			const viewColumn = vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
			const doc = await vscode.workspace.openTextDocument(uri);
			editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, viewColumn: viewColumn });
		}

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
		const iconMap = {
			"?": isLight ? "images/question-dark.png" : "images/question-white.png",
			" ": isLight ? "images/pencil-dark.png" : "images/pencil-white.png",
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


	_getTargetlines(editor: vscode.TextEditor, reuseTargets: boolean): number | number[] | ErrorMsg {
		if (editor.document.languageId !== "python") {
			return "Coeditor can only be run on Python files";
		}

		// try reuse targets if current selection is inside the last target
		if (reuseTargets && this.lastTargetUri === editor.document.uri && this.lastTargetLines && this.inputStatus) {
			if (!editor.selections) {
				return this.lastTargetLines;
			}
			const line = editor.selection.start.line;
			const lastLines = this.inputStatus.map(x => x[0]);
			if (lastLines.includes(line)) {
				return this.lastTargetLines;
			}
		}

		if (!editor.selections) {
			return "Current editor has no selection";
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
				this.channel.appendLine("Unknown tag: " + tag);
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
	let res;
	if (timeout === undefined) {
		res = await task;
	} else {
		const timer = new Promise((resolve, reject) => {
			setTimeout(() => reject(new Error(`Server timed out for request: ${JSON.stringify(request)}`)), timeout);
		});
		res = await Promise.race([task, timer]);
	}
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