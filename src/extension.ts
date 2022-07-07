/** CodeSonar extension for VS Code. */
import { commands, Disposable, ExtensionContext, window } from 'vscode';

import { errorToString } from './common_utils';
import { executeCodeSonarVSCodeConfigCreate } from './generate_cs_vscode_config_command';
import { executeCodeSonarSarifDownload } from './sarif_download_command';

const CS_CONFIG_FILE_NAME = 'codesonar.json';

export function activate(context: ExtensionContext) {
	const disposables: Disposable[] = [];
	disposables.push(commands.registerCommand('vscode-codesonar.generate-codesonar-json', () => {
		executeCodeSonarVSCodeConfigCreate(
				CS_CONFIG_FILE_NAME,
		).catch(e => {
			let errorMessage = errorToString(e);
			if (!errorMessage) {
				errorMessage = 'CodeSonar Code configuration file generation failed.';
			}
			window.showErrorMessage(errorMessage);
		});
	}));
	disposables.push(commands.registerCommand('vscode-codesonar.download-sarif', () => {
		executeCodeSonarSarifDownload(
				CS_CONFIG_FILE_NAME,
				context.secrets,
		).catch(e => {
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
