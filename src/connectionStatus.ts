import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const runCli = promisify(execFile);
export type Connection = 'connected' | 'busy';

export function parseConnection(stdout: string, projectRoot: string): Connection {
	const response: unknown = JSON.parse(stdout);
	if (!response || typeof response !== 'object' || !('success' in response) || response.success !== true ||
		!('data' in response) || !response.data || typeof response.data !== 'object' ||
		!('target' in response.data) || !response.data.target || typeof response.data.target !== 'object' ||
		!('projectPath' in response.data.target) || typeof response.data.target.projectPath !== 'string' ||
		path.relative(projectRoot, response.data.target.projectPath) !== '' ||
		!('result' in response.data) || !response.data.result || typeof response.data.result !== 'object' ||
		!('status' in response.data.result) || typeof response.data.result.status !== 'string') {
		throw new Error('Pipeline did not confirm recompilation readiness for this Unity project.');
	}
	switch (response.data.result.status) {
		case 'idle': case 'completed': case 'up_to_date': return 'connected';
		case 'compiling': case 'queued': case 'running': case 'triggered': return 'busy';
		default: throw new Error(`Pipeline recompilation is not ready (${response.data.result.status}).`);
	}
}

export async function checkConnection(projectRoot: string, executable: string, signal: AbortSignal): Promise<Connection> {
	const { stdout } = await runCli(executable, ['command', '--project-path', projectRoot, '--timeout', '5', 'recompile_status', '--json'],
		{ cwd: projectRoot, windowsHide: true, signal, timeout: 8000, maxBuffer: 1024 * 1024 });
	return parseConnection(stdout, projectRoot);
}

export class ConnectionStatusBar implements vscode.Disposable {
	private timer: NodeJS.Timeout | undefined;
	private controller: AbortController | undefined;
	private project: string | undefined;
	private disposed = false;
	private readonly subscriptions: vscode.Disposable[];

	constructor(
		private readonly probe: (folder: vscode.WorkspaceFolder, signal: AbortSignal) => Promise<Connection>,
		private readonly folders: () => readonly vscode.WorkspaceFolder[],
		private readonly item = vscode.window.createStatusBarItem('unityCompileOnSave.connection', vscode.StatusBarAlignment.Right, 100)
	) {
		this.item.name = 'Unity Pipeline Connection';
		this.subscriptions = [
			vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
			vscode.window.onDidChangeWindowState((state) => { if (state.focused) { this.refresh(); } }),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('unityCompileOnSave.showConnectionStatus') || event.affectsConfiguration('unityCompileOnSave.autoSetup')) { this.refresh(); }
			}),
			vscode.tasks.onDidStartTask(() => this.refresh()),
			vscode.tasks.onDidEndTask(() => this.refresh())
		];
		this.refresh();
	}

	refresh(): void {
		if (this.disposed) { return; }
		clearTimeout(this.timer);
		this.controller?.abort();
		const folders = this.folders();
		const active = vscode.window.activeTextEditor?.document.uri;
		const owner = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
		const folder = active ? folders.find((candidate) => candidate.uri.toString() === owner?.uri.toString()) : folders[0];
		if (!folder || !vscode.workspace.isTrusted ||
			!vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri).get<boolean>('showConnectionStatus', true)) {
			this.project = undefined;
			this.item.hide();
			return;
		}
		const project = folder.uri.toString();
		const suffix = folders.length > 1 ? ` (${folder.name})` : '';
		const render = (label: string, icon: string, detail: string): void => {
			this.item.text = `$(${icon}) Unity: ${label}${suffix}`;
			this.item.tooltip = `${folder.name}\n${folder.uri.fsPath}\n\n${detail}\nClick to set up or reconnect this project's Unity Pipeline.`;
			this.item.accessibilityInformation = { label: `Unity Pipeline ${label}, ${folder.name}` };
			this.item.command = { command: 'unityCompileOnSave.setup', title: 'Reconnect Unity Pipeline', arguments: [folder.uri] };
			this.item.show();
		};
		if (this.project !== project) { render('Checking', 'loading', 'Checking whether Unity CLI can recompile through this project\'s Pipeline.'); }
		this.project = project;
		const controller = new AbortController();
		this.controller = controller;
		void this.probe(folder, controller.signal).then((connection) => {
			if (controller.signal.aborted) { return; }
			switch (connection) {
				case 'connected': render('Connected', 'plug', 'Unity Pipeline is responding for this project. Unity CLI is ready to request recompilation.'); break;
				case 'busy': render('Busy', 'sync', 'Unity Pipeline is responding for this project, but compilation is still in progress.'); break;
			}
		}).catch((error: unknown) => {
			if (!controller.signal.aborted) {
				render('Disconnected', 'debug-disconnect', `Unity CLI could not confirm recompilation readiness.\n${error instanceof Error ? error.message : String(error)}`);
			}
		}).finally(() => {
			if (!controller.signal.aborted) { this.timer = setTimeout(() => this.refresh(), 5000); }
		});
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.controller?.abort();
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.item.dispose();
	}
}
