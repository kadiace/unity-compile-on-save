import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const windowsInstaller = 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.ps1';
const unixInstaller = 'https://unity.com/install.sh';

export class CliBootstrapError extends Error {
	readonly name = 'CliBootstrapError';
	constructor(readonly stage: string, detail: string) {
		super(`Unity CLI ${stage}: ${detail}`);
	}
}

export function supportsCliVersion(output: string): boolean {
	const match = /^(?:Unity CLI\s+)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.exec(output.trim());
	if (!match) { return false; }
	const [, major, minor, patch, prerelease] = match;
	if (prerelease && !/^(?:beta\.(0|[1-9]\d*)|rc\.(0|[1-9]\d*))$/.test(prerelease)) { return false; }
	if (Number(major) !== 1) { return Number(major) > 1; }
	if (Number(minor) > 0 || Number(patch) > 0 || prerelease === undefined) { return true; }
	return prerelease.startsWith('rc.') || Number(prerelease.slice(5)) >= 11;
}

export interface CliProcess {
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly signal: AbortSignal;
	readonly timeout: number;
}

export async function runCliProcess(command: CliProcess): Promise<string> {
	try {
		const { stdout } = await exec(command.executable, [...command.args], {
			env: command.env, signal: command.signal, timeout: command.timeout,
			killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 2 * 1024 * 1024
		});
		return stdout;
	} catch (error: unknown) {
		if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim()) {
			throw new CliBootstrapError('process', `${error.message}\n${error.stdout.trim()}`);
		}
		throw error;
	}
}

export async function downloadInstaller(url: string, signal: AbortSignal): Promise<string> {
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	async function request(target: string, redirects: number): Promise<string> {
		if (new URL(target).protocol !== 'https:') {
			throw new CliBootstrapError('download', 'Installer redirects must use HTTPS');
		}
		return new Promise<string>((resolve, reject) => {
			const req = get(target, { signal: bounded }, (response) => {
				const status = response.statusCode ?? 0;
				if (status >= 300 && status < 400 && response.headers.location && redirects < 5) {
					response.resume();
					resolve(request(new URL(response.headers.location, target).href, redirects + 1));
					return;
				}
				if (status !== 200) {
					response.resume();
					reject(new CliBootstrapError('download', `HTTP ${status} from ${target}`));
					return;
				}
				response.setEncoding('utf8');
				let source = '';
				response.on('data', (chunk: string) => {
					source += chunk;
					if (source.length > 1024 * 1024) {
						req.destroy(new CliBootstrapError('download', 'Installer exceeds 1 MiB'));
					}
				});
				response.on('error', reject);
				response.on('end', () => resolve(source));
			});
			req.on('error', reject);
		});
	}
	return request(url, 0);
}

export interface BootstrapDependencies {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
	readonly run: (command: CliProcess) => Promise<string>;
	readonly download: (url: string, signal: AbortSignal) => Promise<string>;
}

export function createUnityCliEnsurer(deps: BootstrapDependencies) {
	return async (storageRoot: string, log: (message: string) => void, signal: AbortSignal): Promise<string> => {
		signal.throwIfAborted();
		if (!['win32', 'darwin', 'linux'].includes(deps.platform)) {
			throw new CliBootstrapError('platform', `Unsupported platform ${deps.platform}`);
		}
		const windows = deps.platform === 'win32';
		const paths = windows ? path.win32 : path.posix;
		const root = paths.resolve(storageRoot, 'unity-cli');
		const binary = windows ? 'unity.exe' : 'unity';
		const installed = paths.join(root, 'bin', binary);
		const candidates = [installed];
		for (const dir of (deps.env.PATH ?? '').split(windows ? ';' : ':')) {
			if (dir) { candidates.push(paths.resolve(dir.replace(/^"|"$/g, ''), binary)); }
		}
		if (deps.env.UNITY_CLI_HOME) {
			candidates.push(paths.resolve(deps.env.UNITY_CLI_HOME, 'bin', binary));
		}
		if (windows) {
			if (deps.env.LOCALAPPDATA) {
				candidates.push(paths.join(deps.env.LOCALAPPDATA, 'Unity', 'bin', binary));
				candidates.push(paths.join(deps.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', binary));
			}
		} else {
			candidates.push(paths.join(deps.home, '.local', 'bin', binary), paths.join(deps.home, '.unity', 'bin', binary));
		}
		for (const executable of new Set(candidates)) {
			try {
				const version = await deps.run({ executable, args: ['--version'], env: deps.env, signal, timeout: 10_000 });
				if (supportsCliVersion(version)) {
					log(`Using Unity CLI ${version.trim()} at ${executable}`);
					return executable;
				}
			} catch (error) {
				signal.throwIfAborted();
				if (!(error instanceof Error)) { throw error; }
				log(`Cannot use Unity CLI at ${executable}: ${error.message}`);
			}
		}
		log('Installing an extension-private Unity CLI (stable preferred, beta fallback).');
		await mkdir(root, { recursive: true });
		let source = await deps.download(windows ? windowsInstaller : unixInstaller, signal);
		if (windows) {
			const pathCall = '$pathOutcome = Add-ToUserPath $InstallDir';
			const receiptCall = 'Write-InstallReceipt $destFile $version';
			if (source.split(pathCall).length !== 2 || source.split(receiptCall).length !== 2) {
				throw new CliBootstrapError('installer', 'Official Windows installer changed; cannot safely suppress user PATH/receipt writes');
			}
			source = source.replace(pathCall, '$pathOutcome = "manual"').replace(receiptCall, '$null = $destFile');
		}
		const script = paths.join(root, windows ? 'install.ps1' : 'install.sh');
		await writeFile(script, source, { encoding: 'utf8', mode: 0o600 });
		const privateHome = paths.join(root, 'installer-home');
		await mkdir(privateHome, { recursive: true });
		const env: NodeJS.ProcessEnv = { ...deps.env, UNITY_CLI_HOME: root, UNITY_CLI_CHANNEL: '', UNITY_CLI_VERSION: '',
			UNITY_CLI_CDN_BASE: 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/',
			HOME: privateHome, ZDOTDIR: privateHome, XDG_CONFIG_HOME: paths.join(privateHome, '.config'),
			BASH_ENV: '', ENV: '', NO_COLOR: '1' };
		if (windows) {
			env.PSModulePath = paths.join(deps.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
		}
		const executable = windows
			? paths.join(deps.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
			: '/bin/bash';
		const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
			: ['--noprofile', '--norc', script];
		try {
			const output = await deps.run({ executable, args, env, signal, timeout: 180_000 });
			log(output.trim());
			const version = await deps.run({ executable: installed, args: ['--version'], env: deps.env, signal, timeout: 10_000 });
			if (!supportsCliVersion(version)) {
				throw new CliBootstrapError('verification', `Installed version ${version.trim()} does not satisfy 1.0.0-beta.11 or later`);
			}
			log(`Installed Unity CLI ${version.trim()} at ${installed}`);
			return installed;
		} catch (error) {
			signal.throwIfAborted();
			if (!(error instanceof Error) || error instanceof CliBootstrapError) { throw error; }
			throw new CliBootstrapError('installation', error.message);
		}
	};
}

export const ensureUnityCli = createUnityCliEnsurer({
	platform: process.platform, env: process.env, home: homedir(), run: runCliProcess, download: downloadInstaller
});
