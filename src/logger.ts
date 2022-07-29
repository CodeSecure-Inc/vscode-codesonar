/** Defines a simple logging object interface based on `console`.
 * 
 *  The interface is designed to be a subset of the Node Console object interface,
 *  but it can be implemented by objects that are not consoles.
 */

export interface Logger {
    error: (message: string) => void;
    warn: (message: string) => void;
    info: (message: string) => void;
};
