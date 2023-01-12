# vscode-coeditor

Automatically suggest Python code edits using the Coeditor transformer model.

## Features

This extension provides the command `Coeditor: Suggest edit below this line`, which uses the cursor's line position to determine 
which Python function to perform the edit. Note that the extension is designed to work with Git projects and the model will condition 
its prediction on all the changes you made since the last commit. It will also condition on the changes you made before the cursor line 
(inclusive) and making suggestions to the lines below, so if it didn't suggest the desired edit you wanted, try making some initial changes and moving the cursor to a lower position.

You can also access the command from the editor context menu via right click (only in `.py` files).

## Requirements

You need to first install the Coeditor model on your machine locally. Then, start the suggestion service by running 
```python
pipenv run python scripts/coeditor/start_server.py
```
This will start the service on port 5042. You can specify which port and GPU to use by modifying the script. 

## Extension Settings

- Server.Url: The URL of the suggestion service. Default to `http://localhost:5042`.

## Usage Tips
- This plugin only modifies a Python function that already exists in the last commit. It identifies a function using its full name (i.e., `module_name.class_name.function_name`). This means if that you moved the function or changed its parent class's name, it would be treated as a new function and the model won't be able to suggest edits for it correctly.
- When the extension is behaving unexpectedly, you can check what the model sees by looking at the server log files under `<server_path>/coeditor_logs`.
    - TODO: add a command to open the log files.
- If you want the model to make edits to a function that's already modified by you, try commit your changes first before running the model.
    - TODO: can we use selective stash instead of commit to achieve this?

### Known Issues

- Currently, the service directly reads and writes to with the files on disk, so the command `Coeditor: Suggest edit from this line`
will first save the file before calling the service.

## Release Notes

### 0.2.2

- The extension now tracks which suggestion has already been applied so the user can directly click another suggestion without having to undo the previously applied one.

### 0.0.2

- Initial release.

