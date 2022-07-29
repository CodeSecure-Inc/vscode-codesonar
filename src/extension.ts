/** CodeSonar extension for VS Code. */
import { commands, Disposable, ExtensionContext, window } from 'vscode';

import { errorToString } from './common_utils';
import { Logger } from './logger';
import { executeCodeSonarVSCodeConfigCreate } from './generate_cs_vscode_config_command';
import { executeCodeSonarSarifDownload } from './sarif_download_command';

const CS_CONFIG_FILE_NAME: string = 'codesonar.json';

export function activate(context: ExtensionContext) {
    const disposables: Disposable[] = [];
    // TODO consider using VS Code Output channel instead of the global console:
    const logger: Logger = console;
    disposables.push(commands.registerCommand(
        'vscode-codesonar.generate-codesonar-json',
        (): void => {
            executeCodeSonarVSCodeConfigCreate(
                    CS_CONFIG_FILE_NAME,
            ).catch((e: any): void => {
                let errorMessage: string = errorToString(e);
                if (!errorMessage) {
                    errorMessage = 'CodeSonar Code configuration file generation failed.';
                }
                window.showErrorMessage(errorMessage);
            });
        }));
    disposables.push(commands.registerCommand(
        'vscode-codesonar.download-sarif',
        (): void => {
            executeCodeSonarSarifDownload(
                    logger,
                    CS_CONFIG_FILE_NAME,
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
