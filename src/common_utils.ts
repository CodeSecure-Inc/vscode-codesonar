/** Common/Utility functions, etc. for VS Code extension. */

/** Try to type-check a value as a NodeJS.ErrnoException.
 * 
 * Error objects in NodeJS have a few extra properties, like 'code',
 * which the basic JavaScript Error type does not declare.
 * 
 * @returns undefined if e is not an ErrnoException.
 */
export function asErrnoException(e: unknown): NodeJS.ErrnoException|undefined {
    let ex: NodeJS.ErrnoException|undefined;
    // Assume that all Error objects are in fact of ErrnoException type:
    if (typeof e === "object" && e instanceof Error) {
        ex = e as NodeJS.ErrnoException;
    }
    return ex;
}

/** Convert an error object received in a catch statement into a string suitable for printing.
 *
 *  @param e - error value of unknown type.
 *  @param verbose - boolean, true if extra error information should be inserted into the output message.
 *  @param message - string, default string in case an error message cannot be extracted from the error value.
 *  @returns a message extracted from the error value.
 *     If a message could not be extracted, then returns the value of the `message` parameter.
 *     If the `message` parameter is not defined, then returns an empty string.
 */
export function errorToString(
        e: unknown,
        {
            verbose,
            message,
        }: {
            verbose?: boolean,
            message?: string,
        } = {}
    ): string {
    let errorMessage: string;
    if (e === undefined) {
        errorMessage = '<UNDEFINED>';
    }
    else if (e === null) {
        errorMessage = '<NULL>';
    }
    else if (typeof e === 'string') {
        errorMessage = e;
    }
    else if (typeof e === 'number') {
        errorMessage = e.toString();
    }
    else if (typeof e === 'object') {
        if (e instanceof Error) {
            // Error objects in NodeJS have a few extra properties, like 'code',
            //  which the basic JavaScript Error type does not declare:
            const ex: NodeJS.ErrnoException|undefined = asErrnoException(e);
            errorMessage = e.message;
            if (verbose) {
                if (ex !== undefined && ex.code !== undefined) {
                    errorMessage = `${ex.code} ${errorMessage}`;
                }
                errorMessage = `${e.name}: ${errorMessage}`;
            }
        }
        else {
            errorMessage = e.toString();
        }
    }
    else {
        errorMessage = message ?? '';
    }

    return errorMessage;
}

/** Sanitize a string so that it can be used as a file name. */
export function replaceInvalidFileNameChars(s: string, replacement: string = '_'): string
{
    const invalidCharRegExp: RegExp = new RegExp("/\\?%*:|\"<>", "g");
    let s2: string = s.replace(invalidCharRegExp, replacement);
    return s2;
}

/** Read an entire stream into a string. */
export function readTextStream(inIO: NodeJS.ReadableStream, maxLength?: number|undefined): Promise<string> {
    return new Promise<string>((
        resolve: (outText: string) => void,
        reject: (e: unknown) => void,
        ): void => {
            const chunks: Array<string|Buffer> = [];
            let outLength: number = 0;
            if (!inIO.readable) {
                reject(new Error("Text stream is not readable, perhaps it has already been read."));
            }
            inIO.on('error', reject
            ).on('data', (chunk: string|Buffer): void => {
                let pushChunk: string|Buffer|undefined;
                if (maxLength === undefined) {
                    pushChunk = chunk;
                }
                else if (outLength >= maxLength) {
                    // don't push anything
                }
                else if (chunk.length + outLength < maxLength) {
                    pushChunk = chunk;
                }
                else if (typeof chunk === "string") {
                    pushChunk = chunk.substring(0, maxLength - outLength);
                }
                else if (chunk instanceof Buffer) {
                    pushChunk = chunk.slice(0, maxLength - outLength);
                }
                if (pushChunk) {
                    outLength += pushChunk.length;
                    chunks.push(pushChunk);
                }
            }).on('end', (): void => {
                resolve(chunks.join(''));
            });
        });
}