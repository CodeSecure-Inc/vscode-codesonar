/** Support for codesonar.json file. */
import { workspace, WorkspaceConfiguration } from 'vscode';

import {
    CSHubAddress,
    CSHubAuthenticationMethod,
} from './csonar_ex';

import {
    CSONAR_VSCODE_VERSION_STRING,
    CSONAR_VSCODE_PROTOCOL_NUMBER,
} from './extension_version';


const CSHUB_CLIENT_NAME: string = "vscode";

const CONFIG_SECTION: string = "codesonar";
const CONFIG_HUB_ADDR: string = "hubAddress";
const CONFIG_HUB_CACERT: string = "hubAuthorityCertificate";
const CONFIG_HUB_TIMEOUT: string = "hubSocketTimeoutSeconds";
const CONFIG_HUB_AUTH: string = "authenticationMode";
const CONFIG_HUB_USER: string = "hubUser";
const CONFIG_HUB_PWFILE: string = "hubPasswordFile";
const CONFIG_HUB_CERT: string = "hubUserCertificate";
const CONFIG_HUB_KEY: string = "hubUserCertificateKey";
const CONFIG_ANALYSIS_PROJECT_TREE_PATH: string = "project";
const CONFIG_ANALYSIS_PROJECT_FILE: string = "projectFile";
const CONFIG_BASE_ANALYSIS_NAME: string = "baselineAnalysis";
const CONFIG_WARNING_FILTER: string = "warningFilter";

const SARIF_WHITESPACE_FORMAT_INDENTED: string = "indented";
const SARIF_WHITESPACE_FORMAT_COMPACT: string = "compact";

const SARIF_INDENT_LENGTH: number = 2;
const SARIF_NO_INDENT_LENGTH: number = -1;

export interface ExtensionVersionInfo {
    versionString: string;
    hubProtocolNumber: number;
    hubClientName: string;
}

export interface CSHubConfig {
    address?: string;
    cacert?: string;
    timeout?: number;
    auth?: CSHubAuthenticationMethod;
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
    path?: string;
    projectFilePath?: string;
    warningFilter?: string;
    baselineAnalysis?: string|CSAnalysisConfig;
    hub?: CSHubConfig;
}

export interface CSExtensionOptions {
    autoOpenSarifViewer: boolean;
    sarifIndentLength?: number;
}


/** Formats a string that encodes both the hub address and user name. */
function formatUserHubAddress(hubAddress: CSHubAddress, hubUserName: string): string {
    let userHubAddressString: string = `${hubUserName}@${hubAddress.hostname}`;
    if (hubAddress.protocol !== undefined) {
        userHubAddressString = `${hubAddress.protocol}://${userHubAddressString}`;
    }
    if (hubAddress.port !== undefined) {
        const portString: string = hubAddress.port.toString();
        userHubAddressString = `${userHubAddressString}:${portString}`;
    }

    return userHubAddressString;
}

/** Format a string that can be used as a lookup key for a hub user password in a password store. */
export function formatHubUserPasswordStorageKey(hubAddress: CSHubAddress, hubUserName: string): string {
    const userHubAddressString = formatUserHubAddress(hubAddress, hubUserName);
    return `codesonar/hubpasswd::${userHubAddressString}`;
}


/** Provides access to CodeSonar extension configuration settings. */
export class CSConfigIO {
    private wsConfig: WorkspaceConfiguration;
    public readonly extensionVersionInfo: ExtensionVersionInfo;
    public readonly defaultHubAddressString: string = "localhost:7340";
    /** A non-empty string that represents the hub's anonymous user. */
    public readonly anonymousUserName: string;

    constructor() {
        this.anonymousUserName = "Anonymous";
        this.wsConfig = workspace.getConfiguration(CONFIG_SECTION);
        this.extensionVersionInfo = {
            versionString: CSONAR_VSCODE_VERSION_STRING,
            hubProtocolNumber: CSONAR_VSCODE_PROTOCOL_NUMBER,
            hubClientName: CSHUB_CLIENT_NAME,
        };
    }

    /** Save hub address to config store. */
    async writeHubAddress(hubAddress: string): Promise<void> {
        await this.wsConfig.update(CONFIG_HUB_ADDR, hubAddress);
    }

    /** Save hub user name to config store. */
    async writeHubUserName(hubUserName: string): Promise<void> {
        await this.wsConfig.update(CONFIG_HUB_USER, hubUserName);
    }

    /** Save hub authentication mode/method to config store. */
    async writeHubAuthenticationMode(authenticationMode: CSHubAuthenticationMethod): Promise<void> {
        await this.wsConfig.update(CONFIG_HUB_AUTH, authenticationMode);
    }

    /** Save CodeSonar project path to config store. */
    async writeProjectPath(projectPath: string): Promise<void> {
        await this.wsConfig.update(CONFIG_ANALYSIS_PROJECT_TREE_PATH, projectPath);
    }

    /** Get extension behavior options. */
    public async readCSEXtensionOptions(): Promise<CSExtensionOptions> {
        return Promise.resolve(this.readCSExtensionOptionsSync());
    }

    private readCSExtensionOptionsSync(): CSExtensionOptions {
        const wsConfig: WorkspaceConfiguration = this.wsConfig;
        let options: CSExtensionOptions = {
            autoOpenSarifViewer: (wsConfig.get<boolean>("autoOpenSarifViewer") || false),
        };
        const sarifWhitespaceFormat: string|undefined = wsConfig.get<string>("sarifWhitespaceFormat");
        if (sarifWhitespaceFormat) {
            if (sarifWhitespaceFormat === SARIF_WHITESPACE_FORMAT_INDENTED) {
                options.sarifIndentLength = SARIF_INDENT_LENGTH;
            }
            else if (sarifWhitespaceFormat === SARIF_WHITESPACE_FORMAT_COMPACT) {
                options.sarifIndentLength = SARIF_NO_INDENT_LENGTH;
            }
            else {
                throw Error(`Unrecognized sarifWhitespaceFormat setting: '${sarifWhitespaceFormat}'`);
            }
        }
        return options;
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
        let authMethod: CSHubAuthenticationMethod|undefined;
        if (authString && (
                   authString === CSHubAuthenticationMethod.anonymous
                || authString === CSHubAuthenticationMethod.password
                || authString === CSHubAuthenticationMethod.certificate
            ))
        {
            authMethod = authString;
        }
        let timeoutSeconds: number|undefined = wsConfig.get<number|null>(CONFIG_HUB_TIMEOUT) ?? undefined;
        let timeoutMilliseconds: number|undefined;
        if (typeof timeoutSeconds === "number" && timeoutSeconds > 0) {
            timeoutMilliseconds = timeoutSeconds * 1000;
        }
        return {
            path: wsConfig.get<string>(CONFIG_ANALYSIS_PROJECT_TREE_PATH),
            projectFilePath: wsConfig.get<string>(CONFIG_ANALYSIS_PROJECT_FILE),
            warningFilter: wsConfig.get<string>(CONFIG_WARNING_FILTER),
            baselineAnalysis: wsConfig.get<string>(CONFIG_BASE_ANALYSIS_NAME) || undefined,  // make empty string undefined
            hub: {
                address: hubAddress,
                cacert: wsConfig.get<string>(CONFIG_HUB_CACERT) || undefined,
                timeout: timeoutMilliseconds,
                auth: authMethod,
                hubuser: wsConfig.get<string>(CONFIG_HUB_USER) || undefined,
                hubpwfile: wsConfig.get<string>(CONFIG_HUB_PWFILE) || undefined,
                hubcert: wsConfig.get<string>(CONFIG_HUB_CERT) || undefined,
                hubkey: wsConfig.get<string>(CONFIG_HUB_KEY) || undefined,
            }
        };
    }
}