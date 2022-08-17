/** Simplistic PEM file reader.
 * 
 *  PEM is "Privacy Enhanced Mail",
 *  but this module is concerned only with parsing it as text
 *  in order to infer the nature of the contents.
*/

import { readTextStream } from './common_utils';


const LF: string = "\n";
const CR: string = "\r";
const PEM_SECTION_BEGIN: string = "-----BEGIN ";
const PEM_SECTION_END: string = "-----END ";
const PEM_LABEL_END: string = "-----";

/** The content of a section of a PEM file. */
export interface PEMSection {
    label: string;
    /* data: Buffer;   // we don't need the data, but if we did, it would go here. */
}

/** Provides access to some of the content of a PEM file.
 * 
 *  PEM is a defacto standard described in RFC-7468.
 *  A PEM _file_ may contain many distinct data sections,
 *  each of which includes a "label" which identifies
 *  the purpose of the data.
 */
export class PEMFile {
    public sections: PEMSection[];

    constructor() {
        this.sections = [];
    }

    /** Read PEM data from a text stream. 
     * 
     *  The parsed "sections" of the PEM file will be available in the "sections" property.
    */
    public async readTextAsync(textStream: NodeJS.ReadableStream): Promise<void> {
        const textContent: string = await readTextStream(textStream);
        this.parseText(textContent);
    }

    /** Parse PEM data from a string. 
     * 
     *  The parsed "sections" of the PEM file will be available in the "sections" property.
    */
    public parseText(textContent: string): void {
        // Since creating a string for every line would be excessive,
        //  simply scan the text for newline chars and find only the lines we want:
        let pos0: number = 0;
        while (pos0 < textContent.length) {
            let pos1: number = textContent.indexOf(LF, pos0);
            let nextPos: number;
            if (pos1 < pos0) {
                pos1 = textContent.length;
                nextPos = pos1;
            } else {
                nextPos = pos1 + LF.length;
            }
            // PEM shouldn't have CRs in it, but what if it did?
            if (textContent.charAt(pos1-CR.length) === CR) {
                pos1 -= CR.length;
            }
            let label: string|undefined = undefined;
            if (pos0 === textContent.indexOf(PEM_SECTION_BEGIN, pos0)) {
                const labelStartPos: number = pos0 + PEM_SECTION_BEGIN.length;
                const labelEndPos: number = textContent.indexOf(PEM_LABEL_END, labelStartPos);
                if (labelEndPos > labelStartPos && labelEndPos < pos1) {
                    label = textContent.slice(labelStartPos, labelEndPos);
                }
            }
            // In practice, this PEM class is only used for discovering the labels
            //   on the sections, so we are going to skip reading the section data.
            if (label !== undefined) {
                this.sections.push({
                    label: label,
                });
            }

            pos0 = nextPos;
        }
    }
}