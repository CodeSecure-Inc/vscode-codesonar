import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

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
import {
    loadCSHubUserKey,
    CSHubAddress,
    CSProjectFile,
} from './csonar_ex';
import * as csConfig from './cs_vscode_config';
import { 
    parseCSAnalysisId,
    CSHubClient,
    CSHubClientConnectionOptions,
    CSProjectId,
    CSProjectInfo,
    CSAnalysisId,
    CSAnalysisInfo,
    CSHubSarifSearchOptions,
    CSHubVersionCompatibilityInfo,
} from './cs_hub_client';
import * as sarifView from './sarif_viewer';


const SARIF_EXT_NAME: string = 'sarif';
const SARIF_EXT: string = '.' + SARIF_EXT_NAME;

const CS_WARN_DIFF_EXT: string = '.new';

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
    const extensionVersionInfo: csConfig.ExtensionVersionInfo = csConfigIO.extensionVersionInfo;
    let projectPath: string|undefined;
    let projectId: CSProjectId|undefined;
    let baseAnalysisName: string|undefined;
    let baseAnalysisId: CSAnalysisId|undefined;
    let hubConfig: csConfig.CSHubConfig|undefined;
    let hubAddressString: string|undefined;
    let hubCAFilePath: string|undefined;
    let hubSocketTimeout: number|undefined;
    let hubUserName: string|undefined;
    let hubUserPasswordFilePath: string|undefined;
    let hubUserCertFilePath: string|undefined;
    let hubUserCertKeyFilePath: string|undefined;
    let inputHubAddressString: string|undefined;
    let inputHubUserName: string|undefined;
    let warningFilter: string|undefined;
    let projectFile: CSProjectFile|undefined;
    if (projectConfig) {
        if (projectConfig.path) {
            projectPath = projectConfig.path;
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
        warningFilter = projectConfig.warningFilter;
        if (projectConfig.projectFilePath) {
            let projectFilePath: string = projectConfig.projectFilePath;
            if (workspaceFolderPath !== undefined
                && !path.isAbsolute(projectFilePath)
            ) {
                projectFilePath = path.join(workspaceFolderPath, projectFilePath);
            }
            projectFile = new CSProjectFile(projectFilePath);
        }
    }
    if (hubConfig) {
        hubAddressString = hubConfig.address;
        hubSocketTimeout = hubConfig.timeout;
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
                prompt: "Hub address",
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
                    prompt: "Hub user",
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
    if (hubSocketTimeout !== undefined) {
        hubClientOptions.timeout = hubSocketTimeout;
    }
    if (hubUserName) {
        hubClientOptions.hubuser = hubUserName;
    }
    let passwordStorageKey: string|undefined;
    if (hubAddressObject && hubUserName) {
        passwordStorageKey = formatHubUserPasswordStorageKey(hubAddressObject, hubUserName);
    }
    if (hubAddressString && hubUserCertFilePath) {
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
        hubClientOptions.hubkey = await loadCSHubUserKey(hubUserCertFilePath, hubUserCertKeyFilePath);
        if (hubClientOptions.hubkey.keyIsProtected) {
            const captureHubAddressString: string = hubAddressString;
            const captureHubUserCertFilePath: string = hubUserCertFilePath;
            const captureHubUserCertKeyFilePath: string = hubUserCertKeyFilePath;
            hubClientOptions.hubkeypasswd = (): Promise<string> => {
                return requestHubUserKeyPassphrase(
                        logger,
                        captureHubAddressString,
                        captureHubUserCertFilePath,
                        captureHubUserCertKeyFilePath,
                );
            };
        }
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
        const capturePasswordStorageKey: string = passwordStorageKey;
        const captureHubAddresString: string = hubAddressString;
        const captureHubUserName: string = hubUserName;
        hubClientOptions.hubpasswd = () => {
            return requestHubUserPassword(
                    logger,
                    secretStorage,
                    capturePasswordStorageKey,
                    captureHubAddresString,
                    captureHubUserName,
                    );
        };
    }
    let certificateNotTrustedError: Error|undefined;
    let hubCompatibilityInfo: CSHubVersionCompatibilityInfo|undefined;
    if (hubAddressObject !== undefined) {
        hubClient = new CSHubClient(hubAddressObject, hubClientOptions);
        hubClient.logger = logger;
        hubCompatibilityInfo = await verifyHubCompatibility(hubClient, extensionVersionInfo);
        if (hubCompatibilityInfo === undefined
            && withAnalysisBaseline
        ) {
            // No compatibility info means hub is older than CodeSonar 7.1,
            //  which also means hub is too old to support SARIF difference search:
            throw new Error("CodeSonar hub version 7.1 or later is required for SARIF analysis comparison.");
        }
        let signInSucceeded: boolean = false;
        try {
            const signInErrorMessage: string|undefined = await verifyHubCredentials(hubClient);
            if (signInErrorMessage !== undefined) {
                throw Error(signInErrorMessage);
            }
            signInSucceeded = true;
        }
        catch (e: unknown) {
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
        // TODO: remember the analysis ID for the baseline analysis,
        //  so that we don't need to look it up in future invocations of the download command.
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
            if (projectFile !== undefined) {
                const analysisId: CSAnalysisId = await getAnalysisIdFromProjectFile(projectFile);
                // Use the prj file name as the analysis name here,
                //  ultimately this will become the default name for the SARIF file:
                const analysisName: string = projectFile.baseName;
                analysisInfo = {
                    id: analysisId,
                    name: analysisName,
                };
            }
            if (analysisInfo === undefined) {
                analysisInfo = await showAnalysisQuickPick(targetAnalysisInfoArray, "Select an Analysis...");
            }
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
        let defaultDestinationPath: string = defaultFileName;
        if (baseAnalysisInfo) {
            defaultDestinationPath += CS_WARN_DIFF_EXT;
        }
        defaultDestinationPath += SARIF_EXT;
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
        let sarifSearchOptions: CSHubSarifSearchOptions = {};
        if (extensionOptions.sarifIndentLength !== undefined) {
            sarifSearchOptions.indentLength = extensionOptions.sarifIndentLength;
        }
        if (warningFilter !== undefined) {
            sarifSearchOptions.warningFilter = warningFilter;
        }
        await downloadSarifResults(hubClient, destinationFilePath, analysisInfo, baseAnalysisInfo, sarifSearchOptions);
        if (extensionOptions.autoOpenSarifViewer) {
            await sarifView.showSarifDocument(destinationUri);
        }
        else {
            window.showInformationMessage(`Downloaded CodeSonar Analysis to '${destinationFileName}'`);
        }
    }
}

/** Get compatibility information from hub.  Throw an error if the extension is too old for the hub. */
async function verifyHubCompatibility(
    hubClient: CSHubClient,
    extensionVersionInfo: csConfig.ExtensionVersionInfo,
): Promise<CSHubVersionCompatibilityInfo|undefined> {
    const hubClientName: string = extensionVersionInfo.hubClientName;
    const hubClientVersion: string = extensionVersionInfo.hubProtocolNumber.toString();
    const versionCompatibilityInfo: CSHubVersionCompatibilityInfo|undefined =
        await hubClient.fetchVersionCompatibilityInfo(
                hubClientName,
                hubClientVersion,
            );
    if (versionCompatibilityInfo !== undefined
        && versionCompatibilityInfo.clientOK === false
    ) {
        // The hub recognized our protocol version and it rejected us:
        throw new Error("This CodeSonar extension is too old to communicate with your hub.  Please upgrade if possible.");
    }
    return versionCompatibilityInfo;
}

function requestHubUserKeyPassphrase(
    logger: Logger,
    hubAddressString: string,
    hubUserCertFilePath: string,
    hubUserCertKeyFilePath: string,
): Promise<string> {
    return new Promise<string>((
        resolve: (password: string) => void,
        reject: (e: unknown) => void,
    ) => {
        window.showInputBox({
            password: true,
            prompt: `Enter passphrase for CodeSonar hub key '${hubUserCertKeyFilePath}' at '${hubAddressString}'`,
            placeHolder: 'passphrase',
            ignoreFocusOut: true,
        }).then(
            (inputValue: string|undefined): void => {
                if (inputValue === undefined) {
                    // TODO this error will be caught when we catch signin errors.
                    //  we should detect and ignore the error in that case.
                    reject(new Error("User cancelled passphrase input"));
                }
                else {
                    resolve(inputValue);
                }
            },
            reject);            
    });
}

function requestHubUserPassword(
    logger: Logger,
    secretStorage: SecretStorage,
    passwordStorageKeyString: string,
    hubAddressString: string,
    hubUserName: string,
): Promise<string> {
    return new Promise<string>((
            resolve: (password: string) => void,
            reject: (e: unknown) => void,
        ) => {
        secretStorage.get(passwordStorageKeyString).then((password: string|undefined): void => {
            if (password !== undefined) {
                logger.info("Found saved password");
                resolve(password);
            }
            else {
                window.showInputBox({
                    password: true,
                    prompt: `Enter password for CodeSonar hub user '${hubUserName}' at '${hubAddressString}'`,
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

/** Try to sign-in to hub.
 * 
 *  @return undefined if sign-in succeeded, 
 *     or sign-in failure message if sign-in was rejected.
 *  @throws Error  Sign-in process failed, perhaps due to network error.
 */
async function verifyHubCredentials(hubClient: CSHubClient): Promise<string|undefined> {
    return await window.withProgress<string|undefined>({
            cancellable: false,
            location: ProgressLocation.Window,
            title: "connecting to CodeSonar hub",
        },
        (
            progress: IncrementalProgress,
            cancelToken: CancellationToken,
        ): Thenable<string|undefined> => {
            // TODO: Consider catching some common errors,
            //  e.g. (e.code === "ECONNREFUSED") ? "port is closed on hub host or hub is down"
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

/** Try to get the analysis ID from the .prj_files dir. */
async function getAnalysisIdFromProjectFile(projectFile: CSProjectFile): Promise<CSAnalysisId> {
    const analysisIdString: string = await projectFile.readAnalysisIdString();
    // Exploit the fact CSAnalysisId is a string:
    const analysisId: CSAnalysisId = analysisIdString;
    return analysisId;
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
        baseAnalysisInfo: CSAnalysisInfo|undefined,
        sarifSearchOptions: CSHubSarifSearchOptions|undefined,
        ): Promise<string> {
    const analysisId: CSAnalysisId = analysisInfo.id;
    const baseAnalysisId: CSAnalysisId|undefined = baseAnalysisInfo?.id;
    return await window.withProgress({
        location: ProgressLocation.Notification,
        title: "Downloading CodeSonar analysis...",
        cancellable: true,
    }, (
        progress: IncrementalProgress,
        token: CancellationToken,
    ) => {
        // TODO: download to temporary location and move it when finished
        const destinationStream: NodeJS.WritableStream = fs.createWriteStream(destinationFilePath);

        progress.report({increment: 0});
        // The progress meter sums up the increment values that we give it,
        //  when the increments add to 100, the progress bar is full.
        const maxProgressSize: number = 100;
        // We don't know how long it will take to download the warnings.
        // This code computes a sort of inverted base-2 exponential decay.
        //  The basic formula is:
        //       f(t) = 1 - 2^(-k*t)
        //  Notice that f(0) = 0, and f(Inf) -> 1.
        //  Notice also that when `k = 1/t`, we have `f(t) = 1/2`,
        //   so k is the time until we are halfway done.
        //  Since the VS Code progress meter sums-up the values we give it,
        //   we actually want f to express the integral of some "increment" function.
        //   Therefore the increment function is basically the derivative of f:
        //       f'(t) = k*ln(2)*2^(-k*t)
        //  This code will update the progress meter periodically,
        //   once per time "interval", `dt`.
        //   For the sum to work,
        //    each increment value must be multiplied by the interval period.
        //    This product is the term of the integral: `f'(t)*dt`.
        //   Finally, we must scale the value by the progress meter size (100).
        // In practice, a "halfDoneTime" of 1 minute seems to be pretty good.
        //  It shows visible progress and doesn't jump too much on small downloads.
        //  However, it is likely to be frustrating for large downloads.
        const intervalMS: number = 1000;
        const halfDoneTimeMS: number = 1.0 * 60.0 * 1000.0; // 1 minute
        const k: number = 1.0/halfDoneTimeMS;
        const ln2: number = Math.log(2.0);
        const incrementFunction: (t: number) => number = (t: number): number => {
            return intervalMS*k*ln2*Math.pow(2.0, (-1.0*t*k));
        };
        const startTimeMS: number = Date.now();
        let progressRemaining: number = maxProgressSize;
        const timer = setInterval((): void => {
                const nowMS: number = Date.now();
                const t: number = (nowMS - startTimeMS);
                const progressSize: number = maxProgressSize * incrementFunction(t);
                progress.report({increment: progressSize});
                progressRemaining -= progressSize;
            },
            intervalMS);
        let sarifPromise: Promise<Readable>;
        if (baseAnalysisId !== undefined) {
            sarifPromise = hubClient.fetchSarifAnalysisDifferenceStream(analysisId, baseAnalysisId, sarifSearchOptions);
        }
        else {
            sarifPromise = hubClient.fetchSarifAnalysisStream(analysisId, sarifSearchOptions);
        }
        return new Promise<string>((
            resolve: (savedFilePath: string) => void,
            _reject: (e: unknown) => void,
        ): void => {
            const reject: (e: unknown) => void = (e: unknown): void => {
                clearInterval(timer);
                destinationStream.end();
                _reject(e);
            };
            sarifPromise.then((sarifStream: Readable): void => {
                sarifStream.pipe(destinationStream
                    ).on('error', reject
                    ).on('finish', (): void => {
                        clearInterval(timer);
                        // Show a full progress bar for a moment before we finish:
                        if (progressRemaining > 0) {
                            progress.report({increment: progressRemaining});
                        }
                        setTimeout((): void => {
                            // The pipe will automatically call .end() on the destinationStream.
                            //destinationStream.end();
                            resolve(destinationFilePath);
                        },
                        intervalMS);
                    });
                token.onCancellationRequested(() => {
                    sarifStream.unpipe();
                    sarifStream.destroy();
                    destinationStream.end(
                        (): void => {
                            fs.unlink(destinationFilePath, (e: unknown): void => {
                                if (e) {
                                    reject(e);
                                } else {
                                    reject(new Error("Canceled"));
                                }
                            });
                        });
                });
                }).catch(reject);
        });
    });
}
