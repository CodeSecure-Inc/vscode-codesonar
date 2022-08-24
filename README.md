# CodeSonar Extension for Visual Studio Code

Provides access to CodeSonar static analysis results from within the VS Code IDE.

## Features

Download analysis results in SARIF format from your CodeSonar hub.  Use "Sarif Viewer" extension from Microsoft to view analysis results in the VS Code editor.

Provides the following commands:

* `CodeSonar: Download SARIF: Entire Analysis`: 
  Download CodeSonar analysis results in SARIF format.
  All warning results for a single CodeSonar analysis will be downloaded.
* `CodeSonar: Download SARIF: New Warnings`:
  Download CodeSonar analysis results in SARIF format.
  Warnings which are present in a "new" analysis and which are not present in a "baseline" analysis will be downloaded.
* `CodeSonar: Clear hub user password`:
  Remove user's hub password from VS Code's password store.

CodeSonar hub authentication information and other preferences are managed in the VS Code settings.

## Requirements

* The "Sarif Viewer" VS Code extension from Microsoft.
* Access to a CodeSonar hub running CodeSonar 7.1 or later.

## Extension Settings

Many "CodeSonar" extension settings are provided in order to customize hub communication and to facilitate CodeSonar analysis from a VS Code task.

## Known Issues

* An error will not be displayed if user enters incorrect passphrase when authenticating with a protected hub key.

## Release Notes

### 1.0.0

Initial release.  Compatible with CodeSonar 7.1.
