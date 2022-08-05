import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
    window,
    CancellationToken,
    Progress,
    ProgressLocation,
    QuickPick,
    QuickPickItem,
    SecretStorage,
    Uri,
} from 'vscode';

import { 
    asErrnoException,
    errorToString,
    replaceInvalidFileNameChars,
} from './common_utils';
import { Logger } from './logger';
import { 
    findActiveVSWorkspaceFolderPath,
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
import * as sarifView from './sarif_viewer';


const SARIF_EXT_NAME: string = 'sarif';
const SARIF_EXT: string = '.' + SARIF_EXT_NAME;

interface QuickPickValueItem<T> extends QuickPickItem {
    value: T;
}

type IncrementalProgress = Progress<{message?: string, increment?: number}>;

/** Format a string that can be used as a lookup key for a hub user password in a password store. */
function formatHubUserPasswordStorageKey(hubAddress: CSHubAddress, hubUserName: string): string {
    return csConfig.formatHubUserPasswordStorageKey(hubAddress, hubUserName);
}

export async function executeCodeSonarFullSarifDownload(
        logger: Logger,
        csConfigIO: csConfig.CSConfigIO,
        secretStorage: SecretStorage,
    ): Promise<void> {
    const withAnalysisBaseline: boolean = false;
    await executeCodeSonarSarifDownload(logger, csConfigIO, secretStorage, withAnalysisBaseline);
}

export async function executeCodeSonarDiffSarifDownload(
        logger: Logger,
        csConfigIO: csConfig.CSConfigIO,
        secretStorage: SecretStorage,
    ): Promise<void> {
    const withAnalysisBaseline: boolean = true;
    await executeCodeSonarSarifDownload(logger, csConfigIO, secretStorage, withAnalysisBaseline);
}

async function executeCodeSonarSarifDownload(
        logger: Logger,
        csConfigIO: csConfig.CSConfigIO,
        secretStorage: SecretStorage,
        withAnalysisBaseline: boolean,
        ): Promise<void> {
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
    const projectConfig: csConfig.CSProjectConfig|undefined = await csConfigIO.readCSProjectConfig();
    const extensionOptions: csConfig.CSExtensionOptions = await csConfigIO.readCSEXtensionOptions();
    let projectPath: string|undefined;
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
    let inputHubAddressString: string|undefined;
    let inputHubUserName: string|undefined;
    if (projectConfig) {
        if (projectConfig.path && typeof projectConfig.path === "string") {
            projectPath = projectConfig.path;
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
    if (!hubAddressString) {
        const defaultHubAddressString = csConfigIO.defaultHubAddressString;
        inputHubAddressString = await window.showInputBox(
            {
                ignoreFocusOut: true,
                prompt: "Hub Address",
                value: defaultHubAddressString,
            }
        );
        hubAddressString = inputHubAddressString;
        if (hubAddressString && !hubUserName) {
            // Get a non-empty string that can be used as the name of the anonymous user:
            const anonymousUserName = csConfigIO.anonymousUserName;
            inputHubUserName = await window.showInputBox(
                {
                    ignoreFocusOut: true,
                    prompt: "Hub User",
                    value: anonymousUserName,
                }
            );
            if (inputHubUserName === undefined) {
                // User cancelled the username prompt,
                //  interpret this to mean that they don't want to connect to the hub at all:
                hubAddressString = undefined;
            }
            else if (inputHubUserName === anonymousUserName) {
                // empty string is our signal that anonymous auth should be used.
                hubUserName = "";
                inputHubUserName = "";
            }
            else {
                hubUserName = inputHubUserName;
            }
        }
        // We will need to save the "input" data back to the user's settings,
        //  but we must wait until we know that this data works for hub sign-in.
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
        passwordStorageKey = formatHubUserPasswordStorageKey(hubAddressObject, hubUserName);
    }
    if (hubUserCertFilePath) {
        // If cert file path is specified, but key file path is not,
        //  try to guess key file name:
        // This is a feature intended to make it less cumbersome to specify certificate authentication settings.
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
            await secretStorage.delete(passwordStorageKey);
        }
    } else if (hubAddressString && hubUserName && passwordStorageKey) {
        // Make type-checker happy by providing an unconditional string var:
        const passwordStorageKeyString: string = passwordStorageKey;
        const username: string = hubUserName;
        const address: string = hubAddressString;
        hubClientOptions.hubpasswd = () => new Promise<string>((resolve, reject) => {
            secretStorage.get(passwordStorageKeyString).then((password) => {
                if (password !== undefined) {
                    logger.info("Found saved password");
                    resolve(password);
                }
                else {
                    window.showInputBox({
                        password: true,
                        prompt: `Enter password for CodeSonar hub user '${username}' at '${address}'`,
                        placeHolder: 'password',
                        ignoreFocusOut: true,
                    }).then(
                        (inputValue: string|undefined): void => {
                            if (inputValue === undefined) {
                                // TODO this error will be caught when we catch signin errors.
                                //  we should detect and ignore the error in that case.
                                reject(new Error("User cancelled password input"));
                            }
                            else {
                                secretStorage.store(passwordStorageKeyString, inputValue).then(
                                    (): void => {
                                        resolve(inputValue);
                                    },
                                    reject,
                                );
                            }
                        },
                        reject);
                }
            });
        }); 
    }
    let certificateNotTrustedError: Error|undefined;
    if (hubAddressObject !== undefined) {
        hubClient = new CSHubClient(hubAddressObject, hubClientOptions);
        hubClient.logger = logger;
        let signInSucceeded: boolean = false;
        try {
            // TODO: if sign-in failed, we'd like to know exactly why.  Need to get 403 response body.
            // signIn will return false if hub returns HTTP 403 Forbidden.
            //  signIn may throw an error if some other signIn problem occurs (e.g. cannot connect to server).
            signInSucceeded = await verifyHubCredentials(hubClient);
            if (!signInSucceeded) {
                throw Error("Access forbidden");
            }
        }
        catch (e: any) {
            const messageHeader: string = "CodeSonar hub sign-in failure";
            const messageBody: string = errorToString(e, { message: "Internal Error"});
            const errorMessage = `${messageHeader}: ${messageBody}`;
            const e2: NodeJS.ErrnoException = new Error(errorMessage);
            const ex: NodeJS.ErrnoException|undefined = asErrnoException(e);
            const errorName: string|undefined = ex?.code;
            e2.code = errorName;
            if (errorName === 'DEPTH_ZERO_SELF_SIGNED_CERT'
                    || errorName === 'SELF_SIGNED_CERT_IN_CHAIN'
            ) {
                certificateNotTrustedError = e2;
            } else {
                throw e2;
            }
        }
        finally {
            if (!signInSucceeded && passwordStorageKey) {
                secretStorage.delete(passwordStorageKey);
            }
        }
        if (certificateNotTrustedError) {
            // We will inform the user about the certificate problem later.
            // Don't try to make any more connections:
            hubClient = undefined;
        }
    }
    let projectInfoArray: CSProjectInfo[]|undefined;
    if (hubClient && !projectId) {
        projectInfoArray = await fetchCSProjectRecords(hubClient, projectPath);
    }
    if (hubClient && projectInfoArray && projectInfoArray.length < 1 && projectPath) {
        // We tried to fetch the project by its path, but it was not found.
        //  Get the entire list of projects,
        //   we will need to ask the user to pick one:
        projectInfoArray = await fetchCSProjectRecords(hubClient);
    }
    let inputProjectInfo: CSProjectInfo|undefined;
    let projectInfo: CSProjectInfo|undefined;
    if (projectInfoArray && projectInfoArray.length === 1) {
        // TODO: what if the hub has exactly one project,
        //  and the projectPath does not match it?
        //  Should we show the picker with just one selectable item?
        projectInfo = projectInfoArray[0];
    }
    else if (projectInfoArray && projectInfoArray.length > 1) {
        inputProjectInfo = await showProjectQuickPick(projectInfoArray);
        projectInfo = inputProjectInfo;
    }
    else if (projectInfoArray !== undefined && projectInfoArray.length < 1) {
        // One way this can happen is if Anonymous is not allowed to see the project list,
        //  but anonymous authentication was used (perhaps unintentionally).
        window.showInformationMessage("Could not find any analysis projects on CodeSonar hub.");
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
        if (!withAnalysisBaseline) {
            // We won't need to find a baseline analysis.
            // pass;
        }
        // If there is only one available analysis on the hub,
        //  then we won't be able to compare two analyses.
        else if (analysisInfoArray.length === 1) {
            throw new Error("Not enough analyses were found on the hub to do a baseline comparison.");
        }
        else if (baseAnalysisId !== undefined) {
            baseAnalysisInfo = analysisInfoArray.find(a => (a.id === baseAnalysisId));
            if (baseAnalysisInfo === undefined) {
                throw new Error("Baseline analysis was not found");
            }
        }
        else if (baseAnalysisName) { // could be empty string or undefined
            baseAnalysisInfo = analysisInfoArray.find(a => (a.name === baseAnalysisName));
            if (baseAnalysisInfo === undefined) {
                throw new Error("Baseline analysis was not found");
            }
        }
        else {
            baseAnalysisInfo = await showAnalysisQuickPick(analysisInfoArray, "Select a Baseline Analysis...");
            // TODO: show some user feedback to indicate that baseline was chosen,
            //  the two identical quickpicks shown one after another is going to be confusing.
        }
        let targetAnalysisInfoArray: CSAnalysisInfo[] = analysisInfoArray;
        if (baseAnalysisInfo !== undefined) {
            targetAnalysisInfoArray = [];
            for (analysisInfo of analysisInfoArray) {
                if (analysisInfo.id !== baseAnalysisInfo.id) {
                    targetAnalysisInfoArray.push(analysisInfo);
                }
            }
        }
        // Prompt if we didn't need a baseline,
        //  or if we needed a baseline and we have one.
        // If we need a baseline and we don't have one,
        //  then the user must have cancelled,
        //  so don't annoy them with another prompt.
        if (targetAnalysisInfoArray.length < 1) {
            // We check that some analyses were found prior to getting here,
            //  and we check that there are many analyses prior to filtering out the baseline analysis,
            //  so we should never hit this case:
            assert.fail("Analyses were expected, but none were found");
        }
        else if (!withAnalysisBaseline || baseAnalysisInfo !== undefined) {
            analysisInfo = await showAnalysisQuickPick(targetAnalysisInfoArray, "Select an Analysis...");
        }
    }
    let destinationUri: Uri|undefined;
    if (analysisInfo !== undefined
        || certificateNotTrustedError
        ) {
        // If the user gets this far, and if we prompted them to choose some settings,
        //   then save their settings:
        //  In the case of a certificate error, we save the settings anyway
        //    since the user may be able to tweak the settings to make the connection work.
        //  We could save these settings at other stages of the prompt sequence.
        //   Saving settings at this stage attempts to strike a balance 
        //   between saving settings that are known to work
        //   and not saving settings that the user wants to keep.
        let writeCount: number = 0;
        if (inputHubAddressString) {
            await csConfigIO.writeHubAddress(inputHubAddressString);
            writeCount += 1;
            if (inputHubUserName !== undefined) {
                await csConfigIO.writeHubUserName(inputHubUserName);
                writeCount += 1;
            }
        }
        if (inputProjectInfo !== undefined) {
            await csConfigIO.writeProjectPath(inputProjectInfo.path);
            writeCount += 1;
        }
        if (writeCount > 0) {
            window.showInformationMessage("CodeSonar settings have been saved.");
        }
    }
    if (certificateNotTrustedError) {
        window.showInformationMessage(
            "Hub HTTPS certificate is not trusted, "
            + "try updating the CodeSonar Extension's 'Hub Authority Certificate' setting.");        
        throw certificateNotTrustedError;
    }
    if (analysisInfo !== undefined) {
        const defaultFileName: string = replaceInvalidFileNameChars(analysisInfo.name);
        let defaultDestinationPath: string = defaultFileName + SARIF_EXT;
        if (workspaceFolderPath !== undefined) {
            // TODO: remember previous saved path and compute default based on it.
            defaultDestinationPath = path.join(workspaceFolderPath, defaultDestinationPath);
        }
        destinationUri = await showSarifSaveDialog(defaultDestinationPath);
    }
    if (hubClient !== undefined
        && analysisInfo !== undefined
        && destinationUri !== undefined
    ) {
        const destinationFilePath: string = destinationUri.fsPath;
        const destinationFileName: string = path.basename(destinationFilePath);
        await downloadSarifResults(hubClient, destinationFilePath, analysisInfo, baseAnalysisInfo);
        if (extensionOptions.autoOpenSarifViewer) {
            await sarifView.showSarifDocument(destinationUri);
        }
        else {
            window.showInformationMessage(`Downloaded CodeSonar Analysis to '${destinationFileName}'`);
        }
    }
}

/** Try to sign-in to hub.
 * 
 *  @return True if sign-in succeeded, False if sign-in was rejected.
 *  @throws Error Sign-in process failed, perhaps due to network error.
 */
async function verifyHubCredentials(hubClient: CSHubClient): Promise<boolean> {
    return await window.withProgress<boolean>({
            cancellable: false,
            location: ProgressLocation.Window,
            title: "connecting to CodeSonar hub",
        },
        (
            progress: IncrementalProgress,
            cancelToken: CancellationToken,
        ): Thenable<boolean> => {
            let signInSucceeded: boolean = false;
            return hubClient.signIn();
        });
}

async function fetchCSProjectRecords(hubClient: CSHubClient, projectPath?: string): Promise<CSProjectInfo[]> {
    return await window.withProgress<CSProjectInfo[]>({
            cancellable: false,
            location: ProgressLocation.Window,
            title: "fetching CodeSonar projects",
        },
        (
            progress: IncrementalProgress,
            cancelToken: CancellationToken,
        ): Thenable<CSProjectInfo[]> => {
            return hubClient.fetchProjectInfo(projectPath);
        });   
}

/** Request list of analyses from the hub. */
async function fetchCSAnalysisRecords(hubClient: CSHubClient, projectId: CSProjectId): Promise<CSAnalysisInfo[]> {
    return await window.withProgress<CSAnalysisInfo[]>({
            cancellable: false,
            location: ProgressLocation.Window,
            title: "fetching CodeSonar analyses",
        },
        (
            progress: IncrementalProgress,
            cancelToken: CancellationToken,
        ): Thenable<CSAnalysisInfo[]> => {
            return hubClient.fetchAnalysisInfo(projectId);
        });
}

/** Show QuickPick widget to allow user to pick an analysis project. */
async function showProjectQuickPick(projectInfoArray: CSProjectInfo[]): Promise<CSProjectInfo|undefined> {
    // case-insenstive sorting collator:
    const collatorOptions: Intl.CollatorOptions = { usage: "sort", sensitivity: "accent" };
    const collator: Intl.Collator = new Intl.Collator(undefined, collatorOptions);
    let sortedProjectInfoArray: CSProjectInfo[] = Array.from(projectInfoArray);
    sortedProjectInfoArray.sort(
        (p1: CSProjectInfo, p2: CSProjectInfo): number => {
            const lc: number = collator.compare(p1.path, p2.path);
            if (lc !== 0) {
                return lc;
            }
            else if (p1.id > p2.id) {
                return 1;
            }
            else if (p1.id < p2.id) {
                return -1;
            }
            return 0;
        });
    return showQuickPick(
            "Select a Project...",
            sortedProjectInfoArray,
            ((p: CSProjectInfo): QuickPickItem => ({ label: p.path, description: `/project/${p.id}` }) ),
            );

}

/** Show QuickPick widget to allow user to pick an analysis. */
async function showAnalysisQuickPick(
        analysisInfoArray: CSAnalysisInfo[],
        placeholder: string,
    ): Promise<CSAnalysisInfo|undefined> {
    return showQuickPick(
            placeholder,
            analysisInfoArray,
            ((a: CSAnalysisInfo): QuickPickItem => ({ label: a.name, description: `/analysis/${a.id}` }) ),
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
    return new Promise<T|undefined>((
        resolve: (value: T|undefined) => void,
        reject: (e: any) => void,
    ) => {
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
    return await window.showSaveDialog({
            filters: {
                /* eslint-disable @typescript-eslint/naming-convention */
                'All Files': ['*'],
                'SARIF': [SARIF_EXT_NAME],
                /* eslint-disable @typescript-eslint/naming-convention */
            },
            title: 'Save CodeSonar SARIF analysis results',
            defaultUri: defaultUri,
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
    await window.withProgress({
        location: ProgressLocation.Notification,
        title: "Downloading CodeSonar analysis...",
        cancellable: true,
    }, (
        progress: IncrementalProgress,
        token: CancellationToken,
    ) => {
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
            ((progressSize: number, timeout: number) => {
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
                    ).on('finish', (): void => {
                        resolve();
                    });
            }).catch(reject);
        });
    });
}
