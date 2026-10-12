import path from 'node:path';
import * as vscode from 'vscode';
import { ensureUnityCli } from './bootstrap';
import type { Change } from './extension';
import { EditorNotReadyError, RecompileError, runRecompile, waitUntilEditorIdle } from './unityCli';
import { processFailure, runProcess } from './cliProcess';
import type { ProcessResult, ProcessRunner } from './cliProcess';
import { CompilerDiagnostics } from './compilerDiagnostics';

type Operation = 'setup' | 'recompile';
export type OperationResult = ProcessResult & {
	readonly projectRoot: string;
	readonly operation: Operation;
	readonly exitCode: number;
	readonly status: 'success' | 'compile-failure' | 'connection-failure' | 'deferred' | 'operation-failure' | 'cancelled';
	readonly stage: 'setup' | 'package' | 'preflight' | 'invoke' | 'postflight';
	readonly recompileAttempts: number;
	readonly packagesResolved: boolean;
	readonly message: string;
};

export class OperationError extends Error {
	constructor(readonly result: OperationResult, cause: unknown) {
		super(result.message, { cause });
	}
}
type ProjectState = {
	readonly controller: AbortController;
	tail: Promise<void>;
	ready?: string;
};

export class UnityTaskRunner implements vscode.Disposable {
	private readonly projects = new Map<string, ProjectState>();
	private readonly setupTasks = new Map<string, Promise<OperationResult>>();
	private readonly recompileTasks = new Map<string, { readonly kinds: Set<Change>; readonly work: Promise<OperationResult> }>();
	private readonly controllers = new Set<AbortController>();
	private readonly lifetime = new AbortController();
	private cli: Promise<string> | undefined;
	private readonly changed = new vscode.EventEmitter<OperationResult>();
	readonly onDidComplete = this.changed.event;
	readonly diagnostics = new CompilerDiagnostics();

	constructor(
		private readonly storageRoot: string,
		private readonly output: vscode.OutputChannel,
		private readonly provision = ensureUnityCli
	) {}

	reportFailure(message: string, error: unknown, notify = true): void {
		if (this.lifetime.signal.aborted) { return; }
		let cause = error;
		while (cause instanceof Error) {
			if (cause.name === 'AbortError') { return; }
			cause = cause.cause;
		}
		const detail = error instanceof Error ? error.message : String(error);
		this.output.appendLine(`${message}: ${detail}`);
		if (!notify) { return; }
		void vscode.window.showErrorMessage(`${message}: ${detail}`, 'Show Log')
			.then((choice) => { if (choice === 'Show Log') { this.output.show(true); } });
	}

	processFor(projectRoot: string): ProcessRunner {
		const state = this.projects.get(vscode.Uri.file(projectRoot).toString());
		return async (executable, args, options) => {
			const collectDiagnostics = !args.includes('recompile_status');
			this.output.appendLine(`[${projectRoot}] ${executable} ${args.join(' ')}`);
			const buffers = { stdout: '', stderr: '' };
			const pending = { stdout: '', stderr: '' };
			const parse = (text: string): void => {
				if (!collectDiagnostics || this.lifetime.signal.aborted || state?.controller.signal.aborted) { return; }
				if (/^\s*[\[{]/.test(text)) { this.diagnostics.parseJson(projectRoot, text); }
				else { this.diagnostics.parse(projectRoot, text); }
			};
			try {
				return await runProcess(executable, args, { ...options, log: (chunk, stream) => {
					if (this.lifetime.signal.aborted) { return; }
					this.output.append(chunk);
					buffers[stream] += chunk;
					pending[stream] += chunk;
					const lines = pending[stream].split(/\r?\n/);
					pending[stream] = lines.pop() ?? '';
					for (const line of lines) { parse(line); }
				} });
			} catch (error: unknown) {
				if (!this.lifetime.signal.aborted) { this.output.appendLine(error instanceof Error ? error.message : String(error)); }
				throw error;
			} finally {
				for (const stream of ['stdout', 'stderr'] as const) {
					parse(pending[stream]);
					if (collectDiagnostics && !this.lifetime.signal.aborted && !state?.controller.signal.aborted) {
						this.diagnostics.parseJson(projectRoot, buffers[stream]);
					}
				}
				if (!this.lifetime.signal.aborted) { this.output.appendLine(''); }
			}
		};
	}

	async connectionExecutable(folder: vscode.WorkspaceFolder): Promise<string> {
		if (!vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri).get<boolean>('autoSetup', true)) { return 'unity'; }
		return this.projects.get(folder.uri.toString())?.ready ?? this.cli ?? 'unity';
	}

	private async setup(folder: vscode.WorkspaceFolder, log: (message: string) => void, signal: AbortSignal): Promise<{ readonly executable: string; readonly result: ProcessResult }> {
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
		const runCli = this.processFor(projectRoot);
		const options = { cwd: projectRoot, signal, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 };
		log(`Installing/checking Unity Pipeline in ${projectRoot}`);
		await runCli(executable, ['pipeline', 'install', '--project-path', projectRoot, '--non-interactive'], options);
		const result = await runCli(executable, ['pipeline', 'list', '--json'], options);
		const { stdout } = result;
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
			await runCli(executable, ['open', projectRoot, '--non-interactive'], { ...options, finishOnExit: true });
		}
		log('Waiting for the Unity Editor to finish loading Pipeline and compiling scripts...');
		await waitUntilEditorIdle(projectRoot, executable, signal, runCli);
		log('Unity Pipeline connected. Compile on Save is ready.');
		return { executable, result };
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
		log: (message: string) => void, taskSignal: AbortSignal, started: () => void): Promise<ProcessResult & { readonly recompileAttempts: number; readonly packagesResolved: boolean }> {
		const state = this.stateFor(folder);
		const signal = AbortSignal.any([taskSignal, state.controller.signal, this.lifetime.signal]);
		const work = state.tail.then(async () => {
			started();
			signal.throwIfAborted();
			let setupResult: ProcessResult = { stdout: '', stderr: '' };
			if (operation === 'recompile' && !vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri).get<boolean>('autoSetup', true)) {
				state.ready = 'unity';
			} else if (operation === 'setup' || !state.ready) {
				state.ready = undefined;
				const setup = await this.setup(folder, log, signal);
				state.ready = setup.executable;
				setupResult = setup.result;
			}
			if (operation === 'recompile') {
				log(`Running unity recompile --project-path ${folder.uri.fsPath}`);
				const result = await runRecompile(folder.uri.fsPath, kinds, state.ready, signal, this.processFor(folder.uri.fsPath),
					() => this.diagnostics.clear(folder.uri.fsPath));
				log('Unity recompilation completed.');
				return result;
			}
			return { ...setupResult, recompileAttempts: 0, packagesResolved: false };
		});
		state.tail = work.then(() => undefined, () => undefined);
		return work;
	}

	async execute(folder: vscode.WorkspaceFolder, operation: Operation, kinds: ReadonlySet<Change> = new Set(['source'])): Promise<OperationResult> {
		const root = folder.uri.toString();
		if (operation === 'setup') {
			const pending = this.setupTasks.get(root);
			if (pending) { return pending; }
			// A setup is an ordering barrier: later recompiles cannot merge backwards across it.
			this.recompileTasks.delete(root);
			const work = this.executeOperation(folder, operation, kinds);
			this.setupTasks.set(root, work);
			try { return await work; } finally {
				if (this.setupTasks.get(root) === work) { this.setupTasks.delete(root); }
			}
		}
		const pending = this.recompileTasks.get(root);
		if (pending) {
			for (const kind of kinds) { pending.kinds.add(kind); }
			return pending.work;
		}
		const merged = new Set(kinds);
		const work = this.executeOperation(folder, operation, merged, () => {
			if (this.recompileTasks.get(root)?.work === work) { this.recompileTasks.delete(root); }
		});
		this.recompileTasks.set(root, { kinds: merged, work });
		return work;
	}

	async request(folder: vscode.WorkspaceFolder, operation: Operation, kinds?: ReadonlySet<Change>): Promise<OperationResult> {
		try {
			return await this.execute(folder, operation, kinds);
		} catch (error: unknown) {
			if (error instanceof OperationError) { return error.result; }
			throw error;
		}
	}

	private failureResult(folder: vscode.WorkspaceFolder, operation: Operation, error: unknown, preflight = false): OperationResult {
		const failure = processFailure(error);
		const stage = preflight ? 'preflight' : error instanceof RecompileError ? error.stage : 'setup';
		const unavailable = failure.connection || error instanceof EditorNotReadyError ||
			(error instanceof RecompileError && error.cause instanceof EditorNotReadyError);
		const deferred = unavailable && (preflight || (error instanceof RecompileError && stage === 'preflight' &&
			error.recompileAttempts === 0 && !error.packagesResolved));
		return { projectRoot: folder.uri.fsPath, operation, exitCode: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr,
			stage, recompileAttempts: error instanceof RecompileError ? error.recompileAttempts : 0,
			packagesResolved: error instanceof RecompileError && error.packagesResolved,
			status: failure.cancelled ? 'cancelled' : deferred ? 'deferred' :
				stage === 'invoke' && failure.code === 6 ? 'compile-failure' : failure.connection ? 'connection-failure' : 'operation-failure',
			message: error instanceof Error ? error.message : String(error) };
	}

	private async executeOperation(folder: vscode.WorkspaceFolder, operation: Operation, kinds: ReadonlySet<Change> = new Set(['source']), started: () => void = () => {}): Promise<OperationResult> {
		const controller = new AbortController();
		this.controllers.add(controller);
		let result: OperationResult | undefined;
		const log = (message: string): void => {
			if (!this.lifetime.signal.aborted && message.trim()) { this.output.appendLine(`[${folder.name}] ${message.trim()}`); }
		};
		try {
			const completed = await this.perform(folder, operation, kinds, log, controller.signal, started);
			result = { ...completed, projectRoot: folder.uri.fsPath, operation, exitCode: 0, status: 'success',
				stage: operation === 'setup' ? 'setup' : 'postflight', message: '' };
			return result;
		} catch (error: unknown) {
			log(error instanceof Error ? error.message : String(error));
			result = this.failureResult(folder, operation, error);
			throw new OperationError(result, error);
		} finally {
			this.controllers.delete(controller);
			if (result) { this.changed.fire(result); }
		}
	}

	forget(folder: vscode.WorkspaceFolder): void {
		const root = folder.uri.toString();
		const previous = this.projects.get(root);
		previous?.controller.abort();
		this.projects.set(root, { controller: new AbortController(), tail: previous?.tail ?? Promise.resolve() });
		this.setupTasks.delete(root);
		this.recompileTasks.delete(root);
		this.diagnostics.clear(folder.uri.fsPath);
	}

	async waitUntilIdle(folder: vscode.WorkspaceFolder): Promise<void> {
		try { await this.waitForIdle(folder); }
		catch (error: unknown) {
			if (error instanceof OperationError) { throw error; }
			throw new OperationError(this.failureResult(folder, 'recompile', error, true), error);
		}
	}

	private async waitForIdle(folder: vscode.WorkspaceFolder): Promise<void> {
		if (!vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri).get<boolean>('autoSetup', true)) {
			await waitUntilEditorIdle(folder.uri.fsPath, 'unity',
				AbortSignal.any([this.stateFor(folder).controller.signal, this.lifetime.signal]), this.processFor(folder.uri.fsPath), false);
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
				AbortSignal.any([controller.signal, state.controller.signal, this.lifetime.signal]), this.processFor(folder.uri.fsPath), false);
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
		this.setupTasks.clear();
		this.recompileTasks.clear();
		this.diagnostics.dispose();
		this.changed.dispose();
	}
}
