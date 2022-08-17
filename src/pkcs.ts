/** Provides some methods for managing certificate and key files. 
 * 
 *  PKCS = "Public Key Cryptography Standards".
 *  This module only provides some purpose-built methods for inspecting client certificates.
*/

import { PEMFile } from './pem';


const PEM_LABEL_CERTIFICATE: string = "CERTIFICATE";
const PEM_LABEL_PLAINTEXT_PRIVATE_KEY: string = "PRIVATE KEY";
const PEM_LABEL_PKCS1_ENCRYPTED_PRIVATE_KEY: string = "RSA PRIVATE KEY";
const PEM_LABEL_PKCS8_ENCRYPTED_PRIVATE_KEY: string = "ENCRYPTED PRIVATE KEY";


/** Provides information about a certificate or key. */
export interface PKCSItem {
    label: string;
    isPrivate?: boolean;
    isProtected?: boolean;
}


/** Provides some basic information about a certificate or key file. */
export class PKCSFile {
    public items: PKCSItem[];

    constructor() {
        this.items = [];
    }
    
    /** Read an ASCII-encoded PKCS file from a text stream.
     * 
     *  The PKCS items will be available in the "items" property of this object.
     *  Many PKCS files have exactly one item,
     *  but some files, such as certificate chains, may have many items.
     */
    public async readTextAsync(textStream: NodeJS.ReadableStream): Promise<void> {
        const pemFile: PEMFile = new PEMFile();
        await pemFile.readTextAsync(textStream);
        this.loadPEMData(pemFile);
    }

    /** Read an ASCII-encoded PKCS file from a text stream.
     * 
     *  The PKCS items will be available in the "items" property of this object.
     *  Many PKCS files have exactly one item,
     *  but some files, such as certificate chains, may have many items.
     */
     public parseText(textContent: string): void {
        const pemFile: PEMFile = new PEMFile();
        pemFile.parseText(textContent);
        this.loadPEMData(pemFile);
    }

    private loadPEMData(pemFile: PEMFile): void {
        for (let section of pemFile.sections) {
            const item: PKCSItem = {
                    label: section.label,
                };
            if (section.label === PEM_LABEL_CERTIFICATE) {
                item.isPrivate = false;
                item.isProtected = false;
            }
            else if (section.label === PEM_LABEL_PLAINTEXT_PRIVATE_KEY) {
                item.isPrivate = true;
                item.isProtected = false;
            }
            else if (section.label === PEM_LABEL_PKCS1_ENCRYPTED_PRIVATE_KEY) {
                item.isPrivate = true;
                item.isProtected = true;
            }
            else if (section.label === PEM_LABEL_PKCS8_ENCRYPTED_PRIVATE_KEY) {
                item.isPrivate = true;
                item.isProtected = true;
            }
            this.items.push(item);
        }
    }
}