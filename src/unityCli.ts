import type { Change } from './extension';
import { setTimeout as delay } from 'node:timers/promises';
import { processFailure, runProcess } from './cliProcess';
import type { ProcessResult, ProcessRunner } from './cliProcess';

export type RecompileStage = 'package' | 'preflight' | 'invoke' | 'postflight';
export class EditorNotReadyError extends Error {}

export async function isBlockedByDialog(projectRoot: string, executable: string, signal: AbortSignal | undefined,
	runCli: ProcessRunner, log: (message: string) => void = () => {}): Promise<boolean> {
	let stdout: string;
	try {
		({ stdout } = await runCli(executable, ['status', '--project-path', projectRoot, '--format', 'json'],
			{ cwd: projectRoot, signal, timeout: 10_000 }));
	} catch (error: unknown) {
		signal?.throwIfAborted();
		stdout = processFailure(error).stdout;
	}
	try {
		const response: unknown = JSON.parse(stdout);
		if (!response || typeof response !== 'object') { throw new Error('Invalid status response'); }
		let blocked = false;
		const details: string[] = [];
		const visit = (value: unknown): void => {
			if (!value || typeof value !== 'object') { return; }
			if ('code' in value && value.code === 'STATUS_BLOCKED_BY_DIALOG') {
				blocked = true;
				if ('message' in value && typeof value.message === 'string') { details.push(value.message); }
			}
			if ('blockedBy' in value && value.blockedBy && typeof value.blockedBy === 'object') {
				const cause = value.blockedBy;
				if ('dialogs' in cause && Array.isArray(cause.dialogs) && cause.dialogs.length > 0) {
					blocked = true;
					if ('reason' in cause && typeof cause.reason === 'string') { details.push(cause.reason); }
					for (const dialog of cause.dialogs) {
						if (dialog && typeof dialog === 'object' && 'title' in dialog && typeof dialog.title === 'string') {
							details.push(`${'level' in dialog ? String(dialog.level) : 'dialog'}: ${dialog.title}`);
						}
					}
				}
			}
			Object.values(value).forEach(visit);
		};
		visit(response);
		if (blocked) { log(`Recompile skipped: STATUS_BLOCKED_BY_DIALOG. ${details.join('; ')}`); }
		else if ('success' in response && response.success === false) {
			log('Unity status query failed; continuing existing Recompile flow.');
		}
		return blocked;
	} catch (error: unknown) {
		log(`Unity status unavailable; continuing existing Recompile flow: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export class RecompileError extends Error {
	readonly stdout: string;
	readonly stderr: string;
	constructor(readonly stage: RecompileStage, readonly recompileAttempts: number, readonly packagesResolved: boolean, cause: unknown, result?: ProcessResult) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		const failure = processFailure(cause);
		this.stdout = result?.stdout ?? failure.stdout;
		this.stderr = result?.stderr ?? failure.stderr;
	}
}

export async function waitUntilEditorIdle(projectRoot: string, executable = 'unity', signal?: AbortSignal, runCli: ProcessRunner = runProcess, waitForConnection = true, log: (message: string) => void = () => {}): Promise<void> {
	const deadline = Date.now() + 300_000;
	while (true) {
		signal?.throwIfAborted();
		if (await isBlockedByDialog(projectRoot, executable, signal, runCli, log)) { return; }
		let stdout: string;
		try {
			({ stdout } = await runCli(executable, ['command', '--project-path', projectRoot, 'recompile_status', '--json'],
				{ cwd: projectRoot, signal, timeout: 30_000 }));
		} catch (error) {
			if (!waitForConnection || signal?.aborted || !processFailure(error).connection || Date.now() >= deadline) {
				throw error;
			}
			await delay(1000, undefined, { signal });
			continue;
		}
		const response: unknown = JSON.parse(stdout);
		if (!response || typeof response !== 'object' || ('success' in response && response.success !== true) || !('data' in response) || !response.data ||
			typeof response.data !== 'object' || !('result' in response.data) || !response.data.result ||
			typeof response.data.result !== 'object' || !('status' in response.data.result)) {
			throw new Error('Unity recompile status response is invalid');
		}
		const status = response.data.result.status;
		if (status === 'idle' || status === 'completed' || status === 'up_to_date') {
			return;
		}
		if (status !== 'triggered' && status !== 'compiling' && status !== 'queued' && status !== 'running') {
			throw new Error(`Unity recompile status: ${String(status)}`);
		}
		if (Date.now() >= deadline) { throw new EditorNotReadyError(`Unity Editor is still busy (${status}).`); }
		await delay(300, undefined, { signal });
	}
}

export async function runRecompile(projectRoot: string, kinds: ReadonlySet<Change>, executable = 'unity', signal?: AbortSignal, runCli: ProcessRunner = runProcess,
	beforeRecompile: () => void = () => {}, log: (message: string) => void = () => {}): Promise<ProcessResult & { readonly recompileAttempts: number; readonly packagesResolved: boolean }> {
	const options = { cwd: projectRoot, signal, timeout: 180_000 };
	let stage: RecompileStage = 'package';
	let recompileAttempts = 0;
	let packagesResolved = false;
	let result: ProcessResult | undefined;
	try {
		if (await isBlockedByDialog(projectRoot, executable, signal, runCli, log)) {
			return { stdout: '', stderr: '', recompileAttempts, packagesResolved };
		}
		if (kinds.has('packages')) {
			await runCli(executable, ['command', '--project-path', projectRoot, 'package_resolve'], options);
			const deadline = Date.now() + 120_000;
			while (true) {
				const { stdout } = await runCli(executable, ['command', '--project-path', projectRoot, 'package_status', '--json'], options);
				const response: unknown = JSON.parse(stdout);
				if (!response || typeof response !== 'object' || ('success' in response && response.success !== true) || !('data' in response) || !response.data ||
					typeof response.data !== 'object' || !('result' in response.data) || !response.data.result ||
					typeof response.data.result !== 'object' || !('status' in response.data.result)) {
					throw new Error('Unity package status response is invalid');
				}
				const status = response.data.result.status;
				if (status === 'completed') {
					packagesResolved = true;
					break;
				}
				if (status === 'failed' || Date.now() >= deadline) {
					throw new Error(`Unity package resolution ${status === 'failed' ? 'failed' : 'timed out'}`);
				}
				await delay(300, undefined, { signal });
			}
		}
		if (kinds.has('environment') || kinds.has('packages')) {
			await runCli(executable, ['command', '--project-path', projectRoot, 'menu', 'Assets/Refresh'], options);
		}
		while (true) {
			stage = 'preflight';
			await waitUntilEditorIdle(projectRoot, executable, signal, runCli, false);
			if (await isBlockedByDialog(projectRoot, executable, signal, runCli, log)) {
				return { stdout: '', stderr: '', recompileAttempts, packagesResolved };
			}
			stage = 'invoke';
			signal?.throwIfAborted();
			beforeRecompile();
			recompileAttempts++;
			try {
				result = await runCli(executable, ['recompile', '--project-path', projectRoot], options);
				break;
			} catch (error: unknown) {
				if (signal?.aborted || processFailure(error).code !== 7 || recompileAttempts >= 3) { throw error; }
				await delay(recompileAttempts * 500, undefined, { signal });
			}
		}
		stage = 'postflight';
		await waitUntilEditorIdle(projectRoot, executable, signal, runCli, false);
		return { ...result, recompileAttempts, packagesResolved };
	} catch (error: unknown) {
		throw new RecompileError(stage, recompileAttempts, packagesResolved, error, result);
	}
}
