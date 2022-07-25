/** VS Code extension command to generate a codesonar.json configuration file. */
import {
    TextDocument,
    window,
    workspace,
} from 'vscode';

import { errorToString} from './common_utils';
import { 
    findActiveVSWorkspaceFolderPath,
} from './vscode_ex';
import { 
    CSConfig,
    makeCSConfig,
    writeCSConfigFile,
} from './cs_vscode_config';

export async function executeCodeSonarVSCodeConfigCreate(
        configFileName: string,
): Promise<void> {
    const hubAddress: string = "hub.example.com:7340";
    const projectName: string = "ExampleProject";
    const csConfig: CSConfig = makeCSConfig(hubAddress, projectName);

    // TODO: if file already exists, then open editor on it anyway
    const csConfigFilePath: string = await writeCSConfigFile(csConfig, configFileName);
    const document: TextDocument = await workspace.openTextDocument(csConfigFilePath);
    await window.showTextDocument(document);
}
