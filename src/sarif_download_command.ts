import * as fs from 'fs';
import { 
    access as accessFile,
    readFile,
} from 'fs/promises';
import * as path from 'path';

import {
    window,
    workspace,
    ProgressLocation,
    QuickPick,
    QuickPickItem,
    SecretStorage,
    Uri,
    WorkspaceConfiguration,
} from 'vscode';

import { errorToString } from './common_utils';
import { 
    findActiveVSWorkspaceFolderPath,
    findVSConfigFilePath,
} from './vscode_ex';
import * as csConfig from './cs_vscode_config';
import { 
    parseCSProjectId,
    parseCSAnalysisId,
    CSHubAddress,
    CSHubClient,
    CSHubClientConnectionOptions,
    CSProjectId,
    CSProjectInfo,
    CSAnalysisId,
    CSAnalysisInfo,
} from './cs_hub_client';


const SARIF_EXT_NAME: string = 'sarif';
const SARIF_EXT: string = '.' + SARIF_EXT_NAME;

interface QuickPickValueItem<T> extends QuickPickItem {
    value: T;
}

/** Formats a string that encodes both the hub address and user name. */
function formatUserHubAddress(hubAddress: CSHubAddress, username: string): string {
    let userHubAddressString: string = `${username}@{$hubAddress.hostname}`;
    if (hubAddress.protocol !== undefined) {
        userHubAddressString = `${hubAddress.protocol}://${userHubAddressString}`;
    }
    if (hubAddress.port !== undefined) {
        const portString: string = hubAddress.port.toString();
        userHubAddressString = `${userHubAddressString}:${portString}`;
    }

    return userHubAddressString;
}

export async function executeCodeSonarSarifDownload(
        configFileName: string,
        secretStorage: SecretStorage,
        ) {
    const workspaceFolderPath: string|undefined = findActiveVSWorkspaceFolderPath();
    const resolveFilePath: ((filePath:string) => string) = (filePath: string) => {
        // normalize path seps
        let outFilePath = path.normalize(filePath);
        if (!path.isAbsolute(outFilePath) && workspaceFolderPath) {
            outFilePath = path.join(workspaceFolderPath, outFilePath);
        }
        // normalize parent dir references
        outFilePath = path.normalize(outFilePath);
        return outFilePath;
    };
    // This will get a "default" projectConfig based on VSCode settings.
    //  If there is a codesonar.json file, this default projectConfig will be ignored.
    let projectConfig: csConfig.CSProjectConfig|undefined = csConfig.getCSWorkspaceSettings();
    // TODO remove support for codesonar.json configuration
    const configFilePath: string|undefined = findVSConfigFilePath(configFileName, workspaceFolderPath);
    if (projectConfig === undefined && configFilePath === undefined) {
        throw new Error("Could not find CodeSonar hub settings.");
    }
    let configFileExists: boolean = false;
    if (configFilePath !== undefined && configFilePath.length > 0) {
        try {
            await accessFile(configFilePath, fs.constants.R_OK);
            configFileExists = true;
        } catch {
            // pass;
        }
    }
    if (configFileExists) {
        const config: csConfig.CSConfig = await csConfig.readCSConfigFile(configFileName, workspaceFolderPath);
        if (config.projects && config.projects.length) {
            // TODO user picks the project configuration they want
            projectConfig = config.projects[0];
        }
    }
    let projectName: string|undefined;
    let projectId: CSProjectId|undefined;
    let baseAnalysisName: string|undefined;
    let baseAnalysisId: CSAnalysisId|undefined;
    let hubConfig: csConfig.CSHubConfig|undefined;
    let hubAddressString: string|undefined;
    let hubCAFilePath: string|undefined;
    let hubUserName: string|undefined;
    let hubUserPasswordFilePath: string|undefined;
    let hubUserCertFilePath: string|undefined;
    let hubUserCertKeyFilePath: string|undefined;
    if (projectConfig) {
        if (projectConfig.name && typeof projectConfig.name === "string") {
            projectName = projectConfig.name;
        }
        if (projectConfig.id !== undefined)
        {
            projectId = parseCSProjectId(projectConfig.id);
        }
        if (projectConfig.hub) {
            if (typeof projectConfig.hub === "string") {
                hubAddressString = projectConfig.hub;
            }
            else {
                hubConfig = projectConfig.hub as csConfig.CSHubConfig;
            }
        }
        if (projectConfig.baselineAnalysis === undefined) {
            // ignore
        }
        else if (typeof projectConfig.baselineAnalysis === "string") {
            baseAnalysisName = projectConfig.baselineAnalysis;
        }
        else if (projectConfig.baselineAnalysis.id !== undefined) {
            baseAnalysisId = parseCSAnalysisId(projectConfig.baselineAnalysis.id);
        }
        else if (projectConfig.baselineAnalysis.name !== undefined) {
            baseAnalysisName = projectConfig.baselineAnalysis.name;
        }
    }
    if (hubConfig) {
        hubAddressString = hubConfig.address;
        hubCAFilePath = hubConfig.cacert;
        hubUserName = hubConfig.hubuser;
        hubUserPasswordFilePath = hubConfig.hubpwfile;
        hubUserCertFilePath = hubConfig.hubcert;
        hubUserCertKeyFilePath = hubConfig.hubkey;
    }
    let hubAddressObject: CSHubAddress|undefined;
    if (hubAddressString) {
        hubAddressObject = new CSHubAddress(hubAddressString);
    }
    let hubClientOptions: CSHubClientConnectionOptions = {};
    let hubClient: CSHubClient|undefined;
    if (hubCAFilePath) {
        hubCAFilePath = resolveFilePath(hubCAFilePath);
        hubClientOptions.cafile = hubCAFilePath;
    }
    if (hubUserName) {
        hubClientOptions.hubuser = hubUserName;
    }
    let passwordStorageKey: string|undefined;
    if (hubAddressObject && hubUserName) {
        const userHubAddressString = formatUserHubAddress(hubAddressObject, hubUserName);
        passwordStorageKey = `codesonar:hubpasswd::${userHubAddressString}`;
    }
    if (hubUserCertFilePath) {
        // If key file path is not specified, try some default file names:
        if (hubUserCertKeyFilePath === undefined) {
            let certSuffix: string = ".cert";
            let keySuffix: string = ".key";
            if (hubUserCertFilePath.endsWith(certSuffix)) {
                hubUserCertKeyFilePath = hubUserCertFilePath.substring(0, hubUserCertFilePath.length - certSuffix.length) + keySuffix;
            }
            else {
                certSuffix += ".pem";
                keySuffix += ".pem";
                if (hubUserCertFilePath.endsWith(certSuffix)) {
                    hubUserCertKeyFilePath = hubUserCertFilePath.substring(0, hubUserCertFilePath.length - certSuffix.length) + keySuffix;
                }
            }
        }
        if (hubUserCertKeyFilePath === undefined) {
            hubUserCertKeyFilePath = hubUserCertFilePath + ".key";
        }
        hubUserCertFilePath = resolveFilePath(hubUserCertFilePath);
        hubUserCertKeyFilePath = resolveFilePath(hubUserCertKeyFilePath);
        hubClientOptions.hubcert = hubUserCertFilePath;
        hubClientOptions.hubkey = hubUserCertKeyFilePath;
    }
    else if (hubUserPasswordFilePath) {
        hubUserPasswordFilePath = resolveFilePath(hubUserPasswordFilePath);
        hubClientOptions.hubpwfile = hubUserPasswordFilePath;
        // Don't keep password sitting around if user changed auth method:
        //  This is complicated since a user could use password auth in one VS Code window
        //   and password file auth in a different VS Code window.
        //   By deleting the password from storage when they change to password file auth in one window,
        //    we will cause them to be prompted for a password again in the other window.
        if (passwordStorageKey) {
            secretStorage.delete(passwordStorageKey);
        }
    } else if (hubAddressString && hubUserName && passwordStorageKey) {
        // Make type-checker happy by providing an unconditional string var:
        const passwordStorageKeyString: string = passwordStorageKey;
        const username: string = hubUserName;
        const address: string = hubAddressString;
        hubClientOptions.hubpasswd = () => new Promise<string>((resolve, reject) => {
            secretStorage.get(passwordStorageKeyString).then((password) => {
                if (password !== undefined) {
                    console.log("Found saved password");
                    resolve(password);
                }
                else {
                    window.showInputBox({
                        password: true,
                        prompt: `Enter password for CodeSonar hub user '${username}' at '${address}'`,
                        placeHolder: 'password',
                        ignoreFocusOut: true,
                    }).then((inputValue) => {
                        if (inputValue === undefined) {
                            reject(new Error("User cancelled password input."));
                        }
                        else {
                            secretStorage.store(passwordStorageKeyString, inputValue);
                            resolve(inputValue);
                        }
                    },
                    reject);
                }
            });
        }); 
    }
    if (hubAddressObject === undefined) {
        throw Error("No hub address found in json config file.");
    }
    else {
        hubClient = new CSHubClient(hubAddressObject, hubClientOptions);
        let signInSucceeded: boolean = false;
        try {
            // signIn will return false if hub returns HTTP 403 Forbidden.
            //  signIn may throw an error if some other signIn problem occurs (e.g. cannot connect to server).
            signInSucceeded = await hubClient.signIn();
            if (!signInSucceeded) {
                throw Error("Access forbidden");
            }
        }
        catch (e) {
            const messageHeader: string = "CodeSonar hub sign-in error";
            let errorMessage: string = errorToString(e);
            if (errorMessage) {
                errorMessage = messageHeader + ": " + errorMessage;
            }
            else {
                errorMessage = messageHeader;
            }
            throw new Error(errorMessage);
        }
        finally {
            if (!signInSucceeded && passwordStorageKey) {
                secretStorage.delete(passwordStorageKey);
            }
        }
    }
    // TODO: show progress/spinner when fetching project or analysis lists
    //  Alternatively, consider opening quickpick immediately
    //   and filling it with a placeholder until actual results are available.
    let projectInfoArray: CSProjectInfo[]|undefined;
    if (hubClient && !projectId) {
        projectInfoArray = await fetchCSProjectRecords(hubClient, projectName);
    }
    if (hubClient && projectInfoArray && projectInfoArray.length < 1 && projectName) {
        // Probably the projectName didn't match any existing projects,
        //  ask user to pick a project.
        projectInfoArray = await fetchCSProjectRecords(hubClient);
        if (projectInfoArray.length < 1) {
            window.showInformationMessage("Could not find any analysis projects on CodeSonar hub.");
        }
    }
    let projectInfo: CSProjectInfo|undefined;
    if (projectInfoArray && projectInfoArray.length === 1) {
        // TODO: what if the hub has exactly one project,
        //  and the projectName does not match it?
        //  Should we show the picker with just one selectable item?
        projectInfo = projectInfoArray[0];
    }
    else if (projectInfoArray && projectInfoArray.length > 1) {
        projectInfo = await showProjectQuickPick(projectInfoArray);
    }
    if (!projectId && projectInfo) {
        projectId = projectInfo.id;
    }
    let analysisInfoArray: CSAnalysisInfo[]|undefined;
    if (hubClient && projectId) {
        analysisInfoArray = await fetchCSAnalysisRecords(hubClient, projectId);
    }
    let analysisInfo: CSAnalysisInfo|undefined;
    let baseAnalysisInfo: CSAnalysisInfo|undefined;
    if (analysisInfoArray && analysisInfoArray.length) {
        if (baseAnalysisId !== undefined) {
            baseAnalysisInfo = analysisInfoArray.find(a => (a.id === baseAnalysisId));
            if (baseAnalysisInfo === undefined) {
                throw new Error("Baseline analysis was not found");
            }
        }
        else if (baseAnalysisName !== undefined) {
            baseAnalysisInfo = analysisInfoArray.find(a => (a.name === baseAnalysisName));
            if (baseAnalysisInfo === undefined) {
                throw new Error("Baseline analysis was not found");
            }
        }
        analysisInfo = await showAnalysisQuickPick(analysisInfoArray);
    }
    let destinationUri: Uri|undefined;
    if (analysisInfo !== undefined) {
        const defaultFileName: string = analysisInfo.name;
        let defaultDestinationPath: string = defaultFileName + SARIF_EXT;
        if (workspaceFolderPath !== undefined) {
            // TODO: remember previous saved path and compute default based on it.
            defaultDestinationPath = path.join(workspaceFolderPath, defaultDestinationPath);
        }
        destinationUri = await showSarifSaveDialog(defaultDestinationPath);
    }
    if (hubClient !== undefined
        && analysisInfo !== undefined
        && destinationUri !== undefined) {
        await downloadSarifResults(hubClient, destinationUri.fsPath, analysisInfo, baseAnalysisInfo);
    }  
}

async function fetchCSProjectRecords(hubClient: CSHubClient, projectName?: string): Promise<CSProjectInfo[]> {
    // window.withProgress returns Thenable, but an async function must return a Promise.
    return new Promise<CSProjectInfo[]>((resolve, reject) => {
        window.withProgress<CSProjectInfo[]>({
            cancellable: false,
            location: ProgressLocation.Window,
            title: "fetching CodeSonar projects",
        },
        (progress, cancelToken) => {
            // TODO this returns a promise, but could it also raise an error?
            return hubClient.fetchProjectInfo(projectName);
        }).then(resolve, reject);
    });
}

/** Request list of analyses from the hub. */
async function fetchCSAnalysisRecords(hubClient: CSHubClient, projectId: CSProjectId): Promise<CSAnalysisInfo[]> {
    // window.withProgress returns Thenable, but an async function must return a Promise.
    return new Promise<CSProjectInfo[]>((resolve, reject) => {
        window.withProgress<CSProjectInfo[]>({
            cancellable: false,
            location: ProgressLocation.Window,
            title: "fetching CodeSonar analyses",
        },
        (progress, cancelToken) => {
            // TODO this returns a promise, but could it also raise an error?
            return hubClient.fetchAnalysisInfo(projectId);
        }).then(resolve, reject);
    });
}

/** Show QuickPick widget to allow user to pick an analysis project. */
async function showProjectQuickPick(projectInfoArray: CSProjectInfo[]): Promise<CSProjectInfo|undefined> {
    return showQuickPick(
            "Select a Project...",
            projectInfoArray,
            (p => ({ label: p.id, description: p.name }) ),
            );

}

/** Show QuickPick widget to allow user to pick an analysis. */
async function showAnalysisQuickPick(analysisInfoArray: CSAnalysisInfo[]): Promise<CSAnalysisInfo|undefined> {
    return showQuickPick(
            "Select an Analysis...",
            analysisInfoArray,
            (a => ({ label: a.id, description: a.name }) ),
            );
}

/** High-level wrapper to show a vscode QuickPick and to return a Promise. */
async function showQuickPick<T>(
        placeholder: string,
        values: readonly T[],
        value2QuickPickItem: ((v: T) => QuickPickItem),
        ): Promise<T|undefined> {
    const quickPick: QuickPick<QuickPickItem> = window.createQuickPick();
    quickPick.items = values.map(x => {
            const item: QuickPickItem = value2QuickPickItem(x);
            return {
                label: item.label,
                description: item.description,
                value: x,
            };
        });
    quickPick.placeholder = placeholder;
    return new Promise<T|undefined>((resolve, reject) => {
        let pickedValue: T|undefined;
        let changeSelection = (selectedItems: readonly QuickPickItem[]) => {
            if (selectedItems.length) {
                let selectedItem: QuickPickValueItem<T> = selectedItems[0] as QuickPickValueItem<T>;
                pickedValue = selectedItem.value;
            }
        };
        quickPick.onDidAccept(() => {
            changeSelection(quickPick.selectedItems);
            quickPick.hide();
            resolve(pickedValue);
        });
        quickPick.onDidHide(() => {
            quickPick.dispose();
            resolve(pickedValue);
        });
        if (values.length) {
            quickPick.show();
        }
        else {
            resolve(pickedValue);
        }
    });
}


/** Show SaveAs dialog for SARIF download. */
async function showSarifSaveDialog(defaultFilePath: string): Promise<Uri|undefined> {
    const defaultUri = Uri.file(defaultFilePath);
    return new Promise<Uri|undefined> ((resolve, reject) => {
        window.showSaveDialog({
            filters: {
                /* eslint-disable @typescript-eslint/naming-convention */
                'All Files': ['*'],
                'SARIF': [SARIF_EXT_NAME],
                /* eslint-disable @typescript-eslint/naming-convention */
            },
            title: 'Save CodeSonar SARIF analysis results',
            defaultUri: defaultUri,
        }).then(resolve);
    });
}

async function downloadSarifResults(
        hubClient: CSHubClient,
        destinationFilePath: string,
        analysisInfo: CSAnalysisInfo,
        baseAnalysisInfo?: CSAnalysisInfo,
        ): Promise<void> {
    const analysisId: CSAnalysisId = analysisInfo.id;
    const baseAnalysisId: CSAnalysisId|undefined = baseAnalysisInfo?.id;
    const destinationFileName: string = path.basename(destinationFilePath);
    window.withProgress({
        location: ProgressLocation.Notification,
        title: "Downloading CodeSonar analysis...",
        cancellable: true,
    }, (progress, token) => {
        // TODO: download to temporary location and move it when finished
        const destinationStream: NodeJS.WritableStream = fs.createWriteStream(destinationFilePath);

        token.onCancellationRequested(() => {
            // TODO abort download.  Cleanup files on disk.
        });
        progress.report({increment: 0});
        // TODO Report actual progress downloading
        //  This just counts a few seconds and leaves the bar mostly full until the download completes:
        const delay: number = 1000;
        // Total length of progress meter according to documentation:
        const maxProgressSize: number = 100;
        // Progress meter item where we hang until download completes:
        //  Even though this is 40%, this appears to fill the bar about 80%.
        //   Anything larger and the bar will appear full.
        const hangingProgressSize: number = 40;
        const progressStepCount: number = 5;
        const stepSize: number = hangingProgressSize / progressStepCount;
        for (let i: number = 1*stepSize,  t = delay;
                i < hangingProgressSize;
                i += stepSize,  t += delay) {
            ((progressSize, timeout) => {
                setTimeout(() => {
                    progress.report({increment: progressSize});
                }, 1*timeout);    
            })(i, t);
        }
        let sarifPromise: Promise<NodeJS.ReadableStream>;
        if (baseAnalysisId !== undefined) {
            sarifPromise = hubClient.fetchSarifAnalysisDifferenceStream(analysisId, baseAnalysisId);
        }
        else {
            sarifPromise = hubClient.fetchSarifAnalysisStream(analysisId);
        }
        return new Promise<void>((resolve, reject) => {
            sarifPromise.then((sarifStream) => {
                sarifStream.pipe(destinationStream
                    ).on('error', reject
                    ).on('finish', () => {
                        window.showInformationMessage(`Downloaded CodeSonar Analysis to '${destinationFileName}'`);
                        resolve();
                    });
            }).catch(reject);
        });
    });
}
