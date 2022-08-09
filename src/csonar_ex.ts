/** Utilities for codesonar integration. */

import { readFile } from 'fs';
import * as path from 'path';

export const PRJ_DIR_EXT: string = ".prj_files";
export const PRJ_FILE_EXT: string = ".prj";

const AID_FILE_NAME: string = "aid.txt";

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
    public async readAnalysisIdString(): Promise<string> {
        const aidFilePath: string = path.join(this.prjDirPath, AID_FILE_NAME);
        return new Promise<string>((
            resolve: (idString: string) => void,
            reject: (e: unknown) => void,
        ) => {
            readFile(
                aidFilePath,
                { encoding: "utf-8" },
                (e: unknown|null, data: string): void => {
                    if (e) {
                        reject(e);
                    } else if (data.length < 1) {
                        reject(new Error("Empty aid file"));
                    } else {
                        resolve(data.trim());
                    }
                });   
        }
        );    
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
