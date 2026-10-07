import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Change } from './extension';

const runCli = promisify(execFile);

export async function waitUntilEditorIdle(projectRoot: string): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (true) {
		let stdout: string;
		try {
			({ stdout } = await runCli('unity', ['command', '--project-path', projectRoot, 'recompile_status', '--json'],
				{ cwd: projectRoot, windowsHide: true }));
		} catch (error) {
			if (!(error instanceof Error) || !/unreachable|connection refused|ECONNREFUSED|No Unity Editor instances found/i.test(error.message)) {
				throw error;
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

export async function runRecompile(projectRoot: string, kinds: ReadonlySet<Change>): Promise<void> {
	const options = { cwd: projectRoot, windowsHide: true };
	if (kinds.has('packages')) {
		await runCli('unity', ['command', '--project-path', projectRoot, 'package_resolve'], options);
		const deadline = Date.now() + 120_000;
		while (true) {
			const { stdout } = await runCli('unity', ['command', '--project-path', projectRoot, 'package_status', '--json'], options);
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
		await runCli('unity', ['command', '--project-path', projectRoot, 'menu', 'Assets/Refresh'], options);
	}
	await waitUntilEditorIdle(projectRoot);
	await runCli('unity', ['recompile', '--project-path', projectRoot], options);
}
