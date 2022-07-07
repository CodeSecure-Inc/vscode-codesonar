/** An object that facilitates access to a CodeSonar hub. */
import { readFile } from 'fs/promises';

import { 
    HTTPClientConnection,
    HTTPClientConnectionOptions,
    HTTPClientRequestOptions,
    encodeURIQuery,
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

/**
 * Encode a string literal term for a CodeSonar search.
 */
function encodeCSSearchStringLiteral(s: string): string {
    const QUOTE = '"';
    const QUOTE_ESC = '\\"';
    const APOS = "'";
    const APOS_ESC = "\\'";
    const ESC = "\\";
    const ESC_ESC = "\\\\";

    let charUnits = new Array();        
    charUnits.push(QUOTE);
    for (let i = 0; i < s.length; i++) {
        let ch = s[i];
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
        const PORTSEP = ":";
        let addressIsUrl: boolean = false;
        if (hubAddressString.toLowerCase().startsWith("http://")) {
            addressIsUrl = true;
        }
        else if (hubAddressString.toLowerCase().startsWith("https://")) {
            addressIsUrl = true;
        }
        this.hubAddressString = hubAddressString;
        if (addressIsUrl) {
            let hubUrl = new URL(hubAddressString);
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
                let portString = hubAddressString.substring(pos + PORTSEP.length);
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

    constructor(hubAddress: string|CSHubAddress, options?: CSHubClientConnectionOptions) {
        if (typeof hubAddress === 'string') {
            this.hubAddress = new CSHubAddress(hubAddress);
        }
        else {
            this.hubAddress = hubAddress;
        }
        this.options = options ?? {};
    }

    /** Get the underlying HTTP connection object.  Test for secure protocol if necessary. */
    async getHttpClientConnection(): Promise<HTTPClientConnection> {
        const hubOptions = this.options;
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
                const testResource = "/";
                let httpConn2 = new HTTPClientConnection(httpOptions);
                try {
                    let resp = await httpConn2.request(testResource, { method: "HEAD" });
                    await new Promise<void>((resolve, reject) => {
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
                catch (e) {
                    console.log(e);
                    // HTTPS did not work.
                    //  This could happen if the HTTPS certificate is not trusted.
                    //  Assume HTTP:
                    protocol = "http";
                }
            }
            httpOptions.protocol = protocol;
            this.httpConn = new HTTPClientConnection(httpOptions);
        }
        return this.httpConn;
    }

    private async parseResponseJson(resIO: NodeJS.ReadableStream): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            let chunks: string[] = [];
            resIO.setEncoding("utf8");
            resIO.on('data', (data) => {
                try {
                    chunks.push(data);
                } catch (e) {
                    console.error(e);
                }
            });
            resIO.on('end', () => {
                let responseText = chunks.join('');
                try {
                    let jsonObject = JSON.parse(responseText);
                    resolve(jsonObject);
                } catch (e) {
                    console.warn(e);
                    reject(e);
                }
            });
            resIO.on('error', (e) => {
                console.warn(e);
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
        return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
            this.getHttpClientConnection().then(httpConn => {
                const httpOptions: HTTPClientRequestOptions = { 
                    method: "POST",
                    headers: {
                        /* eslint-disable @typescript-eslint/naming-convention */
                        "content-type": contentType,
                        /* eslint-enable @typescript-eslint/naming-convention */
                    },
                };
                console.log(`Posting resource to ${resource}`);
                // The hub will return HTTP 501 if Transfer-Encoding header is set.
                // To avoid this, we must ensure Content-Length header is set.
                // We assume that the httpConn.request() method will do this for us:
                return httpConn.request(resource, httpOptions, data);
            }).then(resp => {
                if (resp.status.code === 200) {
                    console.log("Received OK response");
                    resolve(resp.body);
                }
                else {
                    console.log(`HTTP Status: ${resp.status}`);
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
        const signInUrlPath = "/";
        const options = this.options;
        return new Promise<boolean>((resolve, reject) => {
            if ((options.auth === undefined || options.auth === "certificate")
                    && (options.hubcert || options.hubkey)) {
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
                    const sifData = encodeURIQuery(sif);
                    console.log("Posting signin data...");
                    // TODO include hubcert and hubkey with POST
                    this.post(signInUrlPath, sifData).then((respBody) => {
                        // Ignore response body:
                        respBody.resume();
                        resolve(true);
                    }).catch(e => {
                        if (e.code !== undefined && e.code === 403) {
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
                    passwordPromise = readFile(options.hubpwfile, {encoding:"utf-8"});
                }
                if (passwordPromise === undefined) {
                    reject(new Error("Hub user password was not provided."));
                } else {
                    passwordPromise.then(password => {
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
                        const sifData = encodeURIQuery(sif);
                        console.log("Posting signin data...");
                        this.post(signInUrlPath, sifData).then((respBody) => {
                            // Ignore response body:
                            respBody.resume();
                            resolve(true);
                        }).catch(e => {
                            if (e.code !== undefined && e.code === 403) {
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
                this.getHttpClientConnection().then(httpConn => {
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
        return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
            this.getHttpClientConnection().then(httpConn => {
                console.log(`Fetching resource ${resource}`);
                return httpConn.request(resource);
            }).then(resp => {
                if (resp.status.code === 200) {
                    console.log("Received OK response");
                    resolve(resp.body);
                }
                else {
                    console.log(`HTTP Status: ${resp.status}`);
                    reject(resp.status);
                }
            });
        });
    }

    private async fetchJson(resource: string): Promise<any> {
        return this.fetch(resource).then(resIO => this.parseResponseJson(resIO));
    }

    public async fetchProjectInfo(searchProjectName?: string): Promise<CSProjectInfo[]> {
        // TODO: consider generalizing this method to share code with fetchProjectAnalyses
        let projectSearchPath = "/project_search.json";
        projectSearchPath += "?sprjgrid=" + encodeURIComponent("[project id.sort:asc][project id.visible:1][path.visible:1]");
        if (searchProjectName) {
            let projectSearchQuery = encodeURIComponent("project=" + encodeCSSearchStringLiteral(searchProjectName));
            projectSearchPath += "&query=" + projectSearchQuery;
        }
        let respJson = await this.fetchJson(projectSearchPath);
        console.log("Received project JSON");
        let projectInfoArray: CSProjectInfo[] = [];
        if (respJson && respJson.rows !== undefined) {
            let respRows: Record<string,string>[] = respJson.rows;
            // TODO: the "Project ID" number may be too large for javascript.
            //  We cannot parse the project ID from the "url" item,
            //   since the "url" is for the latest analysis; not the project page.
            // TODO don't use Array.forEach
            respRows.forEach((row) => {
                console.log(row);
                let projectId = row["Project ID"];
                let projectName = row["Project"];
                if (projectId !== undefined && projectName !== undefined) {
                    projectInfoArray.push({
                        id: projectId,
                        name: projectName,
                    });
                }
            });
        }
        return projectInfoArray;
    }

    public async fetchAnalysisInfo(analysisId: CSAnalysisId): Promise<CSAnalysisInfo[]> {
        let analysisListPath = `/project/${encodeURIComponent(analysisId)}.json`;
        let respJson = await this.fetchJson(analysisListPath);
        let analysisInfoArray: CSAnalysisInfo[] = [];
        if (respJson && respJson.rows !== undefined) {
            let respRows: Record<string,string>[] = respJson.rows;
            // Parse ID out of "url" item as a string.
            let analysisIdRegExp = new RegExp("/analysis/(\\d+)\\.json");
            // TODO don't use Array.forEach
            respRows.forEach((row) => {
                let analysisId: string|undefined;
                let analysisUrlString = row["url"];
                let analysisName = row["Analysis"];
                if (analysisUrlString) {
                    let analysisIdMatch = analysisUrlString.match(analysisIdRegExp);
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
            });
        }
        return analysisInfoArray;
    }

    public async fetchSarifAnalysisStream(
            analysisId: CSAnalysisId,
            srcRootPath?: string,
            ): Promise<NodeJS.ReadableStream>
    {
        let sarifAnalysisUrlPath = `/analysis/${encodeURIComponent(analysisId)}-allwarnings.sarif?filter=1`;
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
        const scope = `aid:${headAnalysisId}`;
        const query = `aid:${headAnalysisId} DIFFERENCE aid:${baseAnalysisId}`;
        const sarifAnalysisUrlPath = `/warning_detail_search.sarif?scope=${encodeURIComponent(scope)}&query=${encodeURIComponent(query)}&artifacts=0&filter=1`;
        return this.fetch(sarifAnalysisUrlPath);
    }

}
