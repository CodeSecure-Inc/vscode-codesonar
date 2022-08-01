/** Support for codesonar.json file. */
import { Stats } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import * as path from 'path';

import { workspace, WorkspaceConfiguration } from 'vscode';

import { errorToString } from './common_utils';
import { Logger } from './logger';
import { findVSConfigFilePath, findVSConfigFolderPath } from './vscode_ex';

const CONFIG_SECTION: string = "codesonar";
const CONFIG_HUB_ADDR: string = "hubAddress";
const CONFIG_HUB_CACERT: string = "hubAuthorityCertificate";
const CONFIG_HUB_AUTH: string = "authenticationMode";
const CONFIG_HUB_USER: string = "hubUser";
const CONFIG_HUB_PWFILE: string = "hubPasswordFile";
const CONFIG_HUB_CERT: string = "hubUserCertificate";
const CONFIG_HUB_KEY: string = "hubUserCertificateKey";
const CONFIG_ANALYSIS_PROJECT_NAME: string = "project";
const CONFIG_BASE_ANALYSIS_NAME: string = "baselineAnalysis";

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

export function saveHubAddress(hubAddress: string) {
    const wsConfig: WorkspaceConfiguration = workspace.getConfiguration(CONFIG_SECTION);
    wsConfig.update(CONFIG_HUB_ADDR, hubAddress);
}

/** Provides access to CodeSonar extension configuration settings. */
export class CSConfigIO {
    private wsConfig: WorkspaceConfiguration;
    /** A non-empty string that represents the hub's anonymous user. */
    public readonly anonymousUserName: string;

    constructor() {
        this.anonymousUserName = "Anonymous";
        this.wsConfig = workspace.getConfiguration(CONFIG_SECTION);
    }

    /** Save hub address to config store. */
    async writeHubAddress(hubAddress: string): Promise<void> {
        await this.wsConfig.update(CONFIG_HUB_ADDR, hubAddress);
    }

    /** Save hub user name to config store. */
    async writeHubUserName(hubUserName: string): Promise<void> {
        await this.wsConfig.update(CONFIG_HUB_USER, hubUserName);
    }

    /** Save CodeSonar project name to config store. */
    async writeProjectName(projectName: string): Promise<void> {
        await this.wsConfig.update(CONFIG_ANALYSIS_PROJECT_NAME, projectName);
    }

    /** Get configuration from the VSCode settings.json.
     * 
     * This function returns a somewhat generalized JSON-compatible representation of the hub settings.
     * It was originally designed to support multiple projects, each possibly on a different hub.
    */
    public async readCSProjectConfig(): Promise<CSProjectConfig|undefined> {
        return Promise.resolve(this.readCSProjectConfigSync());
    }

    /** Implement settings reader using synchronous calls.
     * 
     * VSCode API uses synchronous methods for read and asynchronouse methods for write.
     * This is the opposite of Node streams.
     * In order to establish uniformity, this module makes both directions asynchronous,
     * and it hides the fact that we are really using synchronous methods in this private method.
    */
    private readCSProjectConfigSync(): CSProjectConfig|undefined {
        const wsConfig: WorkspaceConfiguration = this.wsConfig;
        const hubAddress: string|undefined = wsConfig.get<string>(CONFIG_HUB_ADDR);
        if (hubAddress === undefined || hubAddress.length === 0) {
            return undefined;
        }
        const authString: string|undefined = wsConfig.get<string>(CONFIG_HUB_AUTH);
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
            name: wsConfig.get<string>(CONFIG_ANALYSIS_PROJECT_NAME),
            baselineAnalysis: wsConfig.get<string>(CONFIG_BASE_ANALYSIS_NAME) || undefined,  // make empty string undefined
            hub: {
                address: hubAddress,
                cacert: wsConfig.get<string>(CONFIG_HUB_CACERT) || undefined,
                auth: authMode,
                hubuser: wsConfig.get<string>(CONFIG_HUB_USER) || undefined,
                hubpwfile: wsConfig.get<string>(CONFIG_HUB_PWFILE) || undefined,
                hubcert: wsConfig.get<string>(CONFIG_HUB_CERT) || undefined,
                hubkey: wsConfig.get<string>(CONFIG_HUB_KEY) || undefined,
            }
        };
    }
}