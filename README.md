# vscode-coeditor

Automatically suggest Python code edits using the Coeditor transformer model.

## Features

This extension provides the command `Coeditor: Suggest edit from this line`, which uses the cursor's line position to determine 
which Python function to perform the edit. Note that the extension is designed to work with Git projects and the model will condition 
its prediction on all the changes you made since the last commit. It will also condition on the changes you made before the cursor line 
(inclusive), so if it didn't suggest the desired edit you wanted, try making some initial changes and moving the cursor to a lower position.

You can also access the command from the editor context menu (via right click).

## Requirements

You need to first install the Coeditor model on your machine locally. Then, start the suggestion service by running 
```python
pipenv run python scripts/coeditor/start_server.py
```
This will start the service on port 5042. You can specify which port and GPU to use by modifying the script. 

## Extension Settings

* Coming soon!

## Known Issues

Currently, the service directly reads and writes to with the files on disk, so the command `Coeditor: Suggest edit from this line`
will first save the file before calling the service.

## Release Notes

### 0.0.2

Initial release.

