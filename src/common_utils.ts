/** Common/Utility functions, etc. for VS Code extension. */

/** Convert an error object received in a catch statement into a string suitable for printing.
 *
 *  @returns empty string if error could not be converted to a string.
 */
export function errorToString(
        e: unknown,
        {
            verbose,
        }: {
            verbose: boolean,
        } = {
            verbose: true
        }
    ): string {
    let errorMessage: string = '';
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
            if (verbose) {
                errorMessage = `${e.name}: ${e.message}`;
            } else {
                errorMessage = e.message;
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
