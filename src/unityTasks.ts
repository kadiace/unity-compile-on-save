import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ensureUnityCli } from './bootstrap';
import type { Change } from './extension';
import { runRecompile, waitUntilEditorIdle } from './unityCli';

const runCli = promisify(execFile);
const taskType = 'unityCompileOnSave';
type Operation = 'setup' | 'recompile';
type ProjectState = {
	readonly controller: AbortController;
	tail: Promise<void>;
	ready?: string;
};

export class UnityTaskRunner implements vscode.Disposable {
	private readonly projects = new Map<string, ProjectState>();
	private readonly setupTasks = new Map<string, Promise<void>>();
	private readonly controllers = new Set<AbortController>();
	private readonly lifetime = new AbortController();
	private cli: Promise<string> | undefined;

	constructor(
		private readonly storageRoot: string,
		private readonly output: vscode.OutputChannel,
		private readonly provision = ensureUnityCli
	) {}

	private async setup(folder: vscode.WorkspaceFolder, log: (message: string) => void, signal: AbortSignal): Promise<string> {
		if (!vscode.workspace.isTrusted) {
			throw new Error('Trust this workspace before installing Unity CLI or connecting Unity Pipeline.');
		}
		this.cli ??= this.provision(this.storageRoot, log, this.lifetime.signal).catch((error: unknown) => {
			this.cli = undefined;
			throw error;
		});
		const executable = await this.cli;
		signal.throwIfAborted();
		const projectRoot = folder.uri.fsPath;
		const options = { cwd: projectRoot, windowsHide: true, signal, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 };
		log(`Installing/checking Unity Pipeline in ${projectRoot}`);
		const installed = await runCli(executable, ['pipeline', 'install', '--project-path', projectRoot, '--non-interactive'], options);
		log(installed.stdout);
		log(installed.stderr);
		const { stdout } = await runCli(executable, ['pipeline', 'list', '--json'], options);
		const response: unknown = JSON.parse(stdout);
		if (!response || typeof response !== 'object' || !('data' in response) || !response.data ||
			typeof response.data !== 'object' || !('instances' in response.data) || !Array.isArray(response.data.instances)) {
			throw new Error('Unity Pipeline returned an invalid project list.');
		}
		const running = response.data.instances.some((instance: unknown) => instance !== null && typeof instance === 'object' &&
			'projectPath' in instance && typeof instance.projectPath === 'string' &&
			path.relative(projectRoot, instance.projectPath) === '' && 'isRunning' in instance && instance.isRunning === true &&
			'pid' in instance && typeof instance.pid === 'number' && instance.pid > 0);
		if (!running) {
			log('Opening this project in its installed Unity Editor to connect Pipeline.');
			const opened = await runCli(executable, ['open', projectRoot, '--non-interactive'], options);
			log(opened.stdout);
			log(opened.stderr);
		}
		log('Waiting for the Unity Editor to finish loading Pipeline and compiling scripts...');
		await waitUntilEditorIdle(projectRoot, executable, signal);
		log('Unity Pipeline connected. Compile on Save is ready.');
		return executable;
	}

	private stateFor(folder: vscode.WorkspaceFolder): ProjectState {
		const root = folder.uri.toString();
		let state = this.projects.get(root);
		if (!state) {
			state = { controller: new AbortController(), tail: Promise.resolve() };
			this.projects.set(root, state);
		}
		return state;
	}

	private async perform(folder: vscode.WorkspaceFolder, operation: Operation, kinds: ReadonlySet<Change>,
		log: (message: string) => void, taskSignal: AbortSignal): Promise<void> {
		const state = this.stateFor(folder);
		const signal = AbortSignal.any([taskSignal, state.controller.signal, this.lifetime.signal]);
		const work = state.tail.then(async () => {
			signal.throwIfAborted();
			if (operation === 'recompile' && !vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri).get<boolean>('autoSetup', true)) {
				state.ready = 'unity';
			} else if (operation === 'setup' || !state.ready) {
				state.ready = undefined;
				state.ready = await this.setup(folder, log, signal);
			}
			if (operation === 'recompile') {
				log(`Running unity recompile --project-path ${folder.uri.fsPath}`);
				await runRecompile(folder.uri.fsPath, kinds, state.ready, signal);
				log('Unity recompilation completed.');
			}
		});
		state.tail = work.then(() => undefined, () => undefined);
		await work;
	}

	createTask(folder: vscode.WorkspaceFolder, operation: Operation, kinds: ReadonlySet<Change> = new Set(['source']),
		definition: vscode.TaskDefinition = { type: taskType, operation }, completed?: (code: number) => void): vscode.Task {
		const task = new vscode.Task(definition, folder, operation === 'setup' ? 'Connect Unity Pipeline' : 'Recompile Unity',
			'Unity Compile on Save', new vscode.CustomExecution(async () => {
				const write = new vscode.EventEmitter<string>();
				const close = new vscode.EventEmitter<number>();
				const controller = new AbortController();
				this.controllers.add(controller);
				let finished = false;
				const log = (message: string): void => {
					if (!finished && !this.lifetime.signal.aborted && message.trim()) {
						this.output.appendLine(`[${folder.name}] ${message.trim()}`);
						write.fire(`${message.trim().replace(/\r?\n/g, '\r\n')}\r\n`);
					}
				};
				const finish = (code: number): void => {
					if (!finished) {
						finished = true;
						this.controllers.delete(controller);
						completed?.(code);
						close.fire(code);
						write.dispose();
						close.dispose();
					}
				};
				return {
					onDidWrite: write.event,
					onDidClose: close.event,
					open: () => {
						void this.perform(folder, operation, kinds, log, controller.signal).then(() => finish(0)).catch((error: unknown) => {
							log(error instanceof Error ? error.message : String(error));
							if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') { log(error.stdout); }
							if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') { log(error.stderr); }
							finish(1);
						});
					},
					close: () => {
						controller.abort();
						finish(1);
					}
				};
			}));
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: true };
		return task;
	}

	async execute(folder: vscode.WorkspaceFolder, operation: Operation, kinds?: ReadonlySet<Change>): Promise<void> {
		if (operation === 'setup') {
			const root = folder.uri.toString();
			const pending = this.setupTasks.get(root);
			if (pending) { return pending; }
			const work = this.executeTask(folder, operation, kinds);
			this.setupTasks.set(root, work);
			try { await work; } finally {
				if (this.setupTasks.get(root) === work) { this.setupTasks.delete(root); }
			}
			return;
		}
		await this.executeTask(folder, operation, kinds);
	}

	private async executeTask(folder: vscode.WorkspaceFolder, operation: Operation, kinds?: ReadonlySet<Change>): Promise<void> {
		const id = randomUUID();
		let exitCode: number | undefined;
		const task = this.createTask(folder, operation, kinds, { type: taskType, operation, id }, (code) => { exitCode = code; });
		let resolveEnded: (() => void) | undefined;
		const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
		const taskListener = vscode.tasks.onDidEndTask((event) => {
			if (event.execution.task.definition.id === id) {
				resolveEnded?.();
			}
		});
		try {
			await vscode.tasks.executeTask(task);
			await ended;
			if (exitCode !== 0) {
				throw new Error('Unity task failed or was cancelled. See the Unity Compile on Save output or task terminal for details.');
			}
		} finally {
			taskListener.dispose();
		}
	}

	forget(folder: vscode.WorkspaceFolder): void {
		const root = folder.uri.toString();
		const previous = this.projects.get(root);
		previous?.controller.abort();
		this.projects.set(root, { controller: new AbortController(), tail: previous?.tail ?? Promise.resolve() });
		this.setupTasks.delete(root);
	}

	async waitUntilIdle(folder: vscode.WorkspaceFolder): Promise<void> {
		if (!vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri).get<boolean>('autoSetup', true)) {
			await waitUntilEditorIdle(folder.uri.fsPath, 'unity',
				AbortSignal.any([this.stateFor(folder).controller.signal, this.lifetime.signal]));
			return;
		}
		const pending = this.setupTasks.get(folder.uri.toString());
		if (pending) { await pending; }
		if (!this.stateFor(folder).ready) {
			await this.execute(folder, 'setup');
		}
		const state = this.stateFor(folder);
		const executable = state.ready;
		if (!executable) {
			throw new Error('Unity Pipeline setup did not complete.');
		}
		const controller = new AbortController();
		this.controllers.add(controller);
		try {
			await waitUntilEditorIdle(folder.uri.fsPath, executable,
				AbortSignal.any([controller.signal, state.controller.signal, this.lifetime.signal]));
		} catch (error: unknown) {
			this.forget(folder);
			throw error;
		} finally {
			this.controllers.delete(controller);
		}
	}

	dispose(): void {
		this.lifetime.abort();
		for (const controller of this.controllers) {
			controller.abort();
		}
		this.projects.clear();
	}
}
