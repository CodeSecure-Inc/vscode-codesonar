/** Common/Utility functions, etc. for VS Code extension. */

/** Convert an error object received in a catch statement into a string suitable for printing.
 *
 *  @returns empty string if error could not be converted to a string.
 */
export function errorToString(e: unknown): string {
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
            errorMessage = e.message;
        }
        else {
            errorMessage = e.toString();
        }
    }

    return errorMessage;
}