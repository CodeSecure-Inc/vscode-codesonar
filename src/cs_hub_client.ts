/** An object that facilitates access to a CodeSonar hub. */
import { readFile } from 'fs/promises';

import { errorToString } from './common_utils';
import { Logger } from './logger';

import { 
    encodeURIQuery,
    HTTPClientConnection,
    HTTPClientConnectionOptions,
    HTTPClientRequestOptions,
    HTTPReceivedResponse,
    HTTPStatusError,
} from './http_client';


type CSHubRecordId = string;
export type CSAnalysisId = CSHubRecordId;
export type CSProjectId = CSHubRecordId;

export interface CSProjectInfo {
    id: CSProjectId;
    name: string;
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
    hubcert?: string;
    hubkey?: string;
}

/** Options for creating a connection to a CodeSonar hub.
 *
 *  @property {string} cafile  path to a Certificate Authority certificate file in PEM format to use for verifying the hub server.
 */
export interface CSHubClientConnectionOptions extends CSHubAuthenticationOptions {
    cafile?: string;
}

type CSHubSignInFormBoolean = "no" | "yes";

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

/** Defines the generic result of a Hub API search. */
interface CSHubApiSearchResults<T> {
    rows?: Array<T>
}

/** Defines a subset of project_search JSON row. */
interface CSHubProjectRow {
    /* eslint-disable @typescript-eslint/naming-convention */
    "Project ID"?: number,
    "Project"?: string,
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

/** A parsed CodeSonar hub address.
 *  
 *  Like a simplified URL, but the protocol is optional.
 */
export class CSHubAddress {
    private readonly hubAddressString: string;
    public readonly protocol: string|undefined;
    public readonly hostname: string;
    public readonly port: number|undefined;

    constructor(hubAddressString: string) {
        const PORTSEP: string = ":";
        let addressIsUrl: boolean = false;
        if (hubAddressString.toLowerCase().startsWith("http://")) {
            addressIsUrl = true;
        }
        else if (hubAddressString.toLowerCase().startsWith("https://")) {
            addressIsUrl = true;
        }
        this.hubAddressString = hubAddressString;
        if (addressIsUrl) {
            let hubUrl: URL = new URL(hubAddressString);
            this.protocol = hubUrl.protocol;
            this.hostname = hubUrl.hostname;
            if (hubUrl.port) {
                this.port = parseInt(hubUrl.port);
            }
        }
        else {
            let pos = hubAddressString.indexOf(PORTSEP);
            if (pos < 0) {
                this.hostname = hubAddressString;
            }
            else {
                this.hostname = hubAddressString.substring(0, pos);
                let portString: string = hubAddressString.substring(pos + PORTSEP.length);
                this.port = parseInt(portString);
            }
        }
    }

    public toString(): string {
        return this.hubAddressString;
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
            let httpOptions: HTTPClientConnectionOptions = {
                hostname: this.hubAddress.hostname,
                port: this.hubAddress.port,
            };
            if (hubOptions.cafile) {
                httpOptions.ca = await readFile(hubOptions.cafile);
            }
            if (hubOptions.hubcert) {
                httpOptions.cert = await readFile(hubOptions.hubcert);
            }
            if (hubOptions.hubkey) {
                httpOptions.key = await readFile(hubOptions.hubkey);
            }
            // TODO get cert-key passphrase
            let protocol: string|undefined = this.hubAddress.protocol;
            if (protocol === undefined) {
                // Hub address did not include the protocol.
                //  Try to fetch home page over HTTPS first. Fallback to HTTP.
                // TODO: if we have a cafile, hubcert, or hubkey, then we can assume HTTPS always.
                protocol = "https";
                httpOptions.protocol = protocol;
                const testResource: string = "/";
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
                        protocol = "http";
                    }
                }
                catch (e: unknown) {
                    this.log(e);
                    // HTTPS did not work.
                    //  This could happen if the HTTPS certificate is not trusted.
                    //  Assume HTTP:
                    protocol = "http";
                }
            }
            httpOptions.protocol = protocol;
            this.httpConn = new HTTPClientConnection(httpOptions);
            this.httpConn.logger = this.logger;
        }
        return this.httpConn;
    }

    /** Read a JSON stream into a data structure. */
    private async parseResponseJson(resIO: NodeJS.ReadableStream): Promise<unknown> {
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
            contentType: string = "application/x-www-form-urlencoded",
        ): Promise<NodeJS.ReadableStream> {
        return new Promise<NodeJS.ReadableStream>((
            resolve: (respIO: NodeJS.ReadableStream) => void,
            reject: (e: any) => void,
        ) => {
            this.getHttpClientConnection().then(
                (httpConn: HTTPClientConnection): Promise<HTTPReceivedResponse> => {
                const httpOptions: HTTPClientRequestOptions = { 
                    method: "POST",
                    headers: {
                        /* eslint-disable @typescript-eslint/naming-convention */
                        "content-type": contentType,
                        /* eslint-enable @typescript-eslint/naming-convention */
                    },
                };
                this.log(`Posting resource to ${resource}`);
                // The hub will return HTTP 501 if Transfer-Encoding header is set.
                // To avoid this, we must ensure Content-Length header is set.
                // We assume that the httpConn.request() method will do this for us:
                return httpConn.request(resource, httpOptions, data);
            }).then((resp: HTTPReceivedResponse): void => {
                if (resp.status.code === 200) {
                    this.log("Received OK response");
                    resolve(resp.body);
                }
                else {
                    this.log(`HTTP Status: ${resp.status}`);
                    // TODO: sometimes, we will want the response body as a string
                    // Ignore the rest of the response stream:
                    resp.body.resume();
                    reject(resp.status);
                }
            },
            reject);
        });
    }

    private clearSignInCookies(httpConn: HTTPClientConnection): void {
        // This just clears all cookies from the HTTP client.
        //  We are assuming that the HTTP client doesn't store any other important cookies that should not be cleared.
        httpConn.clearCookies();
    }

    /** Try to sign-in to the hub using hub client credentials.
     *
     * @returns {Promise<boolean>}  Promise resolving to `true` if sign-in succeeded; `false` if credentials were rejected.
     */
    public async signIn(): Promise<boolean> {
        // Send sign-in POST request to a page that produces a short response:
        const signInUrlPath: string = "/";
        const options: CSHubClientConnectionOptions = this.options;
        return new Promise<boolean>((
            resolve: (succeeded: boolean) => void,
            reject: (e: any) => void,
        ) => {
            if ((options.auth === undefined || options.auth === "certificate")
                    && (options.hubcert || options.hubkey)
                ) {
                if (options.hubcert && options.hubkey) {
                    const sif: CSHubSignInForm = {
                        /* eslint-disable @typescript-eslint/naming-convention */
                        sif_sign_in: "yes",
                        sif_ignore_empty_email: "yes",
                        sif_log_out_competitor: "yes",
                        response_try_plaintext: "yes",
                        sif_use_tls: "yes",
                        /* eslint-enable @typescript-eslint/naming-convention */
                    };
                    const sifData: string = encodeURIQuery(sif);
                    this.log("Posting signin data...");
                    // TODO include hubcert and hubkey with POST
                    this.post(signInUrlPath, sifData).then((respBody: NodeJS.ReadableStream): void => {
                        // Ignore response body:
                        respBody.resume();
                        resolve(true);
                    }).catch((e: any): void => {
                        if ((e instanceof HTTPStatusError)
                                && e.code !== undefined
                                && e.code === 403) {
                            resolve(false);
                        } else {
                            reject(e);
                        }
                    });
                }
                else if (options.hubcert) {
                    reject(new Error("Missing hub user certificate private key."));
                }
                else {
                    reject(new Error("Missing hub user certificate."));
                }
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
                    passwordPromise.then((password: string): void => {
                        const sif: CSHubSignInForm = {
                            /* eslint-disable @typescript-eslint/naming-convention */
                            sif_sign_in: "yes",
                            sif_ignore_empty_email: "yes",
                            sif_log_out_competitor: "yes",
                            response_try_plaintext: "yes",
                            sif_username: options.hubuser,
                            sif_password: password,
                            /* eslint-enable @typescript-eslint/naming-convention */
                        };
                        const sifData: string = encodeURIQuery(sif);
                        this.log("Posting signin data...");
                        this.post(signInUrlPath, sifData).then(
                            (respBody: NodeJS.ReadableStream): void => {
                                // Ignore response body:
                                respBody.resume();
                                resolve(true);
                        }).catch((e: any): void => {
                            if ((e instanceof HTTPStatusError)
                                    && e.code !== undefined
                                    && e.code === 403) {
                                resolve(false);
                            } else {
                                reject(e);
                            }
                        });
                    }).catch(reject);
                }
            }
            else if (options.auth === undefined || options.auth === "anonymous") {
                // Simply drop existing sign-in cookie
                this.getHttpClientConnection().then(
                    (httpConn: HTTPClientConnection): void => {
                        this.clearSignInCookies(httpConn);
                        resolve(true);
                });
            }
            else {
                reject(new Error("Could not determine hub authentication method."));
            }
        });
    }

    /** Fetch a raw resource from the hub. */
    public async fetch(resource: string): Promise<NodeJS.ReadableStream> {
        return new Promise<NodeJS.ReadableStream>((
                resolve: (resIO: NodeJS.ReadableStream) => void,
                reject: (e: any) => void,
            ) => {
                this.getHttpClientConnection().then(
                    (httpConn: HTTPClientConnection): Promise<HTTPReceivedResponse> => {
                        this.log(`Fetching resource ${resource}`);
                            return httpConn.request(resource);
                }).then(resp => {
                    if (resp.status.code === 200) {
                        this.log("Received OK response");
                        resolve(resp.body);
                    }
                    else {
                        this.log(`HTTP Status: ${resp.status}`);
                        // TODO: read response body to get error details
                        reject(resp.status);
                    }
                });
            });
    }

    /** Fetch an untyped JSON object from the hub. */
    private async fetchJson(resource: string): Promise<unknown> {
        return this.fetch(resource).then(
            (resIO: NodeJS.ReadableStream): unknown => this.parseResponseJson(resIO));
    }

    public async fetchProjectInfo(searchProjectName?: string): Promise<CSProjectInfo[]> {
        const prjGridParams: string = "[project id.sort:asc][project id.visible:1][path.visible:1]";
        let projectSearchPath: string = "/project_search.json";
        projectSearchPath += `?sprjgrid=${encodeURIComponent(prjGridParams)}`;
        if (searchProjectName) {
            const projectSearchQuery: string = encodeURIComponent(`project=${encodeCSSearchStringLiteral(searchProjectName)}`);
            projectSearchPath += "&query=" + projectSearchQuery;
        }
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
                let projectId: CSProjectId|undefined;
                if (projectIdNum !== undefined) {
                    projectId = projectIdNum.toString();
                }
                if (projectId !== undefined && projectName !== undefined) {
                    projectInfoArray.push({
                        id: projectId,
                        name: projectName,
                    });
                }
            }
        }
        return projectInfoArray;
    }

    public async fetchAnalysisInfo(analysisId: CSAnalysisId): Promise<CSAnalysisInfo[]> {
        const analysisListPath: string = `/project/${encodeURIComponent(analysisId)}.json`;
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

    public async fetchSarifAnalysisStream(
            analysisId: CSAnalysisId,
            srcRootPath?: string,
            ): Promise<NodeJS.ReadableStream>
    {
        let sarifAnalysisUrlPath: string = `/analysis/${encodeURIComponent(analysisId)}-allwarnings.sarif?filter=1`;
        if (srcRootPath) {
            sarifAnalysisUrlPath += `&srcroot=${encodeURIComponent(srcRootPath)}`;
        }
        return this.fetch(sarifAnalysisUrlPath);
    }

    public async fetchSarifAnalysisDifferenceStream(
            headAnalysisId: CSAnalysisId,
            baseAnalysisId: CSAnalysisId,
            ): Promise<NodeJS.ReadableStream>
    {
        // warning_detail_search.sarif is not supported prior to CodeSonar 7.1:
        const scope: string = `aid:${headAnalysisId}`;
        const query: string = `aid:${headAnalysisId} DIFFERENCE aid:${baseAnalysisId}`;
        const sarifAnalysisUrlPath: string = `/warning_detail_search.sarif?scope=${encodeURIComponent(scope)}&query=${encodeURIComponent(query)}&artifacts=0&filter=1`;
        return this.fetch(sarifAnalysisUrlPath);
    }

}
