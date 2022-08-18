/** An object that facilitates access to a CodeSonar hub. */
import { strict as assert } from 'node:assert';
import { readFile } from 'fs/promises';
import { Readable } from 'stream';

import { 
    asErrnoException,
    errorToString,
    readTextStream,
} from './common_utils';
import { Logger } from './logger';

import { 
    encodeURIQuery,
    HTTP_OK,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_PROTOCOL,
    HTTPS_PROTOCOL,
    HTTPClientConnection,
    HTTPClientConnectionOptions,
    HTTPClientRequestOptions,
    HTTPReceivedResponse,
    HTTPStatusError,
} from './http_client';
import { 
    CSHubAddress,
    CSHubUserKey,
} from './csonar_ex';


const FORM_URLENCODED_CONTENT_TYPE: string = "application/x-www-form-urlencoded";

const RESPONSE_TRY_PLAINTEXT: string = "response_try_plaintext";

type CSHubRecordId = string;
export type CSAnalysisId = CSHubRecordId;
export type CSProjectId = CSHubRecordId;

export interface CSProjectInfo {
    id: CSProjectId;
    name: string;
    path: string;
}

export interface CSAnalysisInfo {
    id: CSAnalysisId;
    name: string;
}

export type CSHubAuthenticationMethod = "anonymous" | "password" | "certificate";

/** Options for authenticating with a CodeSonar hub.
 *
 *  @property {CSHubAuthenticationMethod} auth  type of authentication to use.
 *  @property {string} hubuser  hub user name.
 *  @property {()=>Promise<string>} hubpass  a function that can retrieve the hub user's password.
 *  @property {string} hubpwfile  path to a file containing the user's password.
 *  @property {string} hubcert  file in PEM format containing user's (public) client certificate.
 *  @property {string} hubkey  file in PEM format containing the user's (private) client certificate key.
 */
export interface CSHubAuthenticationOptions {
    auth?: CSHubAuthenticationMethod;
    hubuser?: string;
    hubpasswd?: () => Promise<string>;
    hubpwfile?: string;
    hubkey?: CSHubUserKey;
    hubkeypasswd?: () => Promise<string>;
}

/** Options for creating a connection to a CodeSonar hub.
 *
 *  @property {string} cafile  path to a Certificate Authority certificate file in PEM format to use for verifying the hub server.
 *  @property {number} timeout  socket timeout in milliseconds.
 */
export interface CSHubClientConnectionOptions extends CSHubAuthenticationOptions {
    cafile?: string;
    timeout?: number;
}

/** Options for warning search in SARIF format. */
export interface CSHubSarifSearchOptions {
    warningFilter?: string;
    indentLength?: number;
    artifactListing?: boolean;
}


type CSHubParamBoolean = "0" | "1";
type CSHubSignInFormBoolean = CSHubParamBoolean;

const CS_HUB_PARAM_TRUE: CSHubParamBoolean = "1";
const CS_HUB_PARAM_FALSE: CSHubParamBoolean = "0";


interface CSHubSignInForm {
    /* eslint-disable @typescript-eslint/naming-convention */
    sif_sign_in: CSHubSignInFormBoolean;
    sif_log_out_competitor?: CSHubSignInFormBoolean;
    sif_ignore_empty_email?: CSHubSignInFormBoolean;
    response_try_plaintext?: CSHubSignInFormBoolean;
    sif_username?: string;
    sif_password?: string;
    sif_use_tls?: CSHubSignInFormBoolean;
    /* eslint-enable @typescript-eslint/naming-convention */
}

/** Response from '/command/client_version/$client/' */
export interface CSHubVersionCompatibilityInfo {
    hubVersion: string,
    hubVersionNumber: number,
    hubProtocol: number,
    clientOK?: boolean|null,
}

/** Defines the generic result of a Hub API search. */
interface CSHubApiSearchResults<T> {
    rows?: Array<T>
}

/** Defines a subset of project_search JSON row. */
interface CSHubProjectRow {
    /* eslint-disable @typescript-eslint/naming-convention */
    "Project ID"?: number,
    "Project"?: string,
    "Path"?: string,
    /* eslint-enable @typescript-eslint/naming-convention */
}

/** Defines a subset of analysis JSON row from project endpoint. */
interface CSHubAnalysisRow {
    /* eslint-disable @typescript-eslint/naming-convention */
    "Analysis"?: string,
    "url"?: string,
    /* eslint-enable @typescript-eslint/naming-convention */
}

/**
 * Encode a string literal term for a CodeSonar search.
 */
function encodeCSSearchStringLiteral(s: string): string {
    const QUOTE: string = '"';
    const QUOTE_ESC: string = '\\"';
    const APOS: string = "'";
    const APOS_ESC: string = "\\'";
    const ESC: string = "\\";
    const ESC_ESC: string = "\\\\";

    let charUnits: string[] = [];
    charUnits.push(QUOTE);
    for (let i: number = 0; i < s.length; i++) {
        let ch: string = s[i];
        if (ch === ESC) {
            ch = ESC_ESC;
        }
        else if (ch === QUOTE) {
            ch = QUOTE_ESC;
        }
        else if (ch === APOS) {
            ch = APOS_ESC;
        }
        charUnits.push(ch);
    }
    charUnits.push(QUOTE);

    return charUnits.join("");
}

/** Convert a record ID (probably originating from JSON) into a CSHubRecordId type. */
function parseCSHubRecordId(recordId: string|number): CSHubRecordId {
    return recordId.toString();
}

/** Convert a project ID (probably originating from JSON) into a CSProjectId type. */
export function parseCSProjectId(projectId: string|number): CSProjectId {
    return parseCSHubRecordId(projectId);
}

/** Convert an analysis ID (probably originating from JSON) into a CSAnalysisId type. */
export function parseCSAnalysisId(analysisId: string|number): CSAnalysisId {
    return parseCSHubRecordId(analysisId);
}

/** Parse a hub query or post-data parameter as a boolean value. */
function parseCSHubParamBoolean(s: string|undefined|null): boolean|undefined {
    let b: boolean|undefined;
    if (s === undefined || s === null) {
        b = undefined;
    }
    else if (s === "yes" || s === "1") {
        b = true;
    }
    else if (s === "no" || s === "0") {
        b = false;
    }
    return b;
}

/** Specialize an HTTPStatusError for the CodeSonar hub. */
export class CSHubRequestError extends HTTPStatusError {
    public readonly statusMessage: string;
    public readonly hubMessage: string;

    constructor(statusMessage: string, code: number, hubMessage?: string) {
        const message: string = hubMessage || statusMessage;
        super(message, code);
        this.name = 'CSHubRequestError';
        this.statusMessage = statusMessage;
        this.hubMessage = hubMessage ?? "";
    }

    public toString(): string {
        return this.message;
    }
}


/** Object to manage an HTTP session with a CodeSonar hub. */
export class CSHubClient {
    private hubAddress: CSHubAddress;
    private options: CSHubClientConnectionOptions;
    private httpConn: HTTPClientConnection|undefined;

    public logger: Logger|undefined;

    constructor(
        hubAddress: string|CSHubAddress,
        options?: CSHubClientConnectionOptions,
    ) {
        if (typeof hubAddress === 'string') {
            this.hubAddress = new CSHubAddress(hubAddress);
        }
        else {
            this.hubAddress = hubAddress;
        }
        this.options = options ?? {};
    }

    private errorToString(error: any): string {
        return errorToString(error, { verbose: true });
    }

    private log(info: unknown): void {
        if (this.logger !== undefined) {
            this.logger.info(this.errorToString(info));
        }
    }

    private logWarning(warn: unknown): void {
        if (this.logger !== undefined) {
            this.logger.warn(this.errorToString(warn));
        }
    }

    private logError(error: unknown): void {
        if (this.logger !== undefined) {
            this.logger.error(this.errorToString(error));
        }
    }

    /** Get the underlying HTTP connection object.  Test for secure protocol if necessary. */
    async getHttpClientConnection(): Promise<HTTPClientConnection> {
        const hubOptions: CSHubClientConnectionOptions = this.options;
        if (this.httpConn === undefined) {
            let protocol: string|undefined = this.hubAddress.protocol;
            let httpOptions: HTTPClientConnectionOptions = {
                hostname: this.hubAddress.hostname,
                port: this.hubAddress.port,
            };
            if (hubOptions.timeout !== undefined) {
                httpOptions.timeout = hubOptions.timeout;
            }
            if (hubOptions.cafile) {
                httpOptions.ca = await readFile(hubOptions.cafile);
                protocol = HTTPS_PROTOCOL;
            }
            if (hubOptions.hubkey !== undefined) {
                await hubOptions.hubkey.load();
                httpOptions.cert = hubOptions.hubkey.cert;
                httpOptions.key = hubOptions.hubkey.key;
                if (hubOptions.hubkeypasswd !== undefined
                    && hubOptions.hubkey.keyIsProtected
                ) {
                    httpOptions.keypasswd = hubOptions.hubkeypasswd;
                }
                protocol = HTTPS_PROTOCOL;
            }
            if (protocol === undefined) {
                // NOTE: if user specified a password-protected hub certificate,
                //  then we infer that protocol is HTTPS,
                //  and we should never find ourselves here.
                assert.strictEqual(httpOptions.keypasswd, undefined);
                // Hub address did not include the protocol.
                //  Try to fetch home page over HTTPS first. Fallback to HTTP.
                protocol = HTTPS_PROTOCOL;
                httpOptions.protocol = protocol;
                const testResource: string = "/";
                this.log("Testing if hub uses HTTPS...");
                let httpConn2: HTTPClientConnection = new HTTPClientConnection(httpOptions);
                try {
                    let resp: HTTPReceivedResponse = await httpConn2.request(testResource, { method: "HEAD" });
                    await new Promise<void>((
                            resolve: () => void,
                            reject: (e: any) => void,
                        ) => {
                        resp.body.on('end', resolve);
                        resp.body.on('error', reject);
                        resp.body.resume();
                    });
                    if (resp.status.code === 301) {
                        // MOVED PERMANENTLY
                        // Hub is asking us to redirect, so try HTTP.
                        protocol = HTTP_PROTOCOL;
                    }
                }
                catch (e: unknown) {
                    this.log(e);
                    const ex: NodeJS.ErrnoException|undefined = asErrnoException(e);
                    const code: string = ex?.code ?? '';
                    // EPROTO error occurs if we try to speak in HTTPS to an HTTP hub:
                    if (code !== 'EPROTO') {
                        // Many other legitimate connection errors could occur,
                        //  such as 'DEPTH_ZERO_SELF_SIGNED_CERT',
                        //  and we want those errors to be seen by the caller.
                        throw e;
                    }
                    protocol = HTTP_PROTOCOL;
                }
            }
            httpOptions.protocol = protocol;
            this.httpConn = new HTTPClientConnection(httpOptions);
            this.httpConn.logger = this.logger;
        }
        return this.httpConn;
    }

    /** Helper method for reading error message from hub response. */
    private async createHubRequestError(
        resp: HTTPReceivedResponse,
        responseIsErrorMessage: boolean,
    ): Promise<HTTPStatusError> {
        const maxErrorMessageLength: number = 4096;
        let hubError: HTTPStatusError = resp.status;
        if (responseIsErrorMessage) {
            const errorMessage: string = await readTextStream(resp.body, maxErrorMessageLength);
            if (errorMessage.startsWith("<!DOCTYPE")) {
                // Assume the response was HTML, we won't try to use it:
                this.log("Hub returned HTML, but plaintext was expected");
            }
            else {
                this.log(`Hub Error Message: ${errorMessage}`);
                hubError = new CSHubRequestError(resp.status.message, resp.status.code, errorMessage);    
            }
        }
        else {
            resp.body.destroy();
        }
        return hubError;
    }

    /** Read a JSON stream into a data structure. */
    private parseResponseJson(resIO: NodeJS.ReadableStream): Promise<unknown> {
        return new Promise<unknown>((
            resolve: (jsonObject: unknown) => void,
            reject: ((e: any) => void),
        ) => {
            let chunks: string[] = [];
            resIO.setEncoding("utf8");
            resIO.on('data', (data: string): void => {
                try {
                    chunks.push(data);
                } catch (e: unknown) {
                    this.logError(e);
                }
            });
            resIO.on('end', (): void => {
                let responseText: string = chunks.join('');
                let okResolve: boolean = false;
                let jsonObject: unknown;
                try {
                    jsonObject = JSON.parse(responseText);
                    okResolve = true;
                } catch (e: unknown) {
                    this.logWarning(e);
                    reject(e);
                }
                if (okResolve) {
                    resolve(jsonObject);
                }
            });
            resIO.on('error', (e: any): void => {
                this.logWarning(e);
                reject(e);
            });
        });
    }

    /** Post raw data to the hub. */
    private async post(
        resource: string,
        data: string,
        options?: HTTPClientRequestOptions,
        contentType: string = FORM_URLENCODED_CONTENT_TYPE,
    ): Promise<Readable> {
        const httpConn: HTTPClientConnection = await this.getHttpClientConnection();
        const httpOptions: HTTPClientRequestOptions = { 
            method: "POST",
            headers: {
                /* eslint-disable @typescript-eslint/naming-convention */
                "Accept-Charset": "utf-8",
                "Content-Type": contentType,
                /* eslint-enable @typescript-eslint/naming-convention */
            },
        };
        if (options) {
            if (options.headers !== undefined
                && httpOptions.headers !== undefined  // needed for typechecker only
            ) {
                for (let headerName of Object.keys(options.headers)) {
                    httpOptions.headers[headerName] = options.headers[headerName];
                }
            }
            if (options.timeout) {
                httpOptions.timeout = options.timeout;
            }
        }
        const resourceUrl: URL = httpConn.resourceURL(resource);
        // Parse the URL so we can learn if it is okay to read the response for error information.
        //  This is somewhat inefficient
        //   since we could require the caller to tell us explicitly,
        //   but this method seems to be more convenient for the caller.
        const formParams: URLSearchParams = ((contentType === FORM_URLENCODED_CONTENT_TYPE)
            ? new URLSearchParams(data)
            : new URLSearchParams());
        const responseTryPlaintextValue: string|null = resourceUrl.searchParams.get(RESPONSE_TRY_PLAINTEXT);
        const responseIsErrorMessage: boolean = parseCSHubParamBoolean(responseTryPlaintextValue) || false;
        this.log(`Posting resource to ${resource}`);
        // The hub will return HTTP 501 if Transfer-Encoding header is set.
        // To avoid this, we must ensure Content-Length header is set.
        // We assume that the httpConn.request() method will do this for us:
        const resp: HTTPReceivedResponse = await httpConn.request(resourceUrl, httpOptions, data);
        if (resp.status.code !== HTTP_OK) {
            this.log(`HTTP Status: ${resp.status}`);
            const hubError: Error = await this.createHubRequestError(resp, responseIsErrorMessage);
            throw hubError;
        }

        this.log("Received OK response");
        return resp.body;
    }

    private clearSignInCookies(httpConn: HTTPClientConnection): void {
        // This just clears all cookies from the HTTP client.
        //  We are assuming that the HTTP client doesn't store any other important cookies that should not be cleared.
        httpConn.clearCookies();
    }

    /** Try to sign-in to the hub using hub client credentials.
     *
     *  Returns an sign-in failure message if the sign-in was rejected.
     *  Throws an error if there is a network error.
     * 
     * @returns {Promise<string|undefined>}  Promise resolving to undefined if sign-in succeeded
     *     or sign-in failure message string if credentials were rejected.
     */
    public signIn(): Promise<string|undefined> {
        // Send sign-in POST request to a page that produces a short response:
        const successMessage: string|undefined = undefined;
        // response_try_plaintext must be in URL, or it won't work.
        //  The manual implies it will be respected in the POST data too,
        //   but that doesn't seem to work.
        //  We will do both just to be safe.
        const signInUrlPath: string = `/?${RESPONSE_TRY_PLAINTEXT}=${CS_HUB_PARAM_TRUE}`;
        const options: CSHubClientConnectionOptions = this.options;
        return new Promise<string|undefined>((
            resolve: (e: string|undefined) => void,
            reject: (e: any) => void,
        ) => {
            if ((options.auth === undefined || options.auth === "certificate")
                && (options.hubkey !== undefined)
            ) {
                const sif: CSHubSignInForm = {
                    /* eslint-disable @typescript-eslint/naming-convention */
                    sif_sign_in: CS_HUB_PARAM_TRUE,
                    sif_ignore_empty_email: CS_HUB_PARAM_TRUE,
                    sif_log_out_competitor: CS_HUB_PARAM_TRUE,
                    response_try_plaintext: CS_HUB_PARAM_TRUE,
                    sif_use_tls: CS_HUB_PARAM_TRUE,
                    /* eslint-enable @typescript-eslint/naming-convention */
                };
                const sifData: string = encodeURIQuery(sif);
                this.log("Posting signin data...");
                // The hubcert and hubkey will be implicitly passed to the server in this POST method
                //  since they came from 'this.options'.
                this.post(signInUrlPath, sifData).then((respBody: NodeJS.ReadableStream): void => {
                    // Ignore response body:
                    respBody.resume();
                    resolve(successMessage);
                }).catch((e: any): void => {
                    if ((e instanceof CSHubRequestError)
                        && e.code !== undefined
                        && e.code === HTTP_FORBIDDEN
                    ) {
                        // Ordinary signin failure:
                        resolve(e.message);
                    } else {
                        reject(e);
                    }
                });
            }
            else if ((options.auth === undefined || options.auth === "password")
                    && options.hubuser) {
                let passwordPromise: Promise<string>|undefined; 
                if (options.hubpasswd) {
                    passwordPromise = options.hubpasswd();
                }
                else if (options.hubpwfile) {
                    passwordPromise = readFile(options.hubpwfile, {encoding:"utf-8"}).then(
                            fileContent => fileContent.trim());
                }
                if (passwordPromise === undefined) {
                    reject(new Error("Hub user password was not provided."));
                } else {
                    passwordPromise.then((password: string): Promise<NodeJS.ReadableStream> => {
                        const sif: CSHubSignInForm = {
                            /* eslint-disable @typescript-eslint/naming-convention */
                            sif_sign_in: CS_HUB_PARAM_TRUE,
                            sif_ignore_empty_email: CS_HUB_PARAM_TRUE,
                            sif_log_out_competitor: CS_HUB_PARAM_TRUE,
                            response_try_plaintext: CS_HUB_PARAM_TRUE,
                            sif_username: options.hubuser,
                            sif_password: password,
                            /* eslint-enable @typescript-eslint/naming-convention */
                        };
                        const sifData: string = encodeURIQuery(sif);
                        this.log("Posting signin data...");
                        return this.post(signInUrlPath, sifData);
                    }).then(
                        (respBody: NodeJS.ReadableStream): void => {
                            // Ignore response body:
                            respBody.resume();
                            resolve(successMessage);
                    }).catch((e: any): void => {
                        if ((e instanceof CSHubRequestError)
                                && e.code !== undefined
                                && e.code === HTTP_FORBIDDEN) {
                            resolve(e.message);
                        } else {
                            reject(e);
                        }
                    });
                }
            }
            else if (options.auth === undefined || options.auth === "anonymous") {
                // Simply drop existing sign-in cookie
                this.getHttpClientConnection().then(
                    (httpConn: HTTPClientConnection): void => {
                        this.clearSignInCookies(httpConn);
                        resolve(successMessage);
                }).catch(reject);
            }
            else {
                reject(new Error("Could not determine hub authentication method."));
            }
        });
    }

    /** Fetch a raw resource from the hub. */
    public fetch(resource: string): Promise<Readable> {
        return new Promise<Readable>((
                resolve: (resIO: Readable) => void,
                reject: (e: unknown) => void,
            ) => {
                this.getHttpClientConnection().then(
                    (httpConn: HTTPClientConnection): Promise<HTTPReceivedResponse> => {
                        this.log(`Fetching resource ${resource}`);
                        return httpConn.request(resource);
                }).then((resp: HTTPReceivedResponse): void => {
                    if (resp.status.code === HTTP_OK) {
                        this.log("Received OK response");
                        resolve(resp.body);
                    }
                    else {
                        this.log(`HTTP Status: ${resp.status}`);
                        const responseTryPlaintextValue: string|null = resp.url.searchParams.get(RESPONSE_TRY_PLAINTEXT);
                        const responseIsErrorMessage: boolean = parseCSHubParamBoolean(responseTryPlaintextValue) || false;
                        this.createHubRequestError(
                            resp,
                            responseIsErrorMessage,
                        ).then(reject).catch(reject);
                    }
                }).catch(reject);
            });
    }

    /** Fetch an untyped JSON object from the hub. */
    private async fetchJson(resource: string): Promise<unknown> {
        const resIO = await this.fetch(resource);
        return this.parseResponseJson(resIO);
    }

    /** Try to fetch hub and client version compatibility information.
     * 
     *  @returns version compatibility information if available.
     *   CodeSonar hubs prior to v7.1 do not provide this information
    */
    public async fetchVersionCompatibilityInfo(
        clientName: string,
        clientVersion: string,
    ): Promise<CSHubVersionCompatibilityInfo|undefined> {
        const versionCheckResource: string = `/command/check_version/${encodeURIComponent(clientName)}/?version=${encodeURIComponent(clientVersion)}`;
        let respResult: CSHubVersionCompatibilityInfo|undefined;
        try {
            const respJson: unknown = await this.fetchJson(versionCheckResource);
            respResult = respJson as CSHubVersionCompatibilityInfo;
        }
        catch (e: unknown) {
            if (e instanceof HTTPStatusError
                && e.code === HTTP_NOT_FOUND
            ) {
                // check_version URL was added in CodeSonar 7.1,
                //  assume this is an old hub that does not support this URL.
            }
            else {
                throw e;
            }
        }
        return respResult;
    }

    /** Fetch a list of analysis projects. */
    public async fetchProjectInfo(searchProjectPath?: string): Promise<CSProjectInfo[]> {
        const prjGridParams: string = "[project id.sort:asc][project id.visible:1][path.visible:1]";
        let projectSearchPath: string = "/project_search.json";
        projectSearchPath += `?sprjgrid=${encodeURIComponent(prjGridParams)}`;
        if (searchProjectPath) {
            const projectSearchLiteral: string = encodeCSSearchStringLiteral(searchProjectPath);
            const projectSearchQuery: string = encodeURIComponent(`ptree_path=${projectSearchLiteral}`);
            projectSearchPath += "&query=" + projectSearchQuery;
        }
        projectSearchPath += `&${RESPONSE_TRY_PLAINTEXT}=${CS_HUB_PARAM_TRUE}`;
        const respJson: unknown = await this.fetchJson(projectSearchPath);
        const respResults: CSHubApiSearchResults<CSHubProjectRow> = respJson as CSHubApiSearchResults<CSHubProjectRow>;
        this.log("Received project JSON");
        let projectInfoArray: CSProjectInfo[] = [];
        if (respResults && respResults.rows !== undefined) {
            const respRows: CSHubProjectRow[] = respResults.rows;
            // TODO: the "Project ID" number may be too large for javascript.
            //  We cannot parse the project ID from the "url" item,
            //   since the "url" is for the latest analysis; not the project page.
            for (let row of respRows) {
                //this.log(row);
                const projectIdNum: number|undefined = row["Project ID"];
                const projectName: string|undefined = row["Project"];
                const projectPath: string|undefined = row["Path"];
                let projectId: CSProjectId|undefined;
                if (projectIdNum !== undefined) {
                    projectId = projectIdNum.toString();
                }
                if (projectId !== undefined 
                    && projectName !== undefined
                    && projectPath !== undefined
                ) {
                    projectInfoArray.push({
                        id: projectId,
                        name: projectName,
                        path: projectPath,
                    });
                }
            }
        }
        return projectInfoArray;
    }

    /** Fetch a list of analyses for a project. */
    public async fetchAnalysisInfo(projectId: CSProjectId): Promise<CSAnalysisInfo[]> {
        const analysisTableSpec: string = encodeURIComponent("[analysis id.sort:desc]");
        const analysisListPath: string = `/project/${encodeURIComponent(projectId)}.json?${RESPONSE_TRY_PLAINTEXT}=${CS_HUB_PARAM_TRUE}&anlgrid=${analysisTableSpec}`;
        const respJson: unknown = await this.fetchJson(analysisListPath);
        const respResults: CSHubApiSearchResults<CSHubAnalysisRow> = respJson as CSHubApiSearchResults<CSHubAnalysisRow>;
        let analysisInfoArray: CSAnalysisInfo[] = [];
        if (respResults && respResults.rows !== undefined) {
            const respRows: CSHubAnalysisRow[] = respResults.rows;
            // Parse ID out of "url" item as a string:
            const analysisIdRegExp: RegExp = new RegExp("/analysis/(\\d+)\\.json");
            for (let row of respRows) {
                let analysisId: string|undefined;
                const analysisUrlString: string|undefined = row["url"];
                const analysisName: string|undefined = row["Analysis"];
                if (analysisUrlString) {
                    const analysisIdMatch = analysisUrlString.match(analysisIdRegExp);
                    if (analysisIdMatch && analysisIdMatch.length > 1) {
                        analysisId = analysisIdMatch[1];
                    }
                }
                if (analysisId !== undefined && analysisName !== undefined) {
                    analysisInfoArray.push({
                        id: analysisId,
                        name: analysisName,
                    });
                }
            }
        }
        return analysisInfoArray;
    }

    private _makeSarifQueryString(options: CSHubSarifSearchOptions|undefined): string|undefined {
        const sarifIndentLength: number|undefined = options?.indentLength;
        const sarifArtifactListing: boolean|undefined = options?.artifactListing;
        const warningFilter: string|undefined = options?.warningFilter;
        let queryArgs: string[] = [];
        if (warningFilter) {
            queryArgs.push(`filter=${encodeURIComponent(warningFilter)}`);
        }
        if (sarifIndentLength !== undefined) {
            let sarifIndentArg: string = "";
            if (sarifIndentLength >= 0) {
                sarifIndentArg = sarifIndentLength.toString();
            }
            queryArgs.push(`indent=${encodeURIComponent(sarifIndentArg)}`);
        }
        if (sarifArtifactListing !== undefined) {
            const sarifArtifactListingArg: string = (sarifArtifactListing) ? "1" : "0";
            queryArgs.push(`artifacts=${encodeURIComponent(sarifArtifactListingArg)}`);
        }
        queryArgs.push(`${RESPONSE_TRY_PLAINTEXT}=${CS_HUB_PARAM_TRUE}`);

        let queryString: string|undefined;
        if (queryArgs.length > 0) {
            queryString = queryArgs.join('&');
        }
        return queryString;
    }

    /** Fetch SARIF results for a single analysis. */
    public async fetchSarifAnalysisStream(
            analysisId: CSAnalysisId,
            options?: CSHubSarifSearchOptions,
            ): Promise<Readable>
    {
        let sarifAnalysisUrlPath: string = `/analysis/${encodeURIComponent(analysisId)}-allwarnings.sarif`;
        const queryString: string|undefined = this._makeSarifQueryString(options);
        if (queryString) {
            sarifAnalysisUrlPath += '?' + queryString;
        }
        return this.fetch(sarifAnalysisUrlPath);
    }

    /** Fetch SARIF results from a single analysis that are not present in a second, base analysis. */
    public async fetchSarifAnalysisDifferenceStream(
            headAnalysisId: CSAnalysisId,
            baseAnalysisId: CSAnalysisId,
            options?: CSHubSarifSearchOptions,
            ): Promise<Readable>
    {
        // warning_detail_search.sarif is not supported prior to CodeSonar 7.1:
        const scope: string = `aid:${headAnalysisId}`;
        const query: string = `aid:${headAnalysisId} DIFFERENCE aid:${baseAnalysisId}`;
        const options2: CSHubSarifSearchOptions = (options === undefined) ? {} : Object.assign({}, options);
        // Ensure artifacts table is disabled by default:
        if (options2.artifactListing === undefined) {
            options2.artifactListing = false;
        }
        let sarifAnalysisUrlPath: string = `/warning_detail_search.sarif?scope=${encodeURIComponent(scope)}&query=${encodeURIComponent(query)}`;
        const queryString: string|undefined = this._makeSarifQueryString(options2);
        if (queryString) {
            sarifAnalysisUrlPath += '&' + queryString;
        }
        return this.fetch(sarifAnalysisUrlPath);
    }

}
