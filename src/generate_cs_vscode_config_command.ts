/** VS Code extension command to generate a codesonar.json configuration file. */
import { window, workspace } from 'vscode';

import { errorToString} from './common_utils';
import { 
    findActiveVSWorkspaceFolderPath,
} from './vscode_ex';
import { makeCSConfig, writeCSConfigFile } from './cs_vscode_config';

export async function executeCodeSonarVSCodeConfigCreate(
        configFileName: string,
        ) {
    const hubAddress = "hub.example.com:7340";
    const projectName = "ExampleProject";
    const csConfig = makeCSConfig(hubAddress, projectName);

    // TODO: if file already exists, then open editor on it anyway
    const csConfigFilePath = await writeCSConfigFile(csConfig, configFileName);
    const document = await workspace.openTextDocument(csConfigFilePath);
    await window.showTextDocument(document);
}
