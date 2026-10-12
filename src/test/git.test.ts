import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { UnityTaskRunner } from '../unityTasks';

suite('Git transactions', () => {
	test('coalesces actual checkout and a slow pull into one compile after pull completion and the two-second quiet period', async function () {
		this.timeout(30000);
		const root = mkdtempSync(path.join(tmpdir(), 'unity-git-quiet-'));
		const project = vscode.Uri.file(path.join(root, 'Project')).fsPath;
		const remote = path.join(root, 'Remote.git');
		const bin = path.join(root, 'bin');
		const originalPath = process.env.PATH ?? '';
		const workspaceFile = vscode.workspace.workspaceFile;
		assert.ok(workspaceFile?.scheme === 'file');
		const originalWorkspace = readFileSync(workspaceFile.fsPath);
		const gitConfig = vscode.workspace.getConfiguration('git');
		const gitEnabled = gitConfig.inspect<boolean>('enabled')?.globalValue;
		const listeners: vscode.Disposable[] = [];
		let terminal: vscode.Terminal | undefined;
		let finished: Promise<number | undefined> | undefined;
		let added = false;
		const git = (...args: string[]): string => execFileSync('git', args, {
			cwd: project, encoding: 'utf8', windowsHide: true,
			env: { ...process.env, GIT_MASTER: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
				GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
		}).trim();
		try {
			// Given
			await gitConfig.update('enabled', false, vscode.ConfigurationTarget.Global);
			mkdirSync(path.join(project, 'Assets'), { recursive: true });
			mkdirSync(path.join(project, 'ProjectSettings'));
			mkdirSync(path.join(project, '.vscode'));
			mkdirSync(bin);
			writeFileSync(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
			writeFileSync(path.join(project, '.vscode', 'settings.json'), JSON.stringify({
				'unityCompileOnSave.autoSetup': false, 'unityCompileOnSave.showConnectionStatus': false,
				'unityCompileOnSave.recompileOnSave': true, 'unityCompileOnSave.recompileOnSourceChanges': true,
				'unityCompileOnSave.quietPeriodSeconds': 2
			}));
			const source = path.join(project, 'Assets', 'Example.cs');
			writeFileSync(source, 'class Example { const int Value = 0; }');
			git('init', '-b', 'main');
			git('add', 'Assets/Example.cs', 'ProjectSettings/ProjectVersion.txt');
			const first = git('commit-tree', git('write-tree'), '-m', 'Fixture base');
			git('update-ref', 'refs/heads/main', first);
			git('branch', 'checkout-target', first);
			writeFileSync(source, 'class Example { const int Value = 1; }');
			git('add', 'Assets/Example.cs');
			const second = git('commit-tree', git('write-tree'), '-p', first, '-m', 'Fixture update');
			git('update-ref', 'refs/heads/main', second);
			git('clone', '--bare', project, remote);
			git('remote', 'add', 'origin', remote);
			const delayedUpload = path.join(root, 'upload.cjs');
			const fetchStarted = path.join(root, 'fetch-started');
			writeFileSync(delayedUpload, `require('node:fs').writeFileSync(${JSON.stringify(fetchStarted)}, 'started');setTimeout(() => { const child = require('node:child_process').spawn('git-upload-pack', process.argv.slice(2), {stdio: 'inherit'});child.on('exit', code => process.exit(code ?? 1)); }, 3500);`);
			const node = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
			assert.ok(node);
			const executable = path.join(bin, process.platform === 'win32' ? 'unity.exe' : 'unity');
			copyFileSync(node, executable);
			chmodSync(executable, 0o755);
			const calls = path.join(project, 'cli-calls.log');
			writeFileSync(path.join(project, 'command'), 'console.log(JSON.stringify({data:{result:{status:"completed"}}}))');
			writeFileSync(path.join(project, 'recompile'), 'require("node:fs").appendFileSync("cli-calls.log","recompile\\n")');
			process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
			const extension = vscode.extensions.getExtension<UnityTaskRunner>('kadiace.unity-compile-on-save');
			assert.ok(extension);
			await extension.activate();
			const folderChanged = new Promise<void>((resolve) => {
				listeners.push(vscode.workspace.onDidChangeWorkspaceFolders((event) => {
					if (event.added.some((folder) => folder.uri.fsPath === project)) { resolve(); }
				}));
			});
			added = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(project) });
			assert.equal(added, true);
			await folderChanged;
			terminal = vscode.window.createTerminal({ name: 'Checkout-pull QA', cwd: project,
				shellPath: process.platform === 'win32' ? 'pwsh.exe' : '/bin/bash' });
			const createdTerminal = terminal;
			const shell = await new Promise<vscode.TerminalShellIntegration>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('Shell integration unavailable')), 10000);
				listeners.push(vscode.window.onDidChangeTerminalShellIntegration((event) => {
					if (event.terminal === terminal) { clearTimeout(timeout); resolve(event.shellIntegration); }
				}));
				if (createdTerminal.shellIntegration) { clearTimeout(timeout); resolve(createdTerminal.shellIntegration); }
			});
			let ended = false;
			finished = new Promise<number | undefined>((resolve) => {
				listeners.push(vscode.window.onDidEndTerminalShellExecution((event) => {
					if (event.terminal === terminal && /\bpull\b/.test(event.execution.commandLine.value)) { ended = true; resolve(event.exitCode); }
				}));
			});
			const compiled = new Promise<void>((resolve) => {
				listeners.push(extension.exports.onDidComplete((event) => {
					if (event.projectRoot === project && event.operation === 'recompile') { assert.equal(event.exitCode, 0); resolve(); }
				}));
			});
			const fetching = new Promise<void>((resolve) => {
				const observer = watch(root, (_, file) => {
					if (file === 'fetch-started') { observer.close(); resolve(); }
				});
				listeners.push(new vscode.Disposable(() => observer.close()));
			});
			const upload = `node '${delayedUpload.replaceAll('\\', '/')}'`;
			const checkedOut = new Promise<number | undefined>((resolve) => {
				listeners.push(vscode.window.onDidEndTerminalShellExecution((event) => {
					if (event.terminal === terminal && /\bcheckout\b/.test(event.execution.commandLine.value)) { resolve(event.exitCode); }
				}));
			});
			// When
			shell.executeCommand('git checkout checkout-target');
			assert.equal(await checkedOut, 0);
			shell.executeCommand(`git -c "remote.origin.uploadpack=${upload}" pull --ff-only origin main`);
			await fetching;
			await new Promise<void>((resolve) => setTimeout(resolve, 2500));
			// Then
			assert.equal(ended, false, 'Pull must still be in its network phase');
			assert.equal(existsSync(calls), false, 'No compile is allowed between checkout and pull');
			assert.equal(await finished, 0);
			assert.equal(readFileSync(source, 'utf8'), 'class Example { const int Value = 1; }');
			await new Promise<void>((resolve) => setTimeout(resolve, 500));
			assert.equal(existsSync(calls), false, 'Pull completion must restart the full quiet period');
			await compiled;
			await new Promise<void>((resolve) => setTimeout(resolve, 500));
			assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['recompile']);
			console.log('GIT_QA: checkout + slow pull, zero compiles during fetch, one compile after pull and quiet period');
		} finally {
			await finished;
			if (terminal) {
				const closed = new Promise<void>((resolve) => {
					const listener = vscode.window.onDidCloseTerminal((item) => {
						if (item === terminal) { listener.dispose(); resolve(); }
					});
				});
				terminal.dispose();
				await closed;
			}
			for (const listener of listeners) { listener.dispose(); }
			if (added) {
				const folder = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.fsPath === project);
				if (folder) {
					await new Promise<void>((resolve) => {
						const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); });
						vscode.workspace.updateWorkspaceFolders(folder.index, 1);
					});
				}
			}
			process.env.PATH = originalPath;
			await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			writeFileSync(workspaceFile.fsPath, originalWorkspace);
			await gitConfig.update('enabled', gitEnabled, vscode.ConfigurationTarget.Global);
		}
	});
});
