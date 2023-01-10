// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const axios = await require('axios').default;
	const serverPort = 5042;

	const coeditorClient = new CoeditorClient(context, axios, serverPort);

	const disposables = [
		vscode.commands.registerCommand('vscode-coeditor.suggestEdit', coeditorClient.suggestEdit, coeditorClient),
		// vscode.commands.registerCommand('vscode-coeditor.show-diff')
	];
	context.subscriptions.push(...disposables);
}

// This method is called when your extension is deactivated
export function deactivate() { }

// Currently not used
class DiffDisplayer {
	static scheme = "coeditor";

	virtualFiles: { [name: string] : string; } = {};
	constructor(context: vscode.ExtensionContext) {
		const vFiles = this.virtualFiles;
		const contentProvider = new (class implements vscode.TextDocumentContentProvider {
			provideTextDocumentContent(uri: vscode.Uri): string {
				// invoke cowsay, use uri-path as text
				return vFiles[uri.path];
			}
		})();
		const dis = vscode.workspace.registerTextDocumentContentProvider(DiffDisplayer.scheme, contentProvider);
		context.subscriptions.push(dis);
	}

	async showDiff() {
		const before = "x = 5\ny = 6\n";
		const after = "x = 'new'\ny = 6\n";
		this.virtualFiles["/before.py"] = before;
		this.virtualFiles["/after.py"] = after;

		const beforeUri = vscode.Uri.from({scheme: DiffDisplayer.scheme, path: "/before.py"});
		const afterUri = vscode.Uri.from({scheme: DiffDisplayer.scheme, path: "/after.py"});

		const diffOptions = {
			preview: true, // preview the changes instead of editing it
			viewColumn: vscode.ViewColumn.Beside, // open the diff editor to the right of the current editor
			// preserveFocus: true, // keep the focus on the current editor
		  };
		await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, "Suggested Edit", diffOptions);
		const diffUri = vscode.window.activeTextEditor?.document.uri;
	}
}

class CoeditorClient {
	serverPort: number;
	axios: any;
	codeLensProvider: vscode.CodeLensProvider;

	constructor(context: vscode.ExtensionContext, axios: any, serverPort: number) {
		this.serverPort = serverPort;
		if (axios === undefined) {
			throw new Error('axios is undefined');
		}
		this.axios = axios;
		const codeLensProvider: vscode.CodeLensProvider = {
			provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
				// Create a code lens object at the top of the file
				const codeLens = new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
				title: 'Apply suggestion',
				command: 'myExtension.doSomething',
				arguments: []
				});
				return [codeLens];
			}
		};
		this.codeLensProvider = codeLensProvider;
		const dis = vscode.languages.registerCodeLensProvider('*', codeLensProvider);
		context.subscriptions.push(dis);
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

		const lineNumber = vscode.window.activeTextEditor.selection.start.line + 1;
		const filePath = vscode.window.activeTextEditor.document.fileName;
		const relPath = vscode.workspace.asRelativePath(filePath);

		const saved = await vscode.window.activeTextEditor.document.save();
		if (!saved) {
			vscode.window.showErrorMessage('Unable to proceed: failed to save the active editor.');
			return;
		}
		
		vscode.window.showInformationMessage(`Suggesting edit at line ${lineNumber} in ${relPath}`);
		const req = {
			"jsonrpc": "2.0",
			"method": "suggestAndApply",
			"params": {
				"project": project.uri.fsPath,
				"file": relPath,
				"line": lineNumber
			},
			"id": 1,
		};
		await this.axios.post(
			`http://localhost:${this.serverPort}`,
			req,
		).then((response: any) => {
			console.log(response);
			const result = response.data.result;
			vscode.window.showInformationMessage(result);
		}).catch((error: any) => {
			console.log(error);
			vscode.window.showErrorMessage(`Unable to apply suggested edit. Error: ${error}`);
		});
	}
}

