/** Implements a VSCode extension command which removes a CodeSonar hub user password saved in "secret" storage. */

import * as os from 'os';

import { SecretStorage, window } from 'vscode';

import { Logger } from './logger';
import { CSHubAddress } from './csonar_ex';
import { 
    formatHubUserPasswordStorageKey,
    CSConfigIO,
    CSProjectConfig,
} from './cs_vscode_config';


export async function executeRemoveCSHubUserPassword(
    logger: Logger,
    csConfigIO: CSConfigIO,
    secretStorage: SecretStorage,
): Promise<void> {
    let projectConfig: CSProjectConfig|undefined = await csConfigIO.readCSProjectConfig();
    let defaultHubAddressString: string = csConfigIO.defaultHubAddressString;
    let defaultHubUserName: string = os.userInfo().username;
    if (projectConfig !== undefined && projectConfig.hub !== undefined) {
        if (projectConfig.hub.address) {
            defaultHubAddressString = projectConfig.hub.address;
        }
        if (projectConfig.hub.hubuser) {
            defaultHubUserName = projectConfig.hub.hubuser;
        }
    }
    let hubAddressString: string|undefined;
    let hubUserName: string|undefined;
    hubAddressString = await window.showInputBox({
        ignoreFocusOut: true,
        value: defaultHubAddressString,
        prompt: "Hub address",
    });
    if (hubAddressString) {
        hubUserName = await window.showInputBox({
            ignoreFocusOut: true,
            value: defaultHubUserName,
            prompt: "Hub user name"
        });
    }
    if (hubAddressString && hubUserName) {
        const hubAddress: CSHubAddress = new CSHubAddress(hubAddressString);
        const passwordStorageKey: string = formatHubUserPasswordStorageKey(hubAddress, hubUserName);
        await secretStorage.delete(passwordStorageKey);
        window.showInformationMessage(`Cleared password for user '${hubUserName}' at '${hubAddressString}'.`);
    }
}
