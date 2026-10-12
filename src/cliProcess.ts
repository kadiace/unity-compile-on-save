import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type ProcessOptions = {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
	readonly timeout?: number;
	readonly maxBuffer?: number;
	readonly killSignal?: NodeJS.Signals;
	readonly finishOnExit?: boolean;
	readonly log?: (chunk: string, stream: 'stdout' | 'stderr') => void;
};
export type ProcessResult = { readonly stdout: string; readonly stderr: string };
export type ProcessRunner = (executable: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;

export class CliProcessError extends Error {
	constructor(readonly executable: string, readonly code: number | null, readonly stdout: string, readonly stderr: string) {
		super(`${executable} exited with code ${code}.\n${stderr || stdout}`);
	}
}

export function processFailure(error: unknown): { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly cancelled: boolean; readonly connection: boolean } {
	let cause = error;
	let code: number | null = null;
	let stdout = '';
	let stderr = '';
	let cancelled = false;
	const messages: string[] = [];
	while (cause instanceof Error) {
		messages.push(cause.message);
		cancelled ||= cause.name === 'AbortError';
		if ('code' in cause && typeof cause.code === 'number') { code ??= cause.code; }
		if ('stdout' in cause && typeof cause.stdout === 'string') { stdout ||= cause.stdout; }
		if ('stderr' in cause && typeof cause.stderr === 'string') { stderr ||= cause.stderr; }
		cause = cause.cause;
	}
	return { code, stdout, stderr, cancelled, connection: !cancelled && (code === 7 || (code === null &&
		/unreachable|connection refused|connection reset|ECONNREFUSED|ECONNRESET|No Unity Editor instances found|No running Unity Editor|No connected Unity Editor|No Pipeline instance found|Network error/i.test(`${messages.join('\n')}\n${stdout}\n${stderr}`))) };
}

function cleanLauncherLogs(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true });
		rmSync(`${directory}.complete`, { force: true });
	} catch (error: unknown) {
		if (!(error instanceof Error) || !('code' in error) ||
			(error.code !== 'EPERM' && error.code !== 'EBUSY' && error.code !== 'ENOTEMPTY')) { throw error; }
	}
}

export const runProcess: ProcessRunner = (executable, args, options) => {
	options.signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const { log, finishOnExit, ...processOptions } = options;
		if (finishOnExit) {
			for (const entry of readdirSync(tmpdir())) {
				if (/^unity-cli-open-[A-Za-z0-9]{6}\.complete$/.test(entry)) {
					cleanLauncherLogs(path.join(tmpdir(), entry.slice(0, -'.complete'.length)));
				}
			}
			// File sinks keep inherited Editor handles valid after the launcher and extension exit.
			const directory = mkdtempSync(path.join(tmpdir(), 'unity-cli-open-'));
			const stdoutFile = path.join(directory, 'stdout.log');
			const stderrFile = path.join(directory, 'stderr.log');
			const stdoutFd = openSync(stdoutFile, 'w', 0o600);
			const stderrFd = openSync(stderrFile, 'w', 0o600);
			let finished = false;
			const finish = (code: number | null, error?: Error): void => {
				if (finished) { return; }
				finished = true;
				closeSync(stdoutFd);
				closeSync(stderrFd);
				try {
					const stdout = readFileSync(stdoutFile, 'utf8');
					const stderr = readFileSync(stderrFile, 'utf8');
					log?.(stdout, 'stdout');
					log?.(stderr, 'stderr');
					writeFileSync(`${directory}.complete`, '', { mode: 0o600 });
					cleanLauncherLogs(directory);
					if (error) { reject(error); }
					else if (code === 0) { resolve({ stdout, stderr }); }
					else { reject(new CliProcessError(executable, code, stdout, stderr)); }
				} catch (readError: unknown) { reject(readError); }
			};
			try {
				const child = spawn(executable, [...args], { ...processOptions, windowsHide: true, stdio: ['ignore', stdoutFd, stderrFd] });
				child.once('error', (error) => finish(null, error));
				child.once('exit', (code) => finish(code));
			} catch (error: unknown) {
				if (error instanceof Error) { finish(null, error); } else { reject(error); }
			}
			return;
		}
		const child = execFile(executable, [...args], { ...processOptions, windowsHide: true, encoding: 'utf8', maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) { reject(Object.assign(error, { stdout, stderr })); }
				else { resolve({ stdout, stderr }); }
			});
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => log?.(chunk, 'stdout'));
		child.stderr?.on('data', (chunk: string) => log?.(chunk, 'stderr'));
	});
};
