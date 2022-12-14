/** An object that facilitates access to a CodeSonar hub. */
import { strict as assert } from 'node:assert';
import { readFile } from 'fs/promises';
import { Readable } from 'stream';

import { CancellationSignal } from './common_utils';
import {
    errorToString,
    errorToMessageCode,
    ErrorMessageCode,
    ECONNREFUSED_CODE,
    ECONNRESET_CODE,
    EPROTO_CODE,
} from './errors_ex';
import { Logger } from './logger';
import { 
    ignoreStream,
    readTextStream,
} from './stream_ex';

import { 
    encodeURIQuery,
    HTTP_OK,
    HTTP_MOVED_PERMANENTLY,
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
    CSHubAuthenticationMethod,
    CSHubUserKey,
    CSAnalysisId,
    CSProjectId,
    parseCSAnalysisId,
    parseCSProjectId,
} from './csonar_ex';


const FORM_URLENCODED_CONTENT_TYPE: string = "application/x-www-form-urlencoded";

const RESPONSE_TRY_PLAINTEXT: string = "response_try_plaintext";


export interface CSProjectInfo {
    id: CSProjectId;
    name: string;
    path: string;
}

export interface CSAnalysisInfo {
    id: CSAnalysisId;
    name: string;
}

enum CSHubResponseFormat {
    html = "text/html",
    text = "text/plain",
    json = "application/json",
}

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
 *  @property {string} clientName  name of client program as recognized by the hub.
 *  @property {string} clientVersion  version of client to report to hub.
 *  @property {string} cafile  path to a Certificate Authority certificate file in PEM format to use for verifying the hub server.
 *  @property {number} timeout  socket timeout in milliseconds.
 */
export interface CSHubClientConnectionOptions extends CSHubAuthenticationOptions {
    clientName?: string;
    clientVersion?: string;
    cafile?: string;
    timeout?: number;
}

/** Per-request options. */
export interface CSHubClientRequestOptions {
    cancellationSignal?: CancellationSignal;
}

/** Options for warning search in SARIF format. */
export interface CSHubSarifSearchOptions extends CSHubClientRequestOptions {
    warningFilter?: string;
    indentLength?: number;
    artifactListing?: boolean;
}

type CSHubParamBoolean = "0" | "1";
type CSHubSignInFormBoolean = CSHubParamBoolean;

const CS_HUB_PARAM_TRUE: CSHubParamBoolean = "1";
const CS_HUB_PARAM_FALSE: CSHubParamBoolean = "0";

/** Sign-In form fields used by CodeSonar 7.1 and earlier. */
interface CSHub700SignInForm {
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

/** Response from '/command/check_version/$client/' */
export interface CSHubVersionCompatibilityInfo {
    hubVersion: string;
    hubVersionNumber: number;
    hubProtocol: number;
    clientOK?: boolean|null;
    message?: string;
    capabilities?: {
        openapi?: boolean,
    };
}

/** Summarizes hub capabilities extracted from CSHubVersionCompatibilityInfo. */
export interface CSHubCapabilityInfo {
    hubVersionString: string;
    hubVersionNumber: number;
    openAPI: boolean;
    resultLimiting: boolean;
    sarifSearch: boolean;
}

interface CSHubJsonErrorResponse {
    "error": string,
    "status": number,
}

enum CSHubSessionKeyType {
    cookie = "cookie",
    bearerToken = "bearer",
}

interface CSHubSessionInfo {
    bearer: string,
}

/** Defines the generic result of a Hub API search. */
interface CSHubApiSearchResults<T> {
    rows?: Array<T>;
}

/** Defines a subset of project_search JSON row for CodeSonar hub 7.1 and earlier. */
interface CSHub700ProjectRow {
    /* eslint-disable @typescript-eslint/naming-convention */
    "Project ID"?: number;
    "Project"?: string;
    "Path"?: string;
    /* eslint-enable @typescript-eslint/naming-convention */
}

/** Defines a subset of analysis JSON row from project endpoint for CodeSonar hub 7.1 and earlier. */
interface CSHub700AnalysisRow {
    /* eslint-disable @typescript-eslint/naming-convention */
    "Analysis"?: string;
    "url"?: string;
    /* eslint-enable @typescript-eslint/naming-convention */
}

/** Defines a subset of project_search JSON row. */
interface CSHubProjectRow {
    projectId?: number;
    project?: string;
    path?: string;
}

/** Defines a subset of analysis JSON row from project endpoint. */
interface CSHubAnalysisRow {
    analysis?: string;
    url?: string;
}

function formatBasicAuthHeaderValue(user: string, password: string): string{
    return "Basic " + Buffer.from(`${user}:${password}`, 'binary').toString('base64');
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

/** Extract hub feature capabilities from a hub compatibility object. */
export function getHubCapabilityInfo(compatibilityInfo: CSHubVersionCompatibilityInfo|null|undefined): CSHubCapabilityInfo {
    const capabilityInfo: CSHubCapabilityInfo = {
            hubVersionString: "",
            hubVersionNumber: 0,
            openAPI: false,
            resultLimiting: false,
            sarifSearch: false,
        };
    if (compatibilityInfo) {
        capabilityInfo.hubVersionString = compatibilityInfo.hubVersion;
        capabilityInfo.hubVersionNumber = compatibilityInfo.hubVersionNumber;
        if (compatibilityInfo?.capabilities?.openapi === true) {
            capabilityInfo.openAPI = true;
        }
        if (compatibilityInfo.hubVersionNumber > 700) {
            capabilityInfo.resultLimiting = true;
            capabilityInfo.sarifSearch = true;
        }
    }
    return capabilityInfo;
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
    // undefined means we haven't tried to fetch compatibility info yet,
    // null means we tried to fetch it and we got a 404:
    private hubVersionCompatibilityInfo: CSHubVersionCompatibilityInfo|null|undefined;

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
    async getHttpClientConnection(options?: CSHubClientRequestOptions): Promise<HTTPClientConnection> {
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
            if ((hubOptions.auth === undefined
                    || hubOptions.auth === CSHubAuthenticationMethod.certificate
                ) && hubOptions.hubkey !== undefined
            ) {
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
                const requestOptions: HTTPClientRequestOptions = {
                        method: "HEAD",
                    };
                if (options !== undefined && options.cancellationSignal !== undefined) {
                    requestOptions.cancellationSignal = options.cancellationSignal;
                }
                const testResource: string = "/";
                this.log("Testing if hub uses HTTPS...");
                let httpConn2: HTTPClientConnection = new HTTPClientConnection(httpOptions);
                try {
                    let resp: HTTPReceivedResponse = await httpConn2.request(testResource, requestOptions);
                    await new Promise<void>((
                            resolve: () => void,
                            reject: (e: any) => void,
                        ) => {
                        resp.body.on('end', resolve);
                        resp.body.on('error', reject);
                        resp.body.resume();
                    });
                    if (resp.status.code === HTTP_MOVED_PERMANENTLY) {
                        // MOVED PERMANENTLY
                        // Hub is asking us to redirect, so try HTTP.
                        protocol = HTTP_PROTOCOL;
                    }
                }
                catch (e: unknown) {
                    this.log(e);
                    const ecode: ErrorMessageCode = errorToMessageCode(e) || '';
                    // EPROTO error occurs if we try to speak in HTTPS to an HTTP hub:
                    // ECONNREFUSED occurs if default port number is used and HTTPS port is not open
                    if ((ecode !== EPROTO_CODE) && (ecode !== ECONNREFUSED_CODE)) {
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
        errorFormat: CSHubResponseFormat|undefined,
    ): Promise<HTTPStatusError> {
        const maxErrorMessageLength: number = 4096;
        let hubError: HTTPStatusError = resp.status;
        if (errorFormat === undefined
            || errorFormat === CSHubResponseFormat.text
            || errorFormat === CSHubResponseFormat.json
        ) {
            const responseText: string = await readTextStream(resp.body, maxErrorMessageLength);
            if (responseText.startsWith("<!DOCTYPE")) {
                // Assume the response was HTML, we won't try to use it:
                this.log("Hub returned HTML, but plaintext was expected");
            }
            else {
                // After CodeSonar 7.1, errors might be returned in JSON format:
                let errorMessage: string = responseText;
                if (errorFormat === undefined || errorFormat === CSHubResponseFormat.json) {
                    try {
                        const respJson: unknown = JSON.parse(responseText);
                        const respError: CSHubJsonErrorResponse = respJson as CSHubJsonErrorResponse;
                        if (respError.error) {
                            errorMessage = respError.error;
                        }
                    }
                    catch (e: unknown) {
                        if (e instanceof SyntaxError) {
                            // Ignore; the response was not valid JSON,
                            //  assume the response is plain text.
                        }
                        else {
                            this.logError("Attempted to parse hub response as JSON and got error: " + errorToString(e));
                        }
                    }
                }
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

    private toHTTPClientRequestOptions(options?: CSHubClientRequestOptions): HTTPClientRequestOptions|undefined {
        let httpOptions: HTTPClientRequestOptions|undefined;
        if (options !== undefined) {
            httpOptions = {};
            if (options.cancellationSignal !== undefined) {
                httpOptions.cancellationSignal = options.cancellationSignal;
            }
        }

        return httpOptions;
    }

    /** Post raw data to the hub. */
    private async post(
        resource: string,
        data: string,
        httpOptions?: HTTPClientRequestOptions,
        errorFormat?: CSHubResponseFormat,
        contentType: string = FORM_URLENCODED_CONTENT_TYPE,
    ): Promise<Readable> {
        const httpConn: HTTPClientConnection = await this.getHttpClientConnection();
        const httpOptions2: HTTPClientRequestOptions = { 
            method: "POST",
            headers: {
                /* eslint-disable @typescript-eslint/naming-convention */
                "Accept-Charset": "utf-8",
                "Content-Type": contentType,
                /* eslint-enable @typescript-eslint/naming-convention */
            },
        };
        if (httpOptions) {
            if (httpOptions.headers !== undefined
                && httpOptions2.headers !== undefined  // needed for typechecker only
            ) {
                for (let headerName of Object.keys(httpOptions.headers)) {
                    httpOptions2.headers[headerName] = httpOptions.headers[headerName];
                }
            }
            if (httpOptions.timeout) {
                httpOptions2.timeout = httpOptions.timeout;
            }
        }
        const resourceUrl: URL = httpConn.resourceURL(resource);
        let errorFormat2: CSHubResponseFormat|undefined = errorFormat;
        if (errorFormat2 === undefined) {
            if (getHubCapabilityInfo(this.hubVersionCompatibilityInfo).openAPI) {
                errorFormat2 = CSHubResponseFormat.json;
            }
            else {
                // Parse the URL so we can learn if it is okay to read the response for error information.
                //  This is somewhat inefficient
                //   since we could require the caller to tell us explicitly,
                //   but this method seems to be more convenient for the caller.
                const responseTryPlaintextValue: string|null = resourceUrl.searchParams.get(RESPONSE_TRY_PLAINTEXT);
                const responseTryPlaintextBoolean: boolean|undefined = parseCSHubParamBoolean(responseTryPlaintextValue);
                if (responseTryPlaintextBoolean === true) {
                    errorFormat2 = CSHubResponseFormat.text;
                }
                else {
                    errorFormat2 = CSHubResponseFormat.html;
                }
            }
        }
        this.log(`Posting resource to ${resource}`);
        // The hub will return HTTP 501 if Transfer-Encoding header is set.
        // To avoid this, we must ensure Content-Length header is set.
        // We assume that the httpConn.request() method will do this for us:
        const resp: HTTPReceivedResponse = await httpConn.request(resourceUrl, httpOptions2, data);
        if (resp.status.code !== HTTP_OK) {
            this.log(`HTTP Status: ${resp.status}`);
            const hubError: Error = await this.createHubRequestError(resp, errorFormat2);
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
     public async signIn(options?: CSHubClientRequestOptions): Promise<string|undefined> {
        // Send sign-in POST request to a page that produces a short response:
        const successMessage: string|undefined = undefined;
        let signInMessage: string|undefined = undefined;
        // CodeSonar 7.1 and earlier:
        //  response_try_plaintext must be in URL, or it won't work.
        //  The manual implies it will be respected in the POST data too,
        //   but that doesn't seem to work.
        //  We will do both just to be safe.
        const signInUrlPath700: string = `/?${RESPONSE_TRY_PLAINTEXT}=${CS_HUB_PARAM_TRUE}`;
        const sessionKeyType: CSHubSessionKeyType = CSHubSessionKeyType.bearerToken;
        const connOptions: CSHubClientConnectionOptions = this.options;
        let httpOptions: HTTPClientRequestOptions|undefined = this.toHTTPClientRequestOptions(options);
        let signInUrlPath: string|undefined = undefined;
        let signInData: string|undefined = undefined;
        let isSessionResource: boolean = false;
        let isCertificateAuth: boolean = false;
        const hubCapabilityInfo: CSHubCapabilityInfo = await this.getHubCapabilityInfo();
        if ((connOptions.auth === undefined && connOptions.hubkey !== undefined)
            || connOptions.auth === CSHubAuthenticationMethod.certificate
        ) {
            isCertificateAuth = true;
            if (connOptions.hubkey === undefined) {
                throw new Error("Certificate authentication mode was selected, but certificate and key were not provided.");
            }
            if (hubCapabilityInfo.openAPI) {
                signInUrlPath = "/session/create-tls-client-certificate/";
                signInData = `key=${sessionKeyType}`;
                isSessionResource = true;
            }
            else {
                signInUrlPath = signInUrlPath700;
                const sif: CSHub700SignInForm = {
                    /* eslint-disable @typescript-eslint/naming-convention */
                    sif_sign_in: CS_HUB_PARAM_TRUE,
                    sif_ignore_empty_email: CS_HUB_PARAM_TRUE,
                    sif_log_out_competitor: CS_HUB_PARAM_TRUE,
                    response_try_plaintext: CS_HUB_PARAM_TRUE,
                    sif_use_tls: CS_HUB_PARAM_TRUE,
                    /* eslint-enable @typescript-eslint/naming-convention */
                };
                signInData = encodeURIQuery(sif);
            }
        }
        else if ((connOptions.auth === undefined && connOptions.hubuser)
            || (connOptions.auth === CSHubAuthenticationMethod.password)
        ) {
            if (!connOptions.hubuser) {
                throw new Error("Password authentication mode was selected, but user name was not provided.");
            }
            const hubUser: string = connOptions.hubuser;
            let passwordPromise: Promise<string>|undefined; 
            if (connOptions.hubpasswd) {
                passwordPromise = connOptions.hubpasswd();
            }
            else if (connOptions.hubpwfile) {
                passwordPromise = readFile(connOptions.hubpwfile, {encoding:"utf-8"}).then(
                        fileContent => fileContent.trim());
            }
            if (passwordPromise === undefined) {
                throw new Error("Hub user password was not provided.");
            } else {
                const password: string = await passwordPromise;
                if (hubCapabilityInfo.openAPI) {
                    const basicAuthHeaders: Record<string,string> = {
                        /* eslint-disable @typescript-eslint/naming-convention */
                        "Authorization": formatBasicAuthHeaderValue(hubUser, password),
                        /* eslint-enable @typescript-eslint/naming-convention */
                    };
                    let headers2: Record<string,string> = {};
                    let httpOptions2: HTTPClientRequestOptions = {};
                    if (httpOptions !== undefined) {
                        Object.assign(httpOptions2, httpOptions);
                        if (httpOptions.headers !== undefined) {
                            Object.assign(headers2, httpOptions.headers);
                        }
                    }
                    Object.assign(headers2, basicAuthHeaders);
                    httpOptions2.headers = headers2;
                    // swap:
                    httpOptions = httpOptions2;
                    signInUrlPath = "/session/create-basic-auth/";
                    signInData = `key=${sessionKeyType}`;
                    isSessionResource = true;
                }
                else {
                    signInUrlPath = signInUrlPath700;
                    const sif: CSHub700SignInForm = {
                        /* eslint-disable @typescript-eslint/naming-convention */
                        sif_sign_in: CS_HUB_PARAM_TRUE,
                        sif_ignore_empty_email: CS_HUB_PARAM_TRUE,
                        sif_log_out_competitor: CS_HUB_PARAM_TRUE,
                        response_try_plaintext: CS_HUB_PARAM_TRUE,
                        sif_username: connOptions.hubuser,
                        sif_password: password,
                        /* eslint-enable @typescript-eslint/naming-convention */
                    };
                    signInData = encodeURIQuery(sif);
                }
            }
        }
        else if (connOptions.auth === undefined || connOptions.auth === CSHubAuthenticationMethod.anonymous) {
            const httpConn: HTTPClientConnection = await this.getHttpClientConnection(options);
            this.clearSignInCookies(httpConn);
            httpConn.bearerToken = undefined;
            if (hubCapabilityInfo.openAPI) {
                signInUrlPath = "/session/create-anonymous/";
                signInData = `key=${sessionKeyType}`;
                isSessionResource = true;
            } else {
                // For older hubs, we just needed to drop any session cookies that we might already have.
                //  We don't need to visit an explicit sign-in page.
                signInMessage = successMessage;
            }
        }
        else {
            throw new Error("Could not determine hub authentication method.");
        }

        if (signInUrlPath !== undefined && signInData !== undefined) {
            this.log("Posting signin data...");
            // The hubcert and hubkey will be implicitly passed to the server in this POST method
            //  since they came from 'this.options'.
            try {
                const respBody: NodeJS.ReadableStream = await this.post(
                    signInUrlPath,
                    signInData,
                    httpOptions,
                );
                if (isSessionResource && sessionKeyType === CSHubSessionKeyType.bearerToken) {
                    const sessionResourceMaxLength: number = 65536;
                    const respText: string = await readTextStream(respBody, sessionResourceMaxLength);
                    const respJson: unknown = JSON.parse(respText);
                    const sessionInfo: CSHubSessionInfo = respJson as CSHubSessionInfo;
                    const httpConn: HTTPClientConnection = await this.getHttpClientConnection(options);
                    this.log("Using bearer token authorization.");
                    httpConn.bearerToken = sessionInfo.bearer;
                }
                else {
                    await ignoreStream(respBody);
                }
            }
            catch (e: unknown) {
                if ((e instanceof CSHubRequestError)
                    && e.code !== undefined
                    && e.code === HTTP_FORBIDDEN
                ) {
                    // Ordinary signin failure:
                    signInMessage = e.message;
                } else {
                    const ecode: ErrorMessageCode|undefined = errorToMessageCode(e);
                    if (isCertificateAuth && ecode === ECONNRESET_CODE) {
                        // Rejected TLS certificate results in a socket error,
                        //  assume that the certificate is the reason for the connection reset:
                        throw new CSHubRequestError("Certificate authentication failed.  Connection reset.", 0);
                    }
                    else {                        
                        throw e;
                    }
                }
            }
        }
        return signInMessage;
    }

    /** Fetch a raw resource from the hub. */
    public fetch(
        resource: string,
        options?: CSHubClientRequestOptions,
    ): Promise<Readable> {
        const httpOptions: HTTPClientRequestOptions|undefined = this.toHTTPClientRequestOptions(options);
        return new Promise<Readable>((
                resolve: (resIO: Readable) => void,
                reject: (e: unknown) => void,
            ) => {
                this.getHttpClientConnection(options).then((
                    httpConn: HTTPClientConnection,
                ): Promise<HTTPReceivedResponse> => {
                    this.log(`Fetching resource ${resource}`);
                    return httpConn.request(resource, httpOptions);
                }).then((resp: HTTPReceivedResponse): void => {
                    if (resp.status.code === HTTP_OK) {
                        this.log("Received OK response");
                        resolve(resp.body);
                    }
                    else {
                        this.log(`HTTP Status: ${resp.status}`);
                        let errorFormat: CSHubResponseFormat|undefined = undefined;
                        if (getHubCapabilityInfo(this.hubVersionCompatibilityInfo).openAPI) {
                            errorFormat = CSHubResponseFormat.json;
                        } else {
                            // CodeSonar 7.1 and earlier:
                            // Check URL to see if text response was requested:
                            const responseTryPlaintextValue: string|null = resp.url.searchParams.get(RESPONSE_TRY_PLAINTEXT);
                            const responseTryPlaintextBoolean: boolean|undefined = parseCSHubParamBoolean(responseTryPlaintextValue);
                            if (responseTryPlaintextBoolean) {
                                errorFormat = CSHubResponseFormat.text;
                            }
                        }
                        this.createHubRequestError(
                            resp,
                            errorFormat,
                        ).then(reject).catch(reject);
                    }
                }).catch(reject);
            });
    }

    /** Fetch an untyped JSON object from the hub. */
    private async fetchJson(
        resource: string,
        options?: CSHubClientRequestOptions,
    ): Promise<unknown> {
        const resIO = await this.fetch(resource, options);
        return await this.parseResponseJson(resIO);
    }

    /** Try to fetch hub and client version compatibility information.
     * 
     *  @returns version compatibility information if available.
     *   CodeSonar hubs prior to v7.1 do not provide this information
    */
    private async fetchVersionCompatibilityInfo(
        clientName: string,
        clientVersion: string,
        options?: CSHubClientRequestOptions,
    ): Promise<CSHubVersionCompatibilityInfo|undefined> {
        const versionCheckResource: string = (
            `/command/check_version/${encodeURIComponent(clientName)}/`
            + `?version=${encodeURIComponent(clientVersion)}`
            + `&capability=openapi`
        );
        let respResult: CSHubVersionCompatibilityInfo|undefined;
        try {
            const respJson: unknown = await this.fetchJson(versionCheckResource, options);
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

    /** Get hub and client version compatibility information.
     * 
     *  Fetches the information one time and stores it internally.
     * 
     *  @returns version compatibility information if available.
     *   CodeSonar hubs prior to v7.1 do not provide this information
    */
     public async getVersionCompatibilityInfo(
        options?: CSHubClientRequestOptions,
    ): Promise<CSHubVersionCompatibilityInfo|undefined> {
        let hubVersionCompatibilityInfo: CSHubVersionCompatibilityInfo|undefined;
        if (this.hubVersionCompatibilityInfo === null) {
            // null signals that we have already tried to fetch the data,
            //  we won't try to fetch it again.
            // Return undefined to the caller;
            //  they don't need to know how we are using "null" internally.
            hubVersionCompatibilityInfo = undefined;
        }
        else if (this.hubVersionCompatibilityInfo !== undefined) {
            hubVersionCompatibilityInfo = this.hubVersionCompatibilityInfo;
        }
        else {
            if (this.options.clientName === undefined) {
                throw Error("Hub connection clientName option is required.");
            }
            if (this.options.clientVersion === undefined) {
                throw Error("Hub connection clientVersion option is required.");
            }
            const clientName: string = this.options.clientName;
            const clientVersion: string = this.options.clientVersion;
            hubVersionCompatibilityInfo = await this.fetchVersionCompatibilityInfo(clientName, clientVersion, options);
            if (hubVersionCompatibilityInfo === undefined) {
                // Store null so we know that we already tried to fetch the info:
                this.hubVersionCompatibilityInfo = null;
            }
            else {
                this.hubVersionCompatibilityInfo = hubVersionCompatibilityInfo;
            }
        }
        return hubVersionCompatibilityInfo;
    }

    /** Get information about hub feature capabilities. */
    private async getHubCapabilityInfo(): Promise<CSHubCapabilityInfo> {
        const compatibilityInfo: CSHubVersionCompatibilityInfo|undefined = await this.getVersionCompatibilityInfo();
        return getHubCapabilityInfo(compatibilityInfo);
    }

    /** Fetch a list of analysis projects. */
    public async fetchProjectInfo(
        searchProject?: string,
        options?: CSHubClientRequestOptions,
        resultCountMaximum?: number|undefined,
    ): Promise<CSProjectInfo[]> {
        const PTREE_SEP: string = "/";
        let projectSearchUrlPath = "/project_search.json";
        const queryParams: Record<string, string> = {};
        const hubCapabilityInfo: CSHubCapabilityInfo = await this.getHubCapabilityInfo();
        if (hubCapabilityInfo.openAPI) {
            const paramJson: {
                "orderBy": Record<string,string>[],
                "visible": Record<string,boolean>,
                "limit"?: number,
            } = {
                "orderBy": [{"projectId": "ASCENDING"}], 
                "visible": {"projectId": true, "path": true},
            };
            if (resultCountMaximum !== undefined) {
                paramJson["limit"] = resultCountMaximum;
            }
            queryParams["sprjgrid"] = JSON.stringify(paramJson);
        }
        else {
            let paramString: string = "[project id.sort:asc][project id.visible:1][path.visible:1]";
            if (hubCapabilityInfo.resultLimiting && resultCountMaximum !== undefined) {
                paramString += `[limit:${resultCountMaximum}]`;
            }
            queryParams["sprjgrid"] = paramString;
            queryParams[RESPONSE_TRY_PLAINTEXT] = CS_HUB_PARAM_TRUE;
        }
        if (searchProject) {
            const projectSearchLiteral: string = encodeCSSearchStringLiteral(searchProject);
            let projectFieldName: string = "project";
            if (searchProject.indexOf(PTREE_SEP) >= 0) {
                // If it contains a separator, assume it is a path:
                projectFieldName = "ptree_path";
            }
            queryParams["query"] = `${projectFieldName}=${projectSearchLiteral}`;
        }
        projectSearchUrlPath += "?" + encodeURIQuery(queryParams);
        const respJson: unknown = await this.fetchJson(projectSearchUrlPath, options);
        let respResults: CSHubApiSearchResults<CSHubProjectRow>|undefined;
        if (hubCapabilityInfo.openAPI) {
            respResults = respJson as CSHubApiSearchResults<CSHubProjectRow>;
        }
        else {
            // Convert old-style row to new:
            const respResults700: CSHubApiSearchResults<CSHub700ProjectRow> = respJson as CSHubApiSearchResults<CSHub700ProjectRow>;
            const respRows: CSHubProjectRow[] = [];
            if (respResults700.rows !== undefined) {
                const respRows700: CSHub700ProjectRow[] = respResults700.rows;
                for (let row700 of respRows700) {
                    respRows.push({
                        "projectId": row700["Project ID"],
                        "project": row700["Project"],
                        "path": row700["Path"],
                    });
                }
            }
            respResults = { rows: respRows };
        }
        this.log("Received project JSON");
        let projectInfoArray: CSProjectInfo[] = [];
        if (respResults && respResults.rows !== undefined) {
            const respRows: CSHubProjectRow[] = respResults.rows;
            // TODO: the "Project ID" number may be too large for javascript.
            //  We cannot parse the project ID from the "url" item,
            //   since the "url" is for the latest analysis; not the project page.
            for (let row of respRows) {
                //this.log(row);
                const projectIdNum: number|undefined = row["projectId"];
                const projectName: string|undefined = row["project"];
                const projectPath: string|undefined = row["path"];
                let projectId: CSProjectId|undefined;
                if (projectIdNum !== undefined) {
                    projectId = parseCSProjectId(projectIdNum);
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
    public async fetchAnalysisInfo(
        projectId: CSProjectId,
        options?: CSHubClientRequestOptions,
        resultCountMaximum?: number|undefined,
    ): Promise<CSAnalysisInfo[]> {
        let analysisListUrlPath: string = `/project/${encodeURIComponent(projectId)}.json`;
        const queryParams: Record<string, string> = {};
        const hubCapabilityInfo: CSHubCapabilityInfo = await this.getHubCapabilityInfo();
        if (hubCapabilityInfo.openAPI) {
            const paramJson: {
                "orderBy": Record<string,string>[],
                "limit"?: number,
            } = {
                "orderBy": [{"analysisId": "DESCENDING"}]
            };
            if (resultCountMaximum !== undefined) {
                paramJson["limit"] = resultCountMaximum;
            }
            queryParams["anlgrid"] = JSON.stringify(paramJson);
        }
        else {
            let paramString: string = "[analysis id.sort:desc]";
            if (resultCountMaximum !== undefined && hubCapabilityInfo.resultLimiting) {
                paramString += `[limit:${resultCountMaximum}]`;
            }
            queryParams["anlgrid"] = paramString;
            queryParams[RESPONSE_TRY_PLAINTEXT] = CS_HUB_PARAM_TRUE;
        }
        analysisListUrlPath += "?" + encodeURIQuery(queryParams);
        const respJson: unknown = await this.fetchJson(analysisListUrlPath, options);
        let respResults: CSHubApiSearchResults<CSHubAnalysisRow>|undefined;
        if (hubCapabilityInfo.openAPI) {
            respResults = respJson as CSHubApiSearchResults<CSHubAnalysisRow>;
        }
        else {
            // Convert old-style row to new:
            const respResults700: CSHubApiSearchResults<CSHub700AnalysisRow> = respJson as CSHubApiSearchResults<CSHub700AnalysisRow>;
            const respRows: CSHubAnalysisRow[] = [];
            if (respResults700.rows !== undefined) {
                const respRows700: CSHub700AnalysisRow[] = respResults700.rows;
                for (let row700 of respRows700) {
                    respRows.push({
                        "url": row700["url"],
                        "analysis": row700["Analysis"],
                    });
                }
            }
            respResults = { rows: respRows };
        }
        let analysisInfoArray: CSAnalysisInfo[] = [];
        if (respResults && respResults.rows !== undefined) {
            const respRows: CSHubAnalysisRow[] = respResults.rows;
            // Parse ID out of "url" item as a string:
            const analysisIdRegExp: RegExp = new RegExp("/analysis/(\\d+)\\.json");
            for (let row of respRows) {
                let analysisIdString: string|undefined;
                const analysisUrlString: string|undefined = row["url"];
                const analysisName: string|undefined = row["analysis"];
                if (analysisUrlString) {
                    const analysisIdMatch = analysisUrlString.match(analysisIdRegExp);
                    if (analysisIdMatch && analysisIdMatch.length > 1) {
                        analysisIdString = analysisIdMatch[1];
                    }
                }
                if (analysisIdString !== undefined && analysisName !== undefined) {
                    const analysisId: CSAnalysisId = parseCSAnalysisId(analysisIdString);
                    analysisInfoArray.push({
                        id: analysisId,
                        name: analysisName,
                    });
                }
            }
        }
        return analysisInfoArray;
    }

    private _makeSarifQueryString(
            hubCapabilityInfo: CSHubCapabilityInfo,
            options: CSHubSarifSearchOptions|undefined,
    ): string|undefined {
        const sarifIndentLength: number|undefined = options?.indentLength;
        const sarifArtifactListing: boolean|undefined = options?.artifactListing;
        const warningFilter: string|undefined = options?.warningFilter;
        let queryParams: Record<string,string> = {};
        if (warningFilter) {
            queryParams["filter"] = warningFilter;
        }
        if (sarifIndentLength !== undefined) {
            let sarifIndentArg: string = "";
            if (sarifIndentLength >= 0) {
                sarifIndentArg = sarifIndentLength.toString();
            }
            queryParams["indent"] = sarifIndentArg;
        }
        if (sarifArtifactListing !== undefined) {
            const sarifArtifactListingArg: string = (sarifArtifactListing) ? "1" : "0";
            queryParams["artifacts"] = sarifArtifactListingArg;
        }
        if (hubCapabilityInfo.openAPI) {
            queryParams[RESPONSE_TRY_PLAINTEXT] = CS_HUB_PARAM_TRUE;
        }

        return encodeURIQuery(queryParams);;
    }

    /** Fetch SARIF results for a single analysis. */
    public async fetchSarifAnalysisStream(
            analysisId: CSAnalysisId,
            options?: CSHubSarifSearchOptions,
            ): Promise<Readable>
    {
        const hubCapabilityInfo: CSHubCapabilityInfo = await this.getHubCapabilityInfo();
        let sarifAnalysisUrlPath: string = `/analysis/${encodeURIComponent(analysisId)}-allwarnings.sarif`;
        const queryString: string|undefined = this._makeSarifQueryString(hubCapabilityInfo, options);
        if (queryString) {
            sarifAnalysisUrlPath += '?' + queryString;
        }
        return this.fetch(sarifAnalysisUrlPath, options);
    }

    /** Fetch SARIF results from a single analysis that are not present in a second, base analysis. */
    public async fetchSarifAnalysisDifferenceStream(
            headAnalysisId: CSAnalysisId,
            baseAnalysisId: CSAnalysisId,
            options?: CSHubSarifSearchOptions,
            ): Promise<Readable>
    {
        const hubCapabilityInfo: CSHubCapabilityInfo = await this.getHubCapabilityInfo();
        // warning_detail_search.sarif is not supported prior to CodeSonar 7.1:
        if (!hubCapabilityInfo.sarifSearch) {
            throw new Error("CodeSonar hub version 7.1 or later is required to get warning difference search results in SARIF format.");
        }
        const scope: string = `aid:${headAnalysisId}`;
        const query: string = `aid:${headAnalysisId} DIFFERENCE aid:${baseAnalysisId}`;
        const options2: CSHubSarifSearchOptions = (options === undefined) ? {} : Object.assign({}, options);
        // Ensure artifacts table is disabled by default:
        if (options2.artifactListing === undefined) {
            options2.artifactListing = false;
        }
        let sarifAnalysisUrlPath: string = `/warning_detail_search.sarif?scope=${encodeURIComponent(scope)}&query=${encodeURIComponent(query)}`;
        const queryString: string|undefined = this._makeSarifQueryString(hubCapabilityInfo, options2);
        if (queryString) {
            sarifAnalysisUrlPath += '&' + queryString;
        }
        return this.fetch(sarifAnalysisUrlPath, options2);
    }

}
