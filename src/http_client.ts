/** A high-level, promise-based HTTP client object. */
import * as http from 'http';
import * as https from 'https';
import { Readable } from 'stream';

import { CancellationSignal } from './common_utils';
import { Logger } from './logger';

export const HTTP_OK: number = 200;
export const HTTP_MOVED_PERMANENTLY: number = 301;
export const HTTP_FORBIDDEN: number = 403;
export const HTTP_NOT_FOUND: number = 404;

export const HTTP_PROTOCOL: "http" = "http";
export const HTTPS_PROTOCOL: "https" = "https";

const HTTP_DEFAULT_PORT: number = 80;
const HTTPS_DEFAULT_PORT: number = 443;

const HTTP_DEFAULT_TIMEOUT: number = 5*60*1000;

const URL_PROTOCOL_SEP: string = "://";
const URL_PROTOCOL_TERMINATOR: string = ":";
const URL_PORT_SEP: string = ":";
const URL_PASSWORD_SEP: string = ":";
const URL_SEARCH_SEP: string = "?";
const URL_SEARCH_ITEM_SEP: string = "&";
const URL_SEARCH_KEY_SEP: string = "=";
const URL_HASH_SEP: string = "#";

export type HTTPProtocol = "http" | "https";

/** Interface for objects that can signal an HTTP request cancellation. */
export interface HTTPCancellationSignal extends CancellationSignal {
    // Export a custom cancellation signal which simply implements CancellationSignal:
    //  the intention here is not to directly declare a dependency on common_utils.ts.
}

/** Per-connection options. */
export interface HTTPClientConnectionOptions {
    hostname: string;
    port?: number|string;  // allow string since URL.port is a string.
    protocol?: string;     // "http" | "https"
    timeout?: number;      // milliseconds
    ca?: string|Buffer;    // ca file contents; not a file path.
    cert?: string|Buffer;  // client cert file contents.
    key?: string|Buffer;   // client cert key file contents.
    keypasswd?: () => Promise<string>;   // passphrase for client cert key.
}

/** Per-request options */
export interface HTTPClientRequestOptions {
    method?: string;
    headers?: Record<string,string>;
    timeout?: number;
    dataEncoding?: BufferEncoding;
    cancellationSignal?: HTTPCancellationSignal;
}

/** Response received by client from an HTTP request. */
export interface HTTPReceivedResponse {
    url: URL;
    body: Readable;
    status: HTTPStatusError;
    headers: Record<string,string>;
}

/** Basic HTTP per-request options for the back-end HTTPS module. */
interface HTTPRequestOptions {
    auth?: string;
    headers?: Record<string,string>;
    hostname: string;
    method?: string;
    port: number;
    protocol?: string;
    path: string;
    timeout?: number;
}

/** HTTPS per-request options for the back-end HTTPS module. */
interface HTTPSRequestOptions extends HTTPRequestOptions {
    ca?: string|Buffer;
    cert?: string|Buffer;
    key?: string|Buffer;
    passphrase?: string;
}

/** Represents an HTTP Status as a JavaScript Error object. */
export class HTTPStatusError extends Error {
    public readonly code: number;

    constructor(message: string, code: number) {
        super(message);
        this.code = code;
        this.name = 'HTTPStatusError';

        // This is a magic work-around for the way the Error class modifies the prototype.
        //  Without this, the toString() method override would be ignored.
        // See example code using "Error":
        //   https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html#support-for-newtarget
        Object.setPrototypeOf(this, new.target.prototype);
    }

    public toString(): string {
        return `${this.code}: ${this.message}`;
    }
}

/** URL-encode an object as "application/x-www-form-urlencoded" content. */
export function encodeURIQuery(queryObject: any): string {
    const queryParts: string[] = [];
    for (let k in queryObject) {
        if (queryObject.hasOwnProperty(k)) {
            const v: any = queryObject[k];
            let s: string = "";
            if (v === undefined || v === null) {
                s = "";
            }
            else if (typeof v === "string") {
                s = v;
            }
            else if (typeof v === "boolean") {
                s = v ? "1" : "0";
            }
            else if (typeof v === "number") {
                s = v.toString();
            }
            else {
                s = JSON.stringify(v);
            }
            queryParts.push(k + URL_SEARCH_KEY_SEP + s);
        }
    }
    return queryParts.join(URL_SEARCH_ITEM_SEP);
}

/** Try to ensure URL protocol string matches the form of our HTTP_PROTOCOL, etc. constants. */
function normalizeProtocolString(protocol: string): string {
    let protocol2: string = protocol.toLowerCase();
    if (protocol2.endsWith(URL_PROTOCOL_TERMINATOR)) {
        protocol2 = protocol2.substring(0, protocol2.length - URL_PROTOCOL_TERMINATOR.length);
    }
    return protocol2;
}

/** Substitute for NodeJS url.urlToHttpOptions() since it is not always available. */
function urlToHttpOptions(url: URL): HTTPRequestOptions {
    let options: HTTPRequestOptions = {
            protocol: url.protocol,
            hostname: url.hostname,
            path: url.pathname,
            port: (url.port) ? parseInt(url.port) 
                            : ((url.protocol === HTTPS_PROTOCOL) ? HTTPS_DEFAULT_PORT : HTTP_DEFAULT_PORT),
        };
    if (url.search) {
        options.path += url.search;
    }
    if (url.username || url.password) {
        const username: string = url.username ?? "";
        const password: string = url.password ?? "";
        options.auth = url.username + URL_PASSWORD_SEP + url.password;
    }
    return options;
}

/** HTTP parsed cookie. */
class HTTPCookie {
    public readonly cookie: string; // name=value (same as .toString())
    public readonly key: string;  // name;path;domain
    public readonly name: string;
    public readonly value: string|undefined;
    public readonly created: Date|undefined;
    public readonly expires: Date|undefined;
    public readonly maxAge: number|undefined;
    public readonly domain: string|undefined;
    public readonly path: string|undefined;
    public readonly httpOnly: boolean;
    public readonly sameSite: boolean;
    public readonly secure: boolean;
    public readonly attributes: Record<string,string|undefined>;

    constructor(setcookie: string, created?: Date) {
        const ATTRIB_SEP: string = ';';
        const KV_SEP: string = '=';
        const attribs: string[] = setcookie.split(ATTRIB_SEP);
        this.attributes = {};
        this.created = created;
        this.cookie = '';
        this.name = '';
        this.httpOnly = false;
        this.sameSite = false;
        this.secure = false;
        if (attribs.length) {
            this.cookie = attribs[0].trim();
            const kv: string[] = this.cookie.split(KV_SEP);
            this.name = kv[0];
            if (kv.length > 1) {
                this.value = kv[1];
            }
        }
        for (let i = 1; i < attribs.length; i++) {
            const attrib: string = attribs[i].trim();
            const kv: string[] = attrib.split(KV_SEP);
            const attribName = kv[0];
            const attribNameLowerCase = attribName.toLowerCase();
            let attribValue: string|undefined;
            if (kv.length > 1) {
                attribValue = kv[1];
            }

            this.attributes[attribNameLowerCase] = attribValue;
            if (attribNameLowerCase === "httponly") {
                this.httpOnly = true;
            }
            else if (attribNameLowerCase === "samesite") {
                this.sameSite = true;
            }
            else if (attribNameLowerCase === "secure") {
                this.secure = true;
            }
            else if (attribNameLowerCase === "maxage") {
                if (attribValue)
                {
                    const maxAge: number = parseInt(attribValue);
                    if (!Number.isNaN(maxAge))
                    {
                        this.maxAge = maxAge;
                    }
                }  
            }
            else if (attribNameLowerCase === "path") {
                this.path = attribValue;
            }
            else if (attribNameLowerCase === "domain") {
                this.domain = attribValue;
            }
            else if (attribNameLowerCase === "expires") {
                if (attribValue) {
                    const expires: Date = new Date(attribValue);
                    if (expires.toString() !== "Invalid Date") {
                        this.expires = expires;
                    }
                }
            }
        }
        this.key = this.name;
        if (this.domain || this.path) {
            this.key = [
                this.name,
                this.domain ?? '',
                this.path ?? '',
                ].join(ATTRIB_SEP);
        }
    }

    public toString(): string {
        return this.cookie;
    }
}

/** Manages a connection to a single HTTP server. */
export class HTTPClientConnection {
    private readonly hostname: string;
    private readonly port: number;
    private readonly protocol: HTTPProtocol;
    private readonly timeout: number;
    private readonly baseUrlString: string;
    private readonly ca: string|Buffer|undefined;
    private readonly clientCert: string|Buffer|undefined;
    private readonly clientCertKey: string|Buffer|undefined;
    private readonly httpCookies: Record<string, HTTPCookie>;

    private _requestPassphrase: undefined | (() => Promise<string>);
    // It would be best not to keep the passphrase stored in a variable,
    //  but the https.request() method will need it everytime it is called.
    //  We will request the password one time, then we will remember it.
    private _passphrase: string|undefined;

    public logger: Logger|undefined;

    constructor(options: HTTPClientConnectionOptions|URL|string) {
        this.protocol = HTTP_PROTOCOL;
        this.port = HTTP_DEFAULT_PORT;
        this.timeout = HTTP_DEFAULT_TIMEOUT;
        this.httpCookies = {};
        let options2: HTTPClientConnectionOptions;
        let connUrl: URL|undefined;
        if (typeof options === "string") {
            connUrl = new URL(options);
            options2 = connUrl;
        }
        else if (options instanceof URL) {
            connUrl = options;
            options2 = connUrl;
        }
        else {
            options2 = options;
        }
        this.hostname = options2.hostname;
        if (options2.protocol !== undefined) {
            const protocol: string = normalizeProtocolString(options2.protocol);
            if (protocol === HTTPS_PROTOCOL) {
                this.protocol = HTTPS_PROTOCOL;
            }
            else if (protocol === HTTP_PROTOCOL) {
                this.protocol = HTTP_PROTOCOL;
            }
            else {
                throw new Error(`Unknown protocol ${options2.protocol}`);
            }
        }
        let baseUrlString: string = this.protocol + URL_PROTOCOL_SEP + this.hostname;
        if (options2.port !== undefined) {
            let portString: string;
            if (typeof options2.port === "string") {
                portString = options2.port;
                this.port = parseInt(options2.port);
            }
            else {
                portString = options2.port.toString();
                this.port = options2.port;
            }
            baseUrlString += URL_PORT_SEP + portString;
        }
        this.baseUrlString = baseUrlString;
        this.ca = options2.ca;
        this.clientCert = options2.cert;
        this.clientCertKey = options2.key;
        this._requestPassphrase = options2.keypasswd;
        // TODO consider using incoming URL.pathname as the "base" for outgoing requests.
    }

    private log(message: string): void {
        if (this.logger !== undefined) {
            this.logger.info(message);
        }
    }

    /** Remove all cookies from the HTTP client's cookie storage. */
    public clearCookies(): void {
        let cookieKeys: string[] = Object.keys(this.httpCookies);
        for (let i: number = 0; i < cookieKeys.length; i++) {
            const key: string = cookieKeys[i];
            delete this.httpCookies[key];
        }
    }

    /** Remove expired cookies from our cookie jar. */
    private evictExpiredCookies(nowMilliseconds: number): void {
        const expiredCookieKeys: string[] = [];
        for (let key in this.httpCookies) {
            const httpCookie: HTTPCookie = this.httpCookies[key];
            let expired: boolean = false;
            if (httpCookie.maxAge !== undefined
                && !Number.isNaN(httpCookie.maxAge)
                && httpCookie.created !== undefined) {
                const maxAgeMilliseconds: number = httpCookie.maxAge * 1000;
                const createdMilliseconds: number = httpCookie.created.getTime();
                if (createdMilliseconds + maxAgeMilliseconds > nowMilliseconds)
                {
                    expired = true;
                }
            }
            else if (httpCookie.expires) {
                const expirationMilliseconds: number = httpCookie.expires.getTime();
                if (expirationMilliseconds > nowMilliseconds) {
                    expired = true;
                }
            }
            if (expired) {
                expiredCookieKeys.push(key);
            }
        }
        for (let i: number = 0; i < expiredCookieKeys.length; i++) {
            const key: string = expiredCookieKeys[i];
            delete this.httpCookies[key];
        };
    }

    /** Get list of valid cookies that should be sent with the next request. */
    private getRequestCookies(requestUrl: URL): string[] {
        let cookies: string[] = [];
        for (let key in this.httpCookies) {
            const httpCookie: HTTPCookie = this.httpCookies[key];
            // TODO check path, domain, etc.
            cookies.push(httpCookie.toString());
        }
        return cookies;
    }

    /** Transform a resource relative to the the server to an absolute URL. */
    public resourceURL(resource: string|URL): URL {
        let targetUrl: URL;
        if (typeof resource === "string") {
            targetUrl = new URL(resource, this.baseUrlString);
        }
        else {
            targetUrl = resource;
        }
        return targetUrl;
    }

    /** Make a request to the server.
     *  @returns Promise containing response stream.
     */
    public request(
            resource: string|URL, 
            options?: HTTPClientRequestOptions,
            data?: string|Buffer,
            ) : Promise<HTTPReceivedResponse> {
        const defaultMethod: string = "GET";
        const targetUrl: URL = this.resourceURL(resource);
        let dataEncoding: BufferEncoding = 'utf8';
        let cancellationSignal: HTTPCancellationSignal|undefined;
        let httpOptions: HTTPRequestOptions = urlToHttpOptions(targetUrl);
        httpOptions.method = defaultMethod;
        httpOptions.timeout = this.timeout;
        const nowMilliseconds = Date.now();
        this.evictExpiredCookies(nowMilliseconds);
        const cookies: string[] = this.getRequestCookies(targetUrl);
        if (options) {
            if (options.method) {
                httpOptions.method = options.method;
            }
            if (options.timeout !== undefined) {
                httpOptions.timeout = options.timeout;
            }
            if (options.headers) {
                httpOptions.headers = options.headers;
            }
            if (options.dataEncoding) {
                dataEncoding = options.dataEncoding;
            }
            if (options.cancellationSignal !== undefined) {
                cancellationSignal = options.cancellationSignal;
            }
        }
        if (cookies.length) {
            if (httpOptions.headers === undefined) {
                httpOptions.headers = {};
            }
            httpOptions.headers['cookie'] = cookies.join("; ");
        }
        let dataBuffer: Buffer|undefined;
        if (data !== undefined) {
            if (typeof data === "string") {
                dataBuffer = Buffer.from(data, dataEncoding);
            }
            else if (typeof data === "object" && data instanceof Buffer) {
                dataBuffer = data;
            }
        }
        if (dataBuffer !== undefined) {
            // Set the Content-Length header since we know the data size,
            //  and because some servers don't like Transfer-Encoding:chunked.
            if (httpOptions.headers === undefined) {
                httpOptions.headers = {};
            }
            httpOptions.headers['content-length'] = dataBuffer.length.toString();
        }
        let httpsOptions: HTTPSRequestOptions = httpOptions;
        if (this.ca) {
            httpsOptions.ca = this.ca;
        }
        if (this.clientCert) {
            httpsOptions.cert = this.clientCert;
        }
        if (this.clientCertKey) {
            httpsOptions.key = this.clientCertKey;
        }
        return new Promise<HTTPReceivedResponse>((
                resolve: (response: HTTPReceivedResponse) => void,
                reject: (e: unknown) => void,
        ) => {

            if (targetUrl.origin !== this.baseUrlString) {
                reject(new Error(`Requested URL origin '${targetUrl.origin}' does not match the HTTP connection to '${this.baseUrlString}`));
            }

            // The code below makes a chain of callbacks:
            //   get client certificate key passphrase (if necessary)
            //     --> initiate request
            //       --> handle response
            //   callback handlers are defined in reverse order below:

            const responseCallback: ((res: http.IncomingMessage) => void) = (
                res: http.IncomingMessage
            ) => {
                const headers: Record<string,string> = {};
                for (let k in res.headers) {
                    // This should get everything except Set-Cookie headers (which are stored in an array)
                    if (typeof k === "string") {
                        headers[k] = res.headers[k] as string;
                    }
                }
                const setcookies: string[]|undefined = res.headers["set-cookie"];
                if (setcookies !== undefined) {
                    for (let setcookie of setcookies) {
                        let httpCookie = new HTTPCookie(setcookie);
                        // This will replace existing cookies:
                        this.httpCookies[httpCookie.key] = httpCookie;
                    }
                }
                const httpStatus: HTTPStatusError = new HTTPStatusError(
                    res.statusMessage ?? 'Unspecified HTTP Error',
                    res.statusCode ?? 0,
                );
                let rejectError: Error|undefined;
                let redirectPromise: Promise<HTTPReceivedResponse>|undefined;
                if (httpStatus.code === HTTP_MOVED_PERMANENTLY) {
                    // We cannot redirect from this connection, even if it is just to switch protocol.
                    const redirectTargetUrlString: string|undefined = res.headers["location"];
                    let redirectTargetUrl: URL|undefined;
                    if (redirectTargetUrlString) {
                        redirectTargetUrl = new URL(redirectTargetUrlString, this.baseUrlString);
                    }
                    if (redirectTargetUrl === undefined) {
                        rejectError = new Error(`Missing Redirect Location from server at ${targetUrl.href}`);
                    }
                    else if (redirectTargetUrl.origin !== this.baseUrlString) {
                        // In this case, we will resolve (not reject) a HTTP_MOVED_PERMANENTLY 301 response.
                        this.log(`Cannot redirect to '${redirectTargetUrl.href}' since it is not from origin '${this.baseUrlString}'.`);
                    }
                    else {
                        // Recursive call to request the redirect location:
                        this.log(`HTTP Redirect to: ${redirectTargetUrlString}`);
                        redirectPromise = this.request(
                                redirectTargetUrl,
                                options,
                                data,
                                );
                    }
                }
                // else resolve a non-301 response, could be 200, but could be anything else.
                if (rejectError) {
                    reject(rejectError);
                }
                else if (redirectPromise) {
                    redirectPromise.then(resolve).catch(reject);
                }
                else {
                    resolve({
                        url: targetUrl,
                        body: res,
                        status: httpStatus,
                        headers: headers,
                    });
                }
            };

            const requestCallback: ((requestObject: http.ClientRequest) => void) = (
                requestObject: http.ClientRequest
            ) => {
                // TODO: if there is a TLS connection error,
                //   for example, when user provides invalid passphrase for a client cert key,
                //   the requestObject will be created,
                //   and the code will get to this point,
                //   but no further requestObject events will be raised.
                //   In particular, the 'error', 'socket', or 'close' events will not be raised,
                //   which makes it impractical to detect a failed TLS connection.
                //  Perhaps it would be possible to catch the error by creating a derived Agent object
                //   and overriding Agent.createConnection().
                let unregisterCancellation: undefined|(()=>void);
                if (cancellationSignal !== undefined) {
                    const capturedCancellationSignal: CancellationSignal = cancellationSignal;
                    unregisterCancellation = cancellationSignal.onCancellationRequested((): void => {
                        this.log("HTTP request was canceled.");
                        const e: Error = capturedCancellationSignal.createCancellationError();
                        requestObject.destroy(e);
                    });
                }
                requestObject.on('timeout', (): void => {
                    const e: Error = new Error("Network connection timed-out.");
                    requestObject.destroy(e);
                });
                requestObject.on('error', reject);
                requestObject.on('close', () => {
                    if (unregisterCancellation !== undefined) {
                        unregisterCancellation();
                    }
                });
                if (dataBuffer !== undefined) {
                    requestObject.write(dataBuffer);
                }
                requestObject.end();
            };

            const passphraseCallback: (passphrase: string|undefined) => void = (
                passphrase: string|undefined,
            ): void => {
                if (this._requestPassphrase && passphrase !== undefined) {
                    this._passphrase = passphrase;
                    // Only request passphrase one time:
                    this._requestPassphrase = undefined;    
                }
                if (passphrase !== undefined) {
                    httpsOptions.passphrase = passphrase;
                }
                let requestObject: http.ClientRequest|undefined;
                if (this.protocol === HTTP_PROTOCOL) {
                    requestObject = http.request(httpOptions, responseCallback);
                }
                else if (this.protocol === HTTPS_PROTOCOL) {
                    requestObject = https.request(httpsOptions, responseCallback);
                }
                if (requestObject === undefined) {
                    reject(new Error("Could not create HTTP request."));
                }
                else {
                    requestCallback(requestObject);
                }
            };

            let passphrasePromise: Promise<string|undefined>;
            if (this._requestPassphrase !== undefined) {
                this.log("Requesting passphrase for client certificate key...");
                passphrasePromise = this._requestPassphrase();
            }
            else {
                passphrasePromise = Promise<string|undefined>.resolve(this._passphrase);
            }
            passphrasePromise.then(passphraseCallback).catch(reject);
        });
    }
}
