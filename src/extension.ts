/** CodeSonar extension for VS Code. */
import { commands, Disposable, ExtensionContext, window } from 'vscode';

import { errorToString } from './common_utils';
import { Logger } from './logger';
import { CSConfigIO } from './cs_vscode_config';
import { executeRemoveCSHubUserPassword } from './remove_hub_password_command';
import { 
    executeCodeSonarFullSarifDownload,
    executeCodeSonarDiffSarifDownload,
 } from './sarif_download_command';

export function activate(context: ExtensionContext) {
    const disposables: Disposable[] = [];
    const verboseErrors: boolean = false;
    // TODO consider using VS Code Output channel instead of the global console:
    const logger: Logger = console;

    disposables.push(commands.registerCommand(
        'vscode-codesonar.download-full-sarif',
        (): void => {
            executeCodeSonarFullSarifDownload(
                logger,
                new CSConfigIO(),
                context.secrets,
            ).catch((e: unknown): void => {
                const errorMessage = errorToString(e, {
                        verbose: verboseErrors,
                        message: 'CodeSonar SARIF download failed.', 
                    });
                window.showErrorMessage(errorMessage);
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
                const errorMessage = errorToString(e, {
                        verbose: verboseErrors,
                        message: 'CodeSonar SARIF download failed.', 
                    });
                window.showErrorMessage(errorMessage);
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
                    const errorMessage = errorToString(e, {
                        verbose: verboseErrors,
                        message: 'Failed to remove password.', 
                    });
                    window.showErrorMessage(errorMessage);
                });
            }));
        
    context.subscriptions.push(...disposables);
}

export function deactivate() {}
