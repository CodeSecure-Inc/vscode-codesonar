/** CodeSonar extension for VS Code. */
import { commands, Disposable, ExtensionContext, window } from 'vscode';

import { errorToString } from './common_utils';
import { Logger } from './logger';
import { 
    executeCodeSonarFullSarifDownload,
    executeCodeSonarDiffSarifDownload,
 } from './sarif_download_command';

export function activate(context: ExtensionContext) {
    const disposables: Disposable[] = [];
    // TODO consider using VS Code Output channel instead of the global console:
    const logger: Logger = console;
    disposables.push(commands.registerCommand(
        'vscode-codesonar.download-full-sarif',
        (): void => {
            executeCodeSonarFullSarifDownload(
                logger,
                context.secrets,
            ).catch((e: any): void => {
                let errorMessage = errorToString(e);
                if (!errorMessage) {
                    errorMessage = 'CodeSonar SARIF download failed.';
                }
                window.showErrorMessage(errorMessage);
            });
        }));
    disposables.push(commands.registerCommand(
        'vscode-codesonar.download-diff-sarif',
        (): void => {
            executeCodeSonarDiffSarifDownload(
                logger,
                context.secrets,
            ).catch((e: any): void => {
                let errorMessage = errorToString(e);
                if (!errorMessage) {
                    errorMessage = 'CodeSonar SARIF download failed.';
                }
                window.showErrorMessage(errorMessage);
            });
        }));
    
    context.subscriptions.push(...disposables);
}

export function deactivate() {}
