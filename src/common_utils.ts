/** Common/Utility functions, etc. for VS Code extension. */

/** Error raised when we know an operation was deliberatedly canceled by user action.
 * 
 * Note: Microsoft types and documentation prefer two "l"s when spelling derivatives of "Cancel".
 * However Merriam-Webster indicates that one "l" should usually be used for American English,
 * except for the word "Cancellation" (which always has two "l"s).
 * To make the types consistent with Microsoft, we use two "l" chars in type names,
 * but for UI strings, we use one "l".
*/
export class OperationCancelledError extends Error {
    constructor(message?: string) {
        super(message || "Canceled");
        // See: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html#support-for-newtarget
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Interface for objects that can signal cancellation of a long-running operation.
 * 
 *  Intended to be somewhat compatible with VSCode CancellationToken.
*/
export interface CancellationSignal {
    /** Check if a cancellation was signaled previously. */
    isCancellationRequested: boolean;
    /** Call a callback when a cancellation event is signaled.
     * 
     *  @returns a function, which if invoked, will unregister the event callback.
    */
    onCancellationRequested: (callback:()=>void) => (()=>void);
    /** Create an Error object that is safe to throw upon cancellation. */
    createCancellationError: (message?: string) => Error;
}


/** Sanitize a string so that it can be used as a file name. */
export function replaceInvalidFileNameChars(s: string, replacement: string = '_'): string
{
    const invalidCharRegExp: RegExp = new RegExp("/|\\\\|\\?|%|\\*|:|\\||\"|<|>", "g");
    let s2: string = s.replace(invalidCharRegExp, replacement);
    return s2;
}

/** setTimeout promise. */
export function delay(milliseconds: number): Promise<void> {
    return new Promise<void>((
        resolve: () => void,
        reject: (e: unknown) => void,
    ): void => {
        setTimeout((): void => {
            resolve();
        },
        milliseconds);
    });
}
