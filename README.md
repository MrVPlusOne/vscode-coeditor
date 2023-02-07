# Coeditor Extension for VSCode

AI-powered Python code change suggestion using the Coeditor transformer model.

## Features

- The extension is designed to work with Git projects and the model will condition its prediction on all the changes you made since the latest commit (plus any staged changes).
- The extension provides two commands for invoking the model. 
    - The command `Coeditor: Suggest edits for selection` use the current text selection to determine which lines to edit (when less than 1 lines are selected, it will select the lines below the cursor instead).
    - The command `Coeditor: Suggest edits again` reused the target line region established by `Suggest edits for selection`. You can run this command repeatedly each time you make additional edits to the target region.
- You can also access the `Suggest edits for selection` command from the editor context menu by right-clicking (available in `.py` files only).

## Installing the Model

- First, install the Coeditor model on your machine locally.
- Then, start the suggestion service by running the command below inside the model's directory:
```bash
pipenv run python scripts/coeditor/start_server.py
```
- The service will start on port 5042. You can specify a different port and GPU by modifying the script.
- Note that currently, the server needs to be on the same machine as your source code in order for the server to query the git history.

## Extension Settings

- `coeditor.serverURL`: The URL of the suggestion service. Default to `http://localhost:5042`.
- `coeditor.writeLogs`: Whether to write logs to the `<project>/.coeditor_logs`. Default to `false`. The logs containing the input and output directly seen by the model and are useful for debugging.

## Usage Tips
- If the model doesn't suggest the desired edit, try making some initial changes and moving the cursor to a lower position.
- Any changes you made below the cursor will not be visible to the model. However, you can stage those changes first and the model will treat them as part of the last commit and make edits on top of those changes. You can selectively stage a range of changes easily using the VSCode UI.
- This plugin only modifies a Python function that already exists in the last commit. It identifies a function using its full name (i.e., `module_name.class_name.function_name`). If you moved the function or changed its parent class's name, it would be treated as a new function and the model won't be able to suggest edits for it correctly (unless you stage thoese changes first).
- If the extension is behaving unexpectedly, you can check what the model saw in the last run using the command `Coeditor: View Model Logs`.

### Known Issues

- Currently, the service directly reads and writes to the files on disk, so the command `Coeditor: Suggest edits below this line`
will first save the file before calling the service.
- When suggesting edits with `drop_comments=True`, all comments and doc strings are removed before feeding the code to the model. Applying the suggested chagnes back onto the orginal code with comments can be tricky and may not always work. We recommend using `drop_comments=False` for now.

## Release Notes
### 0.3.0
- Replace the old command with `Coeditor: Suggest edits for selection` and `Coeditor: Suggest edits again`.

### 0.2.4
- Fix setting paths. Add option to write logs directly to the target project.

### 0.2.3
- Staged changes are now treated as part of the last commit.

### 0.2.2

- The extension now tracks which suggestion has already been applied so the user can directly click another suggestion without having to undo the previously applied one.

### 0.0.2

- Initial release.

