/** Extra filesystem utilities. */

import {
    readFile,
    stat as fileStat,
    Stats as FileStats,
} from 'fs';

import {
    errorToMessageCode,
    ErrorMessageCode,
    ENOENT_CODE,
} from './errors_ex';


/** File "stat" information parsed into high-level JavaScript types. */
export interface FileInfo {
    size: bigint,
    // TODO: add creationTime, etc. as Date() objects
}


/** Try to read file information. */
export async function readFileInfo(filePath: string): Promise<FileInfo> {
    return new Promise<FileInfo>((
        resolve: (fileInfo: FileInfo) => void,
        reject: (e: unknown) => void,
    ) => {
        fileStat(filePath, (
            e: unknown,
            stats: FileStats,
        ) => {
            if (e) {
                reject(e);
            }
            else {
                const fileInfo: FileInfo = {
                    size: BigInt(stats.size),
                };
                resolve(fileInfo);
            }
        });
    });
}

export function readFileText(filePath: string): Promise<string> {
    return new Promise<string>((
        resolve: (data: string) => void,
        reject: (e: unknown) => void,
    ) => {
        readFile(filePath, { encoding: "utf-8" }, (
            e: unknown,
            data: string,
        ) => {
            if (e) {
                reject(e);
            }
            else {
                resolve(data);
            }
        });
    });
}

/** Determine if a file exists.  */
export function fileExists(filePath: string): Promise<boolean> {
    return new Promise<boolean>((
        resolve: (exists: boolean) => void,
        reject: (e: unknown) => void,
    ) => {
        fileStat(filePath, (
            e: unknown,
            stats: FileStats,
        ) => {
            if (e) {
                const ecode: ErrorMessageCode|undefined = errorToMessageCode(e);
                if (ecode !== undefined && ecode === ENOENT_CODE) {
                    // file does not exist, don't raise an error.
                    resolve(false);
                }
                else {
                    reject(e);
                }
            }
            else {
                resolve(true);
            }
        });
    });
}
