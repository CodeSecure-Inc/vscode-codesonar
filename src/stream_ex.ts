/** Extra stream utility functions. */


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


/** Read a stream to its end and ignore all of its content. */
export function ignoreStream(inIO: NodeJS.ReadableStream): Promise<void> {
    return new Promise<void>((
        resolve: () => void,
        reject: (e: unknown) => void,
        ): void => {
            if (!inIO.readable) {
                reject(new Error("Text stream is not readable, perhaps it has already been read."));
            }
            inIO.on('error', reject
            ).on('end', (): void => {
                resolve();
            });
            inIO.resume();
        });
}
