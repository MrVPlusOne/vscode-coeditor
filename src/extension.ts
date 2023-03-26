/* eslint-disable @typescript-eslint/naming-convention */

// The UI front-end for the coeditor extension.
import * as vscode from 'vscode';
const axios = require('axios').default;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    const coeditorClient = new CoeditorClient(context);

    vscode.workspace.workspaceFolders?.forEach((folder) => {
        requestServer('initialize', { project: folder.uri.fsPath });
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
            'coeditor.viewSuggestions',
            coeditorClient.viewSuggestions,
            coeditorClient
        ),
        vscode.commands.registerCommand(
            'coeditor.applySuggestionAndSave',
            coeditorClient.applySuggestionAndSave,
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
export function deactivate() {}

const SCHEME = 'coeditor';
const suggestionFilePath = '/CoeditorSuggestions';
const suggestionUri = vscode.Uri.from({
    scheme: SCHEME,
    path: suggestionFilePath,
});
type ErrorMsg = string;

class CoeditorClient {
    virtualFiles: { [name: string]: string } = {};
    fileChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    codeLensEmitter: vscode.EventEmitter<void>;
    channel: vscode.OutputChannel;

    counter: number = 0;
    initialized: string[] = [];
    inputDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
    outputDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
    lastResponse: ServerResponse | undefined = undefined;
    lastSuggestionSnippet: string = '';
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
    
    async applySuggestionAndSave(change_i?: number) {
        const editor = await this._applySuggestion(change_i);
        if (editor && editor.document.isDirty) {
            await editor.document.save();
        }
    }

    async applySuggestionAndClose(change_i?: number) {
        const editor = await this._applySuggestion(change_i);
        vscode.window.visibleTextEditors.forEach(async (editor) => {
            const uri = editor.document.uri;
            if (
                uri.scheme === suggestionUri.scheme &&
                uri.fsPath === suggestionUri.fsPath
            ) {
                await vscode.window.showTextDocument(editor.document, editor.viewColumn);
                await vscode.commands.executeCommand(
                    'workbench.action.closeActiveEditor'
                );
            }
        });
        if (editor && editor.document.isDirty) {
            await editor.document.save();
        }
    }

    constructor(context: vscode.ExtensionContext) {
        if (axios === undefined) {
            throw new Error('axios is undefined');
        }
        this.channel = vscode.window.createOutputChannel('Coeditor');
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
                    return suggestion.changes.flatMap((change, i) => {
                        const start = new vscode.Position(change.start - 1, 0);
                        const until = new vscode.Position(change.until - 1, 0);
                        const lensRange = new vscode.Range(start, until);
                        return [
                            new vscode.CodeLens(lensRange, {
                                title: 'View changes',
                                command: 'coeditor.viewSuggestions',
                            }),
                            new vscode.CodeLens(lensRange, {
                                title: 'Apply change',
                                command: 'coeditor.applySuggestionAndSave',
                                arguments: [i],
                            }),
                        ];
                    });
                } else if (
                    document.uri.scheme === SCHEME &&
                    document.uri.fsPath === suggestionFilePath
                ) {
                    // add a code lens for each suggestion
                    let offset = 0;
                    const start = document.positionAt(offset);
                    const startRange = new vscode.Range(start, start);
                    offset += client.lastSuggestionSnippet.length;
                    const end = document.positionAt(offset - 2);
                    const endRange = new vscode.Range(end, end);
                    return [
                        new vscode.CodeLens(startRange, {
                            title: 'Apply changes and close',
                            command: 'coeditor.applySuggestionAndClose',
                        }),
                        new vscode.CodeLens(endRange, {
                            title: 'Apply changes and close',
                            command: 'coeditor.applySuggestionAndClose',
                        }),
                    ];
                } else {
                    return [];
                }
            },
        };
        this.codeLensEmitter = codeLensEmitter;

        function wrapCode(code: string, codeType: string = '') {
            return '```' + codeType + '\n' + code + '```';
        }

        const hoverProvider: vscode.HoverProvider = {
            provideHover(
                document: vscode.TextDocument,
                position: vscode.Position,
                token: vscode.CancellationToken
            ) {
                if (document.uri === client.lastTargetUri && client.inputStatus) {
                    if (client.lastResponse === undefined) {
                        return undefined;
                    }
                    // add code lenses for changed lines
                    const suggestion = client.lastResponse.suggestions[0];
                    for (const change of suggestion.changes) {
                        if (
                            change.start - 1 <= position.line &&
                            position.line < Math.max(change.until, change.start + 1) - 1
                        ) {
                            const scoreStr = suggestion.score.toPrecision(3);
                            const preview = `Coeditor suggestion (score=${scoreStr}):\n${wrapCode(
                                change.old_str
                            )}\nchange to:\n\n${wrapCode(change.new_str)}`;
                            return new vscode.Hover(new vscode.MarkdownString(preview));
                        }
                    }
                    return undefined;
                }
            },
        };

        const contentProvider = new (class implements vscode.TextDocumentContentProvider {
            onDidChange = client.fileChangeEmitter.event;
            provideTextDocumentContent(uri: vscode.Uri): string {
                return client.virtualFiles[uri.path];
            }
        })();

        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
            vscode.languages.registerCodeLensProvider('*', codeLensProvider),
            vscode.languages.registerHoverProvider('*', hoverProvider)
        );

        this._recreateDecorations(context);

        // update decorations on theme change
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('workbench.colorTheme')) {
                    // get color theme
                    this._recreateDecorations(context);
                    client._setDecorators();
                }
            })
        );

        // add decorations to active editor
        vscode.window.onDidChangeActiveTextEditor(
            (editor) => {
                if (editor) {
                    client._setEditorDecorators(editor);
                }
            },
            client,
            context.subscriptions
        );

        // remove target lines when suggestion panel is not visible
        // ideally we want to do this when the panel is closed, but there is no reliable
        // event for that at the moment
        vscode.window.onDidChangeVisibleTextEditors(
            (editors) => {
                if (!client._suggestPanelVisible(editors)) {
                    client.inputStatus = undefined;
                    client.lastTargetLines = undefined;
                    client.codeLensEmitter.fire();
                    client._setDecorators();
                }
            },
            client,
            context.subscriptions
        );

        // optionally suggestEdits on file save
        vscode.workspace.onDidSaveTextDocument(
            (doc) => {
                const editor = vscode.window.activeTextEditor;
                if (
                    client._suggestPanelVisible() &&
                    editor &&
                    editor.document.uri === doc.uri &&
                    editor.document.languageId === 'python' &&
                    vscode.workspace.getConfiguration().get('coeditor.rerunOnSave')
                ) {
                    client.suggestEdits(true, false);
                } else if (
                    editor &&
                    editor.document.uri === doc.uri &&
                    editor.document.languageId === 'python' &&
                    vscode.workspace
                        .getConfiguration()
                        .get('coeditor.backgroundRunOnSave')
                ) {
                    client.suggestEdits(true, true);
                }
            },
            client,
            context.subscriptions
        );

        this.channel.appendLine('Coeditor client initialized.');
    }

    _suggestPanelVisible(editors?: readonly vscode.TextEditor[]) {
        if (editors === undefined) {
            editors = vscode.window.visibleTextEditors;
        }
        return editors.some(
            (e) =>
                e.document.uri.scheme === SCHEME &&
                e.document.uri.fsPath === suggestionFilePath
        );
    }

    async suggestEdits(
        reuseTargets: boolean,
        backgroundRun: boolean = false,
        editor?: vscode.TextEditor
    ) {
        const client = this;
        function show_error(msg: string) {
            const toDisplay = '[error] ' + msg;
            client.channel.appendLine(toDisplay);
            if (!backgroundRun) {
                vscode.window.showErrorMessage(msg);
                client._updateSuggestPanel(toDisplay);
            }
        }

        try {
            if (editor === undefined) {
                editor = vscode.window.activeTextEditor;
            }
            if (!editor) {
                throw new Error('No active editor');
            }

            const targetUri = editor.document.uri;
            const targetEditor = editor;
            this.lastTargetUri = targetUri;

            const targetLines = this._getTargetlines(editor, reuseTargets);
            if (typeof targetLines === 'string') {
                throw new Error(targetLines);
            }
            if (typeof targetLines === 'number') {
                this.inputStatus = [[targetLines, '?']];
            } else {
                this.inputStatus = targetLines.map((i) => [i, '?']);
            }
            this._setDecorators();
            this.lastTargetLines = targetLines;

            const targetDesc =
                typeof targetLines === 'number'
                    ? `at line ${targetLines}`
                    : `for line ${targetLines[0]}--${
                          targetLines[targetLines.length - 1]
                      }`;

            const project = vscode.workspace.getWorkspaceFolder(targetUri);
            if (project === undefined) {
                throw new Error(
                    'Unable to determine the project folder for the target editor.'
                );
            }
            const projectPath = project.uri.fsPath;

            const filePath = targetUri.fsPath;
            const relPath = vscode.workspace.asRelativePath(filePath);

            if (targetEditor.document.isDirty) {
                const saved = await targetEditor.document.save();
                if (!saved) {
                    throw new Error(
                        'Unable to proceed: failed to save the target editor.'
                    );
                }
            }

            // submit problem to server
            const config = vscode.workspace.getConfiguration();
            const writeLogs = config.get<boolean>('coeditor.writeLogs');
            client.counter += 1;

            let timeout = config.get<number>('coeditor.requestTimeout', 10);
            timeout *= 1000;

            const linesP: number[] | string = await requestServer(
                'submit_problem',
                {
                    time: Date.now(),
                    project: projectPath,
                    file: relPath,
                    lines: targetLines,
                    writeLogs: writeLogs,
                },
                timeout
            );
            if (typeof linesP === 'string') {
                return;
            }

            this.inputStatus = linesP.map((i) => [i, '?']);
            this.outputStatus = undefined;

            const prompt = `Suggesting edits for '${relPath}' (${targetDesc})...`;
            this.outputStatus = undefined;
            this.channel.appendLine(prompt);
            this._updateSuggestPanel(prompt);
            this._setDecorators();

            // request server to proceed
            const response: ServerResponse = await requestServer(
                'get_result',
                { time: Date.now(), project: projectPath },
                timeout
            );

            const res_to_show = {
                server_response: {
                    target_file: response.target_file,
                    edit_start: response.edit_start,
                    edit_end: response.edit_end,
                    target_lines: response.target_lines,
                    outputStatus: response.suggestions
                        ? response.suggestions[0].output_status
                        : undefined,
                    changes: response.suggestions[0].changes,
                },
            };
            console.log(res_to_show);
            this.channel.appendLine(JSON.stringify(res_to_show));

            const suggestion = response.suggestions[0];
            const score_threshold = config.get<number>('coeditor.scoreThreshold', 0.2);
            if (backgroundRun && suggestion.score < score_threshold) {
                // discard the suggestions due to low score
                suggestion.changes = [];
                const clear = ([i, tag]: [number, string]): [number, string] => [i, ' '];
                suggestion.input_status = suggestion.input_status.map(clear);
                suggestion.output_status = suggestion.output_status.map(clear);
            }
            const confTag = suggestion.score < score_threshold ? '(Low Confidence) ' : '';
            const suggestionSnippet =
                `================= ${confTag}Score: ` +
                suggestion.score.toPrecision(3) +
                ' =================\n' +
                suggestion.change_preview +
                '\n\n';
            this.lastResponse = response;
            this.lastSuggestionSnippet = suggestionSnippet;
            this.inputStatus = response.suggestions[0].input_status;
            this.outputStatus = response.suggestions[0].output_status.map(([i, tag]) => [
                i + 2,
                tag,
            ]);
            this._updateSuggestPanel(suggestionSnippet);
            client._setDecorators();
            if (!backgroundRun) {
                await this.viewSuggestions(editor);
            }
            client.codeLensEmitter.fire();
            this._setDecorators();
        } catch (e: any) {
            show_error('Coeditor failed with error: ' + e.message);
            this.lastTargetLines = undefined;
            this.inputStatus = undefined;
            this.outputStatus = undefined;
            client._setDecorators();
            return;
        }
    }

    /**
     * @param avoidEditor Which editor whose ViewColumn the suggestion panel should
     * avoid using. Default to the active editor.
     */
    async viewSuggestions(avoidEditor?: vscode.TextEditor) {
        if (avoidEditor === undefined) {
            avoidEditor = vscode.window.activeTextEditor;
        }
        let viewColumn = vscode.ViewColumn.One;
        if (avoidEditor) {
            viewColumn =
                avoidEditor.viewColumn === vscode.ViewColumn.One
                    ? vscode.ViewColumn.Two
                    : vscode.ViewColumn.One;
        }
        const panelDoc = await vscode.workspace.openTextDocument(suggestionUri);
        vscode.window
            .showTextDocument(panelDoc, {
                preserveFocus: true,
                preview: true,
                viewColumn: viewColumn,
            })
            .then((editor) => this._setDecorators());
    }

    /**
     * Apply the model suggestions to the target file, open an editor if necessary.
     * Then return the target editor.
     * @param change_i within the suggestion, which subchange to apply. If undefined,
     * all suggested changes are applied.
     */
    async _applySuggestion(change_i?: number) {
        if (this.lastResponse === undefined) {
            vscode.window.showErrorMessage('No suggestions to apply.');
            return;
        }
        const uri = vscode.Uri.file(this.lastResponse.target_file);

        let editor: vscode.TextEditor;
        if (vscode.window.activeTextEditor?.document.uri.fsPath === uri.fsPath) {
            editor = vscode.window.activeTextEditor;
        } else {
            const viewColumn =
                vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.One
                    ? vscode.ViewColumn.Two
                    : vscode.ViewColumn.One;
            const doc = await vscode.workspace.openTextDocument(uri);
            editor = await vscode.window.showTextDocument(doc, {
                preserveFocus: true,
                viewColumn: viewColumn,
            });
        }

        const suggestion = this.lastResponse.suggestions[0];
        let changes: LineChange[];
        if (change_i === undefined) {
            changes = suggestion.changes;
        } else {
            changes = [suggestion.changes[change_i]];
        }
        await this._applyChanges(editor, changes);
        this._setDecorators();
        return editor;
    }

    async _applyChanges(editor: vscode.TextEditor, changes: LineChange[]) {
        await editor.edit((editBuilder) => {
            changes.forEach((change) => {
                const start = new vscode.Position(change.start - 1, 0);
                const end = new vscode.Position(change.until - 1, 0);
                const range = new vscode.Range(start, end);
                const current = editor.document.getText(range);
                if (current !== change.old_str) {
                    vscode.window.showWarningMessage(
                        `The code to be replaced at range ${prettyPrintRange(
                            range
                        )} has changed. The applied edit may no longer be valid.`
                    );
                    this.channel.appendLine(
                        `The code to be replaced at range ${prettyPrintRange(
                            range
                        )} has changed.\nCurrent code: ${current}<END>, expected code: ${
                            change.old_str
                        }<END>`
                    );
                }
                editBuilder.replace(range, change.new_str);
            });
        });
    }

    _recreateDecorations(context: vscode.ExtensionContext) {
        this.inputDecorations.forEach((dec) => dec.dispose());
        this.outputDecorations.forEach((dec) => dec.dispose());

        this.inputDecorations = this._createInputDecorations(context);
        this.outputDecorations = this._createOutputDecorations(context);
    }

    _createInputDecorations(context: vscode.ExtensionContext) {
        const theme = vscode.workspace.getConfiguration().get('workbench.colorTheme');
        const isLight =
            typeof theme === 'string' ? theme.toLowerCase().includes('light') : false;
        const rulerColor = isLight ? '#d6d6d6' : 'white';
        const iconMap = {
            '?': isLight ? 'images/question-dark.png' : 'images/question-white.png',
            ' ': isLight ? 'images/circle-dark.png' : 'images/circle-white.png',
            R: 'images/circle-blue.png',
            A: 'images/circle-green.png',
            D: 'images/circle-red.png',
        };

        const result = new Map<string, vscode.TextEditorDecorationType>();
        Object.entries(iconMap).forEach(([tag, path]) => {
            result.set(
                tag,
                vscode.window.createTextEditorDecorationType({
                    gutterIconPath: context.asAbsolutePath(path),
                    overviewRulerColor: rulerColor,
                    gutterIconSize: '80%',
                    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
                    overviewRulerLane: vscode.OverviewRulerLane.Right,
                })
            );
        });

        return result;
    }

    _createOutputDecorations(context: vscode.ExtensionContext) {
        const theme = vscode.workspace.getConfiguration().get('workbench.colorTheme');

        const colorMap = {
            ' ': 'rgba(0, 0, 0, 0.0)',
            RD: 'rgba(6, 184, 250, 0.06)',
            RA: 'rgba(6, 184, 250, 0.15)',
            A: 'rgba(119, 187, 65, 0.15)',
            D: 'rgba(255, 98, 81, 0.15)',
        };

        const result = new Map<string, vscode.TextEditorDecorationType>();
        Object.entries(colorMap).forEach(([tag, color]) => {
            result.set(
                tag,
                vscode.window.createTextEditorDecorationType({
                    backgroundColor: color,
                    isWholeLine: true,
                    // rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
                })
            );
        });

        return result;
    }

    _getTargetlines(
        editor: vscode.TextEditor,
        reuseTargets: boolean
    ): number | number[] | ErrorMsg {
        if (editor.document.languageId !== 'python') {
            return 'Coeditor can only be run on Python files';
        }

        // try reuse targets if current selection is inside the last target
        if (
            reuseTargets &&
            this.lastTargetUri === editor.document.uri &&
            this.lastTargetLines &&
            this.inputStatus
        ) {
            if (!editor.selections) {
                return this.lastTargetLines;
            }
            const line = editor.selection.start.line;
            const lastLines = this.inputStatus.map((x) => x[0]);
            if (lastLines.includes(line)) {
                return this.lastTargetLines;
            }
        }

        if (!editor.selections) {
            return 'Current editor has no selection';
        }

        const lineBegin = editor.selection.start.line + 1;
        const lineEnd = editor.selection.end.line + 1;
        if (lineBegin !== lineEnd) {
            return Array.from(
                { length: lineEnd - lineBegin + 1 },
                (_, i) => i + lineBegin
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

    _setDecorators() {
        for (const editor of vscode.window.visibleTextEditors) {
            this._setEditorDecorators(editor);
        }
        if (vscode.window.activeTextEditor) {
            this._setEditorDecorators(vscode.window.activeTextEditor);
        }
    }

    _setEditorDecorators(editor: vscode.TextEditor) {
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
                this.channel.appendLine('Unknown tag: ' + tag);
                return;
            }
            editor.setDecorations(
                dec,
                lines.map((line) => {
                    const start = new vscode.Position(line - 1, 0);
                    const end = new vscode.Position(line - 1, 0);
                    return new vscode.Range(start, end);
                })
            );
        });
    }
}

function prettyPrintRange(range: vscode.Range) {
    return `(${range.start.line + 1}:${range.start.character})-(${range.end.line + 1}:${
        range.end.character
    })`;
}

async function requestServer(method: string, params: any, timeout?: number) {
    const request = {
        jsonrpc: '2.0',
        method: method,
        params: params,
        id: 1,
    };

    const serverLink = vscode.workspace.getConfiguration().get('coeditor.serverURL');
    const task = axios.post(serverLink, request);
    let res;
    if (timeout === undefined) {
        res = await task;
    } else {
        const timer = new Promise((resolve, reject) => {
            setTimeout(
                () =>
                    reject(
                        new Error(
                            `Server timed out for request: ${JSON.stringify(request)}`
                        )
                    ),
                timeout
            );
        });
        res = await Promise.race([task, timer]);
    }
    if (res.data.error !== undefined) {
        throw new Error(res.data.error.message);
    }
    return res.data.result;
}

/* eslint-disable @typescript-eslint/naming-convention */

interface LineChange {
    start: number;
    until: number;
    old_str: string;
    new_str: string;
}

interface EditSuggestion {
    score: number;
    change_preview: string;
    input_status: Array<[number, string]>;
    output_status: Array<[number, string]>;
    changes: LineChange[];
}

interface ServerResponse {
    target_file: string;
    edit_start: number[];
    edit_end: number[];
    old_code: string;
    suggestions: EditSuggestion[];
    target_lines: number[];
}
