import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Change } from './extension';

const runCli = promisify(execFile);

export async function waitUntilEditorIdle(projectRoot: string, executable = 'unity', signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + 300_000;
	while (true) {
		signal?.throwIfAborted();
		let stdout: string;
		try {
			({ stdout } = await runCli(executable, ['command', '--project-path', projectRoot, 'recompile_status', '--json'],
				{ cwd: projectRoot, windowsHide: true, signal, timeout: 30_000 }));
		} catch (error) {
			const detail = error instanceof Error ? `${error.message}\n${'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''}\n${'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''}` : '';
			if (signal?.aborted || !(error instanceof Error) || !/unreachable|connection refused|connection reset|ECONNREFUSED|ECONNRESET|No Unity Editor instances found|No running Unity Editor|No connected Unity Editor|No Pipeline instance found|Network error/i.test(detail)) {
				throw new Error(detail || String(error), { cause: error });
			}
			if (Date.now() >= deadline) {
				throw error;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			continue;
		}
		const response: unknown = JSON.parse(stdout);
		if (!response || typeof response !== 'object' || !('data' in response) || !response.data ||
			typeof response.data !== 'object' || !('result' in response.data) || !response.data.result ||
			typeof response.data.result !== 'object' || !('status' in response.data.result)) {
			throw new Error('Unity recompile status response is invalid');
		}
		const status = response.data.result.status;
		if (status === 'idle' || status === 'completed' || status === 'up_to_date') {
			return;
		}
		if ((status !== 'triggered' && status !== 'compiling') || Date.now() >= deadline) {
			throw new Error(`Unity recompile status: ${String(status)}`);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
	}
}

export async function runRecompile(projectRoot: string, kinds: ReadonlySet<Change>, executable = 'unity', signal?: AbortSignal): Promise<void> {
	const options = { cwd: projectRoot, windowsHide: true, signal, timeout: 180_000 };
	if (kinds.has('packages')) {
		await runCli(executable, ['command', '--project-path', projectRoot, 'package_resolve'], options);
		const deadline = Date.now() + 120_000;
		while (true) {
			const { stdout } = await runCli(executable, ['command', '--project-path', projectRoot, 'package_status', '--json'], options);
			const response: unknown = JSON.parse(stdout);
			if (!response || typeof response !== 'object' || !('data' in response) || !response.data ||
				typeof response.data !== 'object' || !('result' in response.data) || !response.data.result ||
				typeof response.data.result !== 'object' || !('status' in response.data.result)) {
				throw new Error('Unity package status response is invalid');
			}
			const status = response.data.result.status;
			if (status === 'completed') {
				break;
			}
			if (status === 'failed' || Date.now() >= deadline) {
				throw new Error(`Unity package resolution ${status === 'failed' ? 'failed' : 'timed out'}`);
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
		}
	}
	if (kinds.has('environment') || kinds.has('packages')) {
		await runCli(executable, ['command', '--project-path', projectRoot, 'menu', 'Assets/Refresh'], options);
	}
	await waitUntilEditorIdle(projectRoot, executable, signal);
	await runCli(executable, ['recompile', '--project-path', projectRoot], options);
	await waitUntilEditorIdle(projectRoot, executable, signal);
}
