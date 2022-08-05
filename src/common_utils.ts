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
 *  @returns empty string if error could not be converted to a string.
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
    let errorMessage: string = message ?? '';
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

    return errorMessage;
}

/** Sanitize a string so that it can be used as a file name. */
export function replaceInvalidFileNameChars(s: string, replacement: string = '_'): string
{
    const invalidCharRegExp: RegExp = new RegExp("/\\?%*:|\"<>", "g");
    let s2: string = s.replace(invalidCharRegExp, replacement);
    return s2;
}
