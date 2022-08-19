/** CodeSonar extension for VS Code. */
import { commands, Disposable, ExtensionContext, window } from 'vscode';

import { 
    errorToString,
    OperationCancelledError,
} from './common_utils';
import { Logger } from './logger';
import { CSConfigIO } from './cs_vscode_config';
import { executeRemoveCSHubUserPassword } from './remove_hub_password_command';
import { 
    executeCodeSonarFullSarifDownload,
    executeCodeSonarDiffSarifDownload,
 } from './sarif_download_command';

 /** Activate the VS Code extension. */
export function activate(context: ExtensionContext) {
    const disposables: Disposable[] = [];
    const verboseErrors: boolean = false;
    // TODO consider using VS Code Output channel instead of the global console:
    const logger: Logger = console;

    const showError: (e: unknown, defaultMessage: string) => void  =  (e: unknown, defaultMessage: string) => {
        const errorMessage = errorToString(e, {
            verbose: verboseErrors,
            message: defaultMessage, 
        });
        if (e instanceof OperationCancelledError) {
            window.showInformationMessage(errorMessage);
        }
        else {
            window.showErrorMessage(errorMessage);
        }
    };

    disposables.push(commands.registerCommand(
        'vscode-codesonar.download-full-sarif',
        (): void => {
            executeCodeSonarFullSarifDownload(
                logger,
                new CSConfigIO(),
                context.secrets,
            ).catch((e: unknown): void => {
                showError(e, 'CodeSonar SARIF download failed.');
            });
        }));
    disposables.push(commands.registerCommand(
        'vscode-codesonar.download-diff-sarif',
        (): void => {
            executeCodeSonarDiffSarifDownload(
                logger,
                new CSConfigIO(),
                context.secrets,
            ).catch((e: unknown): void => {
                showError(e, 'CodeSonar SARIF download failed.');
            });
        }));
    disposables.push(commands.registerCommand(
        'vscode-codesonar.remove-hubuser-password',
        (): void => {
            executeRemoveCSHubUserPassword(
                logger,
                new CSConfigIO(),
                context.secrets,
            ).catch((e: any): void => {
                showError(e, 'Failed to remove password.');
            });
        }));
        
    context.subscriptions.push(...disposables);
}

export function deactivate() {}
