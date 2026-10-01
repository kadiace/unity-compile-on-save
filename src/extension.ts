import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

export function findUnityProjectRoot(filePath: string): string | undefined {
	let directory = path.dirname(filePath);
	while (true) {
		if (existsSync(path.join(directory, 'ProjectSettings', 'ProjectVersion.txt'))) {
			return directory;
		}
		const parent = path.dirname(directory);
		if (parent === directory) {
			return undefined;
		}
		directory = parent;
	}
}

export function createSaveHandler(recompile: (projectRoot: string) => void): {
	onSave: (document: vscode.TextDocument) => void;
	dispose: () => void;
} {
	const timers = new Map<string, NodeJS.Timeout>();

	return {
		onSave(document) {
			if (document.uri.scheme !== 'file' || path.extname(document.uri.fsPath).toLowerCase() !== '.cs') {
				return;
			}
			if (!vscode.workspace.getConfiguration('unityCompileOnSave', document.uri).get<boolean>('compileUnityOnSave', true)) {
				return;
			}
			const projectRoot = findUnityProjectRoot(document.uri.fsPath);
			if (!projectRoot || !vscode.workspace.workspaceFolders?.some((folder) =>
				folder.uri.scheme === 'file' && path.relative(folder.uri.fsPath, projectRoot) === '')) {
				return;
			}

			const pending = timers.get(projectRoot);
			if (pending) {
				clearTimeout(pending);
			}
			timers.set(projectRoot, setTimeout(() => {
				timers.delete(projectRoot);
				if (vscode.workspace.getConfiguration('unityCompileOnSave', document.uri).get<boolean>('compileUnityOnSave', true)) {
					recompile(projectRoot);
				}
			}, 200));
		},
		dispose() {
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			timers.clear();
		}
	};
}

export function activate(context: vscode.ExtensionContext): void {
	const handler = createSaveHandler((projectRoot) => {
		const child = spawn('unity', ['recompile', '--project-path', projectRoot], { cwd: projectRoot, stdio: 'ignore', windowsHide: true });
		child.on('error', (error) => {
			void vscode.window.showErrorMessage(`Unity recompilation failed: ${error.message}`);
		});
		child.on('exit', (code) => {
			if (code !== 0 && code !== null) {
				void vscode.window.showErrorMessage(`Unity recompilation exited with code ${code}.`);
			}
		});
	});
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(handler.onSave), handler);
}
