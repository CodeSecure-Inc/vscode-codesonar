/** Extra error utilities. */

export type ErrorMessageCode = string;

export const ECONNREFUSED_CODE: ErrorMessageCode = 'ECONNREFUSED';
export const ECONNRESET_CODE: ErrorMessageCode = 'ECONNRESET';
export const ENOENT_CODE: ErrorMessageCode = 'ENOENT';
export const EPROTO_CODE: ErrorMessageCode = 'EPROTO';
export const DEPTH_ZERO_SELF_SIGNED_CERT_CODE: ErrorMessageCode = 'DEPTH_ZERO_SELF_SIGNED_CERT';
export const SELF_SIGNED_CERT_IN_CHAIN_CODE: ErrorMessageCode = 'SELF_SIGNED_CERT_IN_CHAIN';


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

/** Try to extract a locale-neutral error message code from an error object. */
export function errorToMessageCode(e: unknown): ErrorMessageCode|undefined {
    const ex: NodeJS.ErrnoException|undefined = asErrnoException(e);
    const messageCode: ErrorMessageCode|undefined = ex?.code;
    return messageCode;
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

