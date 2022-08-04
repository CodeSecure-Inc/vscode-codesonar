/** Interact with the Microsoft Sarif Viewer extension for VS Code. */
import {
    extensions,
    Extension,
    Uri,
} from 'vscode';


const MS_SARIF_VIEWER_ID: string = 'MS-SarifVSCode.sarif-viewer';


interface MSSarifViewerExports {
    openLogs: (logs: Uri[]) => Thenable<void>;
}


/** Show a SARIF file using the Microsoft Sarif Viewer extension.
 * 
*/
export async function showSarifDocument(fileUri: Uri): Promise<void> {
    const sarifExt: Extension<MSSarifViewerExports>|undefined = extensions.getExtension<MSSarifViewerExports>(MS_SARIF_VIEWER_ID);
    if (sarifExt === undefined) {
        throw new Error("Microsoft Sarif Viewer extension was not found.");
    }
    else {
        if (!sarifExt.isActive) {
            await sarifExt.activate();
        }
        await sarifExt.exports.openLogs([fileUri,]);    
    }
}
