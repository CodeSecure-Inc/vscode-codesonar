/** Support for codesonar.json file. */
import { Stats } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import * as path from 'path';

import { workspace, WorkspaceConfiguration } from 'vscode';

import { errorToString } from './common_utils';
import { Logger } from './logger';
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

/** Get configuration from the VSCode settings.json.
 * 
 * This function returns a somewhat generalized JSON-compatible representation of the hub settings.
 * It was originally designed to support multiple projects, each possibly on a different hub.
*/
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
        baselineAnalysis: wsConfig.get<string>("baselineAnalysis") || undefined,  // make empty string undefined
        hub: {
            address: hubAddress,
            cacert: wsConfig.get<string>("hubAuthorityCertificate") || undefined,
            auth: authMode,
            hubuser: wsConfig.get<string>("hubUser") || undefined,
            hubpwfile: wsConfig.get<string>("hubPasswordFile") || undefined,
            hubcert: wsConfig.get<string>("hubUserCertificate") || undefined,
            hubkey: wsConfig.get<string>("hubUserCertificateKey") || undefined,
        }
    };
}
