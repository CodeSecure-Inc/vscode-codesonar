/** Support for codesonar.json file. */
import { Stats } from 'fs';
import { access, mkdir, readFile, stat, writeFile } from 'fs/promises';
import * as path from 'path';

import { workspace, WorkspaceConfiguration } from 'vscode';

import { errorToString } from './common_utils';
import { findVSConfigFilePath, findVSConfigFolderPath } from './vscode_ex';

type CSHubAuthMode = "anonymous" | "password" | "certificate";

export interface CSHubConfig {
    address?: string;
    cacert?: string;
    auth?: CSHubAuthMode;
    hubuser?: string;
    hubpwfile?: string;
    hubcert?: string;
    hubkey?: string;
}

export interface CSAnalysisConfig {
    name?: string;
    id?: string|number;
}

export interface CSProjectConfig {
    name?: string;
    id?: string|number;
    baselineAnalysis?: string|CSAnalysisConfig;
    hub?: CSHubConfig;
}

export interface CSConfig {
    projects?: CSProjectConfig[];
}

/** Get configuration from the VSCode settings.json. */
export function getCSWorkspaceSettings(): CSProjectConfig|undefined {
    const wsConfig: WorkspaceConfiguration = workspace.getConfiguration("codesonar");
    const hubAddress: string|undefined = wsConfig.get<string>("hubAddress");
    if (hubAddress === undefined || hubAddress.length === 0) {
        return undefined;
    }
    const authString: string|undefined = wsConfig.get<string>("authenticationMode");
    let authMode: CSHubAuthMode|undefined;
    if (authString && (
               authString === "anonymous"
            || authString === "password"
            || authString === "certificate"
        ))
    {
        authMode = undefined;
    }
    return {
        name: wsConfig.get<string>("project"),
        baselineAnalysis: wsConfig.get<string>("baselineAnalysis"),
        hub: {
            address: hubAddress,
            cacert: wsConfig.get<string>("hubAuthorityCertificate"),
            auth: authMode,
            hubuser: wsConfig.get<string>("hubUser"),
            hubpwfile: wsConfig.get<string>("hubPasswordFile"),
            hubcert: wsConfig.get<string>("hubUserCertificate"),
            hubkey: wsConfig.get<string>("hubUserCertificateKey"),
        }
    };
}

/** Create a default codesonar.json object */
export function makeCSConfig(hubAddress: string, projectName: string): CSConfig {
    return {
        projects: [
            {
                name: projectName,
                hub: {
                    address: hubAddress
                }
            }
        ]
    };
}

/** Write a codesonar.json file.
 *  By default, this will not overwrite an existing file.
 */
export async function writeCSConfigFile(
        csConfig: CSConfig,
        configFileName: string,
        workspaceFolderPath?: string): Promise<string> {
    const configFolderPath = findVSConfigFolderPath(workspaceFolderPath);
    if (configFolderPath === undefined) {
        throw Error("Could not find .vscode directory");
    }
    let configFolderStats: Stats|undefined;
    try {
        configFolderStats = await stat(configFolderPath);
    }
    catch (e) {
        // ignore this; assume that the folder does not exist.
    }
    if (configFolderStats === undefined) {
        try {
            await mkdir(configFolderPath, { recursive: true });
        }
        catch (e) {
            let errorMessage: string = `Could not create directory '${configFolderPath}'`;
            const errorDetails = errorToString(e);
            if (errorDetails) {
                errorMessage += ": " + errorDetails;
            }
            throw new Error(errorMessage);
        }
    }
    const configFilePath: string = path.join(configFolderPath, configFileName);
    let configFileStats: Stats|undefined;
    try {
        configFileStats = await stat(configFilePath);
    }
    catch (e) {
        // ignore this; assume that the file does not exist.
    }
    if (configFileStats !== undefined) {
        // File exists.  Don't overwrite it.
        throw new Error(`File already exists, will not overwrite: '${configFilePath}'`);
    }

    const indentLength: number = 4;
    const csConfigString: string = JSON.stringify(csConfig, null, indentLength);
    await writeFile(configFilePath, csConfigString);

    return configFilePath;
}


/** Read codesonar.json file */
export async function readCSConfigFile(configFileName: string, workspaceFolderPath?: string): Promise<CSConfig> {
    return new Promise<CSConfig>((resolve, reject) => {
        const configFilePath: string|undefined = findVSConfigFilePath(configFileName, workspaceFolderPath);
        if (configFilePath === undefined) {
            reject(new Error("Could not find .vscode directory."));
        }
        else {
            readFile(configFilePath, { encoding: "utf-8"}).then(
                (configText) => {
                    try {
                        let csConfig: CSConfig = JSON.parse(configText);
                        resolve(csConfig);
                    }
                    catch (e) {
                        // Probably a SyntaxError
                        console.log(e);
                        reject(e);
                    }
                }).catch(reject); // Probably a file read error.
        }
    });
}
