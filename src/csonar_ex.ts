/** Utilities for codesonar integration. */
import * as path from 'path';

import { 
    fileExists,
    readFileText,
}  from './fs_ex';
import { PKCSFile } from './pkcs';


export enum CSHubAuthenticationMethod {
    anonymous = "anonymous",
    password = "password",
    certificate = "certificate",
}

type CSHubRecordId = string;
export type CSAnalysisId = CSHubRecordId;
export type CSProjectId = CSHubRecordId;


export const PRJ_DIR_EXT: string = ".prj_files";
export const PRJ_FILE_EXT: string = ".prj";

const AID_FILE_NAME: string = "aid.txt";

// In JavaScript: (2**53 === 2**53+1)
const MAX_CSHUB_RECORD_ID_NUMBER: number = 2**53 - 1;

/** Convert a record ID (probably originating from JSON) into a CSHubRecordId type. */
function parseCSHubRecordId(recordId: string|number|bigint): CSHubRecordId {
    if (typeof recordId === "number") {
        // It is theoretically possible to get an ID in JSON
        //  that is too large to be accurately represented as an integer.
        //  If we don't use a non-standard JSON parser that reads ID numbers as bigint,
        //  then we won't be able to handle these ID numbers.
        if (recordId > MAX_CSHUB_RECORD_ID_NUMBER) {
            throw new Error(`CodeSonar hub ID value ${recordId} is too large to be accurately represented as a number type.`);
        }
    }
    // We represent IDs as string since we want to treat them abstractly, without numerical properties (or side-effects).
    return recordId.toString();
}

/** Convert a project ID (probably originating from JSON) into a CSProjectId type. */
export function parseCSProjectId(projectId: string|number|bigint): CSProjectId {
    return parseCSHubRecordId(projectId);
}

/** Convert an analysis ID (probably originating from JSON) into a CSAnalysisId type. */
export function parseCSAnalysisId(analysisId: string|number|bigint): CSAnalysisId {
    return parseCSHubRecordId(analysisId);
}


/** An object to help with finding .prj files. */
export class CSProjectFile {
    private readonly projectFileBasePath: string;
    public readonly baseName: string;
    public readonly prjFilePath: string;
    public readonly prjDirPath: string;

    constructor(projectFilePath: string) {
        const parsedFilePath: path.ParsedPath = path.parse(projectFilePath);
        let projectFileBasePath: string = projectFilePath;
        let baseName: string = parsedFilePath.base;
        if (parsedFilePath.ext === PRJ_FILE_EXT
            || parsedFilePath.ext === PRJ_DIR_EXT
        ) {
            projectFileBasePath = path.join(parsedFilePath.dir, parsedFilePath.name);
            baseName = parsedFilePath.name;
        }
        this.projectFileBasePath = projectFileBasePath;
        this.baseName = baseName;
        this.prjFilePath = projectFileBasePath + PRJ_FILE_EXT;
        this.prjDirPath = projectFileBasePath + PRJ_DIR_EXT;
    }

    /** Read the analysis ID from the project directory. */
    public async readAnalysisIdString(): Promise<string|undefined> {
        const aidFilePath: string = path.join(this.prjDirPath, AID_FILE_NAME);
        const aidFileExists: boolean = await fileExists(aidFilePath);
        let analysisId: string|undefined;
        if (aidFileExists) {
            let data: string = await readFileText(aidFilePath);
            data = data.trim();
            if (data.length < 1) {
                throw new Error("Empty aid file");
            } 
            analysisId = data;   
        }
        return analysisId;  
    }
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


/** Factory function to create and load a hub key. */
export async function loadCSHubUserKey(
    certFilePath: string,
    keyFilePath: string,
): Promise<CSHubUserKey> {
    const userKey: CSHubUserKey = new CSHubUserKey(certFilePath, keyFilePath);
    await userKey.load();
    return userKey;
}


/** Encapsulates hubcert/hubkey authentication options. */
export class CSHubUserKey {
    public certFilePath: string;
    public keyFilePath: string;
    public cert: string|undefined;
    public key: string|undefined;
    private _keyIsProtected: boolean|undefined;

    constructor(
        certFilePath: string,
        keyFilePath: string,
    ) {
        this.certFilePath = certFilePath;
        this.keyFilePath = keyFilePath;
        this._keyIsProtected = undefined;
    }

    public get keyIsProtected(): boolean|undefined {
        return this._keyIsProtected;
    }

    /** Load certificates by reading files.
     * 
     *  It is safe to call this method multiple times.
     *  Subsequent invocations will not attempt to reload file data.
    */
    public async load(): Promise<CSHubUserKey> {
        if (this.cert === undefined) {
            this.cert = await readFileText(this.certFilePath);
        }
        if (this.key === undefined) {
            this.key = await readFileText(this.keyFilePath);
            this.inspectKey(this.key);
        }

        return this;
    }

    private inspectKey(key: string): void {
        const keyFile: PKCSFile = new PKCSFile();
        keyFile.parseText(key);
        for (let item of keyFile.items) {
            if (item.isPrivate === undefined || item.isProtected === undefined) {
                throw new Error("Could not determine protection status of hub user key file");
            }
            else if (item.isPrivate === true && item.isProtected === true) {
                this._keyIsProtected = true;
            }
            else if (item.isPrivate === true
                    && item.isProtected === false
                    && this.keyIsProtected === undefined
            ) {
                this._keyIsProtected = false;
            }
        }
    }
}
