/** Extra functions for interacting with VS Code. */
import * as path from 'path';
//import * as vscode from 'vscode';
import {
    TextEditor,
    window,
    workspace,
    WorkspaceFolder,
} from 'vscode';


export const VSCONFIG_FOLDER_NAME: string = ".vscode";


/** Find the workspace directory for the active editor */
export function findActiveVSWorkspaceFolderPath(): string|undefined {
    const configFolderName: string = VSCONFIG_FOLDER_NAME;
    let textEditor: TextEditor|undefined = window.activeTextEditor;
    let workspaceFolder: WorkspaceFolder | undefined;
    if (textEditor) {
        workspaceFolder = workspace.getWorkspaceFolder(textEditor.document.uri);
    }
    // Maybe there is no active editor,
    //  or maybe the active editor file is not from the workspace.
    if (!workspaceFolder && workspace.workspaceFolders && workspace.workspaceFolders.length) {
        workspaceFolder = workspace.workspaceFolders[0];
    }
    let workspaceFolderPath: string|undefined;
    if (workspaceFolder) {
        workspaceFolderPath = workspaceFolder.uri.fsPath;
    }
    return workspaceFolderPath;
}

/** Find .vscode directory. */
export function findVSConfigFolderPath(workspaceFolderPath?: string): string|undefined {
    const configFolderName: string = VSCONFIG_FOLDER_NAME;
    let configFolderPath: string|undefined;
    if (!workspaceFolderPath) {
        workspaceFolderPath = findActiveVSWorkspaceFolderPath();
    }
    if (workspaceFolderPath) {
        configFolderPath = path.join(workspaceFolderPath, configFolderName);
    }
    return configFolderPath;
}

/** Find a file relative to the .vscode directory. */
export function findVSConfigFilePath(configFileRelPath: string, workspaceFolderPath?: string): string|undefined {
    let configFilePath: string|undefined;
    let configFolderPath: string|undefined = findVSConfigFolderPath(workspaceFolderPath);
    if (configFolderPath !== undefined) {
        configFilePath = path.join(configFolderPath, configFileRelPath);
    }
    return configFilePath;
}