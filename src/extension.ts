// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const axios = await require('axios').default;
	const serverPort = 5042;

	let disposables = [
		vscode.commands.registerCommand('vscode-coeditor.show-diff', async () => {
			// create a TabInputTextDiff
			const text1 = "Some old text";
			const text2 = "Some new text";
			const oldDoc = await vscode.workspace.openTextDocument({ content: text1 });
			const oldTab = new vscode.TabInputText(text1, "old");
			const diff = new vscode.TabInputTextDiff();
		}),
		vscode.commands.registerCommand('vscode-coeditor.suggestEdit', async () => {
			// if the activeText Editor is undefined, display an error
			if (vscode.window.activeTextEditor === undefined) {
				vscode.window.showErrorMessage('No active text editor. This command uses the ' +
				'location of the curosr to determine which code element to edit.');
				return;
			}
			const lineNumber = vscode.window.activeTextEditor.selection.start.line + 1;
			const filePath = vscode.window.activeTextEditor.document.fileName;
			const relPath = vscode.workspace.asRelativePath(filePath);
			const project = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
			if (project === undefined) {
				vscode.window.showErrorMessage('Unable to determine the project folder for the active editor.');
				return;
			}
			// save the file change before proceeding to the next step
			if (await vscode.window.activeTextEditor.document.save()){
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
				await axios.post(
					`http://localhost:${serverPort}`,
					req,
				).then((response: any) => {
					console.log(response);
					const result = response.data.result;
					vscode.window.showInformationMessage(result);
				}).catch((error: any) => {
					console.log(error);
					vscode.window.showErrorMessage(`Unable to apply suggested edit. See console for details.`);
				});
			} else {
				vscode.window.showErrorMessage('Unable to proceed: failed to save the active editor.');
			}
		})
	];


	context.subscriptions.push(...disposables);
}

// This method is called when your extension is deactivated
export function deactivate() { }
