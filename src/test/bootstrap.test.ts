import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CliBootstrapError, createUnityCliEnsurer, downloadInstaller, runCliProcess, supportsCliVersion } from '../bootstrap';
import type { BootstrapDependencies, CliProcess } from '../bootstrap';

suite('Unity CLI bootstrap', () => {
	for (const version of ['1.0.0-beta.11', '1.0.0-beta.13', '1.0.0-beta.100', '1.0.0-rc.1',
		'1.0.0', '1.1.0', '2.0.0', 'Unity CLI 1.0.0-beta.11', 'v1.0.0-beta.11+build.7']) {
		test(`accepts supported version when output is ${version}`, () => {
			const output = `${version}\n`;
			const supported = supportsCliVersion(output);
			assert.equal(supported, true);
		});
	}
	for (const version of ['1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-alpha.99', '2.0.0-alpha.1',
		'0.9.9', '1.0.0-beta.011', '1.0.0-beta.11.extra', '01.0.0', '1.0', 'Unity Editor 6000.0.11f1', 'garbage']) {
		test(`rejects unsupported version when output is ${version}`, () => {
			const supported = supportsCliVersion(version);
			assert.equal(supported, false);
		});
	}

	let storage: string;
	let commands: CliProcess[];
	let versions: Map<string, string>;
	let installerVersion: string;
	let downloaded: number;
	let source: string;
	let dependencies: BootstrapDependencies;
	const signal = () => new AbortController().signal;
	const ignoreLog = () => {};
	const binary = process.platform === 'win32' ? 'unity.exe' : 'unity';

	setup(async () => {
		storage = await mkdtemp(path.join(tmpdir(), 'unity-bootstrap-'));
		commands = [];
		versions = new Map();
		installerVersion = '1.0.0-beta.13';
		downloaded = 0;
		source = '$pathOutcome = Add-ToUserPath $InstallDir\nWrite-InstallReceipt $destFile $version\n';
		dependencies = {
			platform: process.platform, home: storage, env: { PATH: '', LOCALAPPDATA: path.join(storage, 'local') },
			download: async () => { downloaded++; return source; },
			run: async (command) => {
				commands.push(command);
				if (command.args.includes('--version')) {
					const version = versions.get(command.executable);
					if (version === undefined) { throw new CliBootstrapError('probe', 'Executable unavailable'); }
					return version;
				}
				versions.set(path.join(storage, 'unity-cli', 'bin', binary), installerVersion);
				return 'installed';
			}
		};
	});
	teardown(async () => { await rm(storage, { recursive: true, force: true }); });

	test('reuses a valid PATH binary when private CLI is missing', async () => {
		const executable = path.join(storage, 'existing', binary);
		versions.set(executable, '1.0.0-beta.11');
		const ensure = createUnityCliEnsurer({ ...dependencies, env: { PATH: path.dirname(executable) } });
		const result = await ensure(storage, ignoreLog, signal());
		assert.equal(result, executable);
		assert.equal(downloaded, 0);
	});

	test('discovers a known install when PATH contains an obsolete CLI', async () => {
		const old = path.join(storage, 'old', binary);
		const known = process.platform === 'win32'
			? path.join(storage, 'local', 'Unity', 'bin', binary) : path.join(storage, '.local', 'bin', binary);
		versions.set(old, '1.0.0-beta.2');
		versions.set(known, '1.0.0-beta.11');
		const ensure = createUnityCliEnsurer({ ...dependencies, env: { ...dependencies.env, PATH: path.dirname(old) } });
		const result = await ensure(storage, ignoreLog, signal());
		assert.equal(result, known);
		assert.equal(downloaded, 0);
	});

	test('installs privately with stable preference when every candidate is missing or old', async () => {
		const ensure = createUnityCliEnsurer({ ...dependencies,
			env: { ...dependencies.env, UNITY_CLI_CHANNEL: 'alpha', UNITY_CLI_VERSION: '0.1.0' } });
		const result = await ensure(storage, ignoreLog, signal());
		assert.equal(result, path.join(storage, 'unity-cli', 'bin', binary));
		const installation = commands.find((command) => !command.args.includes('--version'));
		assert.ok(installation);
		assert.equal(installation.env.UNITY_CLI_CHANNEL, '');
		assert.equal(installation.env.UNITY_CLI_VERSION, '');
		assert.equal(installation.env.UNITY_CLI_HOME, path.join(storage, 'unity-cli'));
		assert.equal(installation.env.HOME, path.join(storage, 'unity-cli', 'installer-home'));
		assert.equal(installation.env.ZDOTDIR, installation.env.HOME);
		assert.equal(installation.env.XDG_CONFIG_HOME, path.join(installation.env.HOME, '.config'));
		assert.equal(installation.signal.aborted, false);
		assert.equal(installation.timeout, 180_000);
	});

	test('rejects an old version when the installer reports success', async () => {
		installerVersion = '1.0.0-beta.2';
		const ensure = createUnityCliEnsurer(dependencies);
		await assert.rejects(ensure(storage, ignoreLog, signal()), (error: unknown) =>
			error instanceof CliBootstrapError && error.stage === 'verification');
	});

	test('reuses the private executable immediately when provisioning runs again', async () => {
		const ensure = createUnityCliEnsurer(dependencies);
		await ensure(storage, ignoreLog, signal());
		const result = await ensure(storage, ignoreLog, signal());
		assert.equal(result, path.join(storage, 'unity-cli', 'bin', binary));
		assert.equal(downloaded, 1);
	});

	test('reports installation failure when the shell exits unsuccessfully', async () => {
		const ensure = createUnityCliEnsurer({ ...dependencies, run: async (command) => {
			if (command.args.includes('--version')) { return '1.0.0-beta.2'; }
			throw new Error('Installer exit code 7');
		} });
		await assert.rejects(ensure(storage, ignoreLog, signal()), (error: unknown) =>
			error instanceof CliBootstrapError && error.stage === 'installation');
	});

	test('can retry when the previous installation failed', async () => {
		let failed = true;
		const ensure = createUnityCliEnsurer({ ...dependencies, download: async () => {
			if (failed) { failed = false; throw new CliBootstrapError('download', 'Offline'); }
			return source;
		} });
		await assert.rejects(ensure(storage, ignoreLog, signal()), CliBootstrapError);
		const result = await ensure(storage, ignoreLog, signal());
		assert.equal(result, path.join(storage, 'unity-cli', 'bin', binary));
	});

	test('avoids running any process when cancellation precedes provisioning', async () => {
		const controller = new AbortController();
		controller.abort();
		const ensure = createUnityCliEnsurer(dependencies);
		await assert.rejects(ensure(storage, ignoreLog, controller.signal));
		assert.equal(commands.length, 0);
	});

	test('propagates cancellation when a version probe is interrupted', async () => {
		const controller = new AbortController();
		const ensure = createUnityCliEnsurer({ ...dependencies, run: async () => {
			controller.abort();
			throw new CliBootstrapError('probe', 'Aborted');
		} });
		await assert.rejects(ensure(storage, ignoreLog, controller.signal));
		assert.equal(downloaded, 0);
	});

	if (process.platform === 'win32') {
		test('suppresses persistent PATH and receipt writes when executing Windows installer', async () => {
			const ensure = createUnityCliEnsurer(dependencies);
			await ensure(storage, ignoreLog, signal());
			const script = await readFile(path.join(storage, 'unity-cli', 'install.ps1'), 'utf8');
			const output = await runCliProcess({ executable: 'powershell.exe',
				args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(storage, 'unity-cli', 'install.ps1')],
				env: process.env, signal: signal(), timeout: 10_000 });
			assert.equal(output, '');
			assert.equal(script.includes('Add-ToUserPath $InstallDir'), false);
		});

		test('fails before execution when Windows installer side-effect boundaries change', async () => {
			source = 'Write-Host changed';
			const ensure = createUnityCliEnsurer(dependencies);
			await assert.rejects(ensure(storage, ignoreLog, signal()), (error: unknown) =>
				error instanceof CliBootstrapError && error.stage === 'installer');
			assert.equal(commands.some((command) => !command.args.includes('--version')), false);
		});
	}

	test('preserves argument boundaries when running a real process', async () => {
		const argument = 'space ; $value "quote"';
		const output = await runCliProcess({ executable: process.execPath,
			args: ['-e', 'process.stdout.write(process.argv[1])', argument], env: process.env, signal: signal(), timeout: 10_000 });
		assert.equal(output, argument);
	});

	test('rejects when a real child process exits unsuccessfully', async () => {
		const command = { executable: process.execPath, args: ['-e', 'process.exit(7)'],
			env: process.env, signal: signal(), timeout: 10_000 };
		await assert.rejects(runCliProcess(command));
	});

	test('bounds runtime when a real child process never completes', async () => {
		const command = { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
			env: process.env, signal: signal(), timeout: 50 };
		await assert.rejects(runCliProcess(command));
	});

	test('refuses downloads when the installer URL is not HTTPS', async () => {
		await assert.rejects(downloadInstaller('http://unity.com/install.sh', signal()), CliBootstrapError);
	});

	test('cancels downloading when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(downloadInstaller('https://unity.com/install.sh', controller.signal));
	});
});
