import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { UnityTaskRunner } from '../unityTasks';
import { runProcess } from '../cliProcess';

suite('Unity background operations', () => {
	const project = path.resolve(__dirname, '../../src/test/fixtures/UnityProject');
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project));
	let storage: string;
	let runner: UnityTaskRunner;
	let output: vscode.OutputChannel;
	let nativeNode: string;
	let logs: string;
	let originalPath: string | undefined;
	const pipeline = path.join(project, 'pipeline');
	const command = path.join(project, 'command');
	const marker = path.join(project, 'pipeline-task-count.txt');
	const openScript = path.join(project, 'open');
	const childPidFile = path.join(project, 'open-child.pid');
	const writeFlag = path.join(project, 'open-write.flag');
	const writeMarker = path.join(project, 'open-write.done');
	const script = 'const fs=require("node:fs");if(process.argv[2]==="install")fs.appendFileSync("pipeline-task-count.txt","installed\\n");else console.log(JSON.stringify({data:{instances:[{projectPath:process.cwd(),isRunning:true,pid:123}]}}));';

	setup(() => {
		assert.ok(folder);
		rmSync(childPidFile, { force: true });
		storage = mkdtempSync(path.join(tmpdir(), 'unity-tasks-'));
		const executable = path.join(storage, process.platform === 'win32' ? 'unity.exe' : 'unity');
		const node = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
		assert.ok(node);
		nativeNode = node;
		copyFileSync(node, executable);
		chmodSync(executable, 0o755);
		originalPath = process.env.PATH;
		process.env.PATH = `${storage}${path.delimiter}${originalPath ?? ''}`;
		writeFileSync(pipeline, script);
		writeFileSync(command, 'console.log(JSON.stringify({data:{result:{status:"completed"}}}));');
		output = vscode.window.createOutputChannel('Unity task lifecycle test');
		logs = '';
		const append = output.append.bind(output);
		const appendLine = output.appendLine.bind(output);
		output.append = (value) => { logs += value; append(value); };
		output.appendLine = (value) => { logs += `${value}\n`; appendLine(value); };
		runner = new UnityTaskRunner(storage, output, async () => executable);
	});
	teardown(() => {
		runner.dispose();
		output.dispose();
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		if (existsSync(childPidFile)) {
			try { process.kill(Number(readFileSync(childPidFile, 'utf8'))); } catch (error: unknown) {
				if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') { throw error; }
			}
		}
		for (const file of [pipeline, command, marker, openScript, childPidFile, writeFlag, writeMarker, path.join(project, 'recompile')]) { rmSync(file, { force: true }); }
		rmSync(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	test('resolves without creating terminals or changing editor focus when setup succeeds', async () => {
		assert.ok(folder);
		const terminals = [...vscode.window.terminals];
		const editor = vscode.window.activeTextEditor;
		await runner.execute(folder, 'setup');
		assert.equal(readFileSync(marker, 'utf8'), 'installed\n');
		assert.deepEqual(vscode.window.terminals, terminals);
		assert.equal(vscode.window.activeTextEditor, editor);
	});

	test('probes the same PATH CLI used for saves when automatic setup is disabled after explicit setup', async () => {
		assert.ok(folder);
		await runner.execute(folder, 'setup');
		assert.equal(await runner.connectionExecutable(folder), 'unity');
	});

	test('finishes setup while an opened Editor still owns inherited process handles', async () => {
		assert.ok(folder);
		writeFileSync(pipeline, 'console.log(JSON.stringify({data:{instances:[]}}));');
		const editor = 'const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync("open-write.flag")){clearInterval(timer);process.stdout.write("Editor still running\\n",()=>fs.writeFileSync("open-write.done","wrote"));setInterval(()=>{},1000);}},20);';
		writeFileSync(openScript, `console.log("launcher stdout");console.error("launcher stderr");const child=require("node:child_process").spawn(${JSON.stringify(nativeNode)},["-e",${JSON.stringify(editor)}],{stdio:"inherit",detached:true});require("node:fs").writeFileSync("open-child.pid",String(child.pid));child.unref();`);
		await runner.execute(folder, 'setup');
		const pid = Number(readFileSync(childPidFile, 'utf8'));
		assert.ok(Number.isInteger(pid) && pid > 0);
		assert.doesNotThrow(() => process.kill(pid, 0));
		const written = new Promise<void>((resolve, reject) => {
			const observer = watch(project, (_, file) => {
				if (file === 'open-write.done') { clearTimeout(timeout); observer.close(); resolve(); }
			});
			const timeout = setTimeout(() => { observer.close(); reject(new Error('Editor could not write after launcher exit')); }, 3000);
		});
		writeFileSync(writeFlag, 'write now');
		await written;
		assert.equal(readFileSync(writeMarker, 'utf8'), 'wrote');
		assert.doesNotThrow(() => process.kill(pid, 0));
		assert.match(logs, /launcher stdout/);
		assert.match(logs, /launcher stderr/);
	});

	test('checks Pipeline again when an explicit setup task reconnects a ready project', async () => {
		assert.ok(folder);
		await runner.execute(folder, 'setup');
		await runner.execute(folder, 'setup');
		assert.equal(readFileSync(marker, 'utf8'), 'installed\ninstalled\n');
	});

	test('rejects a failed task and allows a later setup to recover', async () => {
		assert.ok(folder);
		writeFileSync(pipeline, 'process.stderr.write("pipeline failure");process.exit(7);');
		await assert.rejects(runner.execute(folder, 'setup'), /pipeline failure/);
		writeFileSync(pipeline, script);
		await runner.execute(folder, 'setup');
		assert.equal(existsSync(marker), true);
	});

	test('rejects a cancelled operation without cancelling CLI provisioning shared with its retry', async () => {
		assert.ok(folder);
		const currentFolder = folder;
		runner.dispose();
		let provisioned = 0;
		runner = new UnityTaskRunner(storage, output, async () => {
			provisioned++;
			runner.forget(currentFolder);
			return path.join(storage, process.platform === 'win32' ? 'unity.exe' : 'unity');
		});
		await assert.rejects(runner.execute(folder, 'setup'), /abort/i);
		writeFileSync(pipeline, script);
		await runner.execute(folder, 'setup');
		assert.equal(existsSync(marker), true);
		assert.equal(provisioned, 1);
	});

	test('publishes compiler errors and warnings from both streams when recompilation fails', async () => {
		assert.ok(folder);
		writeFileSync(path.join(project, 'recompile'), 'process.stdout.write("Assets/Test.cs(12,3): warning CS0168: unused variable\\n");process.stderr.write("Assets/Test.cs(24,5): error CS1002: ; expected");process.exitCode=7;');
		const terminals = [...vscode.window.terminals];
		await assert.rejects(runner.execute(folder, 'recompile'), /expected/);
		const diagnostics = runner.diagnostics.collection.get(vscode.Uri.file(path.join(project, 'Assets/Test.cs')));
		assert.ok(diagnostics);
		assert.deepEqual(diagnostics.map((item) => [item.range.start.line, item.range.start.character, item.severity, item.code]),
			[[11, 2, vscode.DiagnosticSeverity.Warning, 'CS0168'], [23, 4, vscode.DiagnosticSeverity.Error, 'CS1002']]);
		assert.match(logs, /unused variable/);
		assert.match(logs, /; expected/);
		assert.deepEqual(vscode.window.terminals, terminals);
	});

	test('clears stale compiler diagnostics when the next recompilation has no errors', async () => {
		assert.ok(folder);
		const file = path.join(project, 'recompile');
		writeFileSync(file, 'console.error("Assets/Test.cs(1,1): error CS1002: ; expected");process.exitCode=7;');
		await assert.rejects(runner.execute(folder, 'recompile'));
		const uri = vscode.Uri.file(path.join(project, 'Assets/Test.cs'));
		assert.equal(runner.diagnostics.collection.get(uri)?.length, 1);
		writeFileSync(file, 'console.log("clean compile");');
		await runner.execute(folder, 'recompile');
		assert.equal(runner.diagnostics.collection.get(uri)?.length ?? 0, 0);
		assert.match(logs, /clean compile/);
	});

	test('streams Pipeline logs before the process exits and cancels it on disposal', async () => {
		const controller = new AbortController();
		let observed: (() => void) | undefined;
		const streaming = new Promise<void>((resolve) => { observed = resolve; });
		const append = output.append.bind(output);
		output.append = (value) => { append(value); if (value.includes('connected')) { observed?.(); } };
		const running = runner.processFor(project)(nativeNode, ['-e', 'console.log("connected");setInterval(()=>{},1000);'],
			{ signal: controller.signal, timeout: 3000 });
		const rejected = assert.rejects(running, /abort/i);
		await streaming;
		controller.abort();
		await rejected;
		assert.match(logs, /connected/);
	});

	test('does not restore historical compile errors from readiness polling after a clean recompile', async () => {
		assert.ok(folder);
		writeFileSync(command, 'console.log(JSON.stringify({data:{result:{status:"completed",errors:["Assets/Old.cs(1,1): error CS1002: old error"]}}}));');
		writeFileSync(path.join(project, 'recompile'), 'console.log("clean");');
		await runner.execute(folder, 'recompile');
		assert.equal(runner.diagnostics.collection.get(vscode.Uri.file(path.join(project, 'Assets/Old.cs')))?.length ?? 0, 0);
		assert.match(logs, /old error/);
	});

	test('does not report intentional lifecycle cancellation as an operational failure', async () => {
		await runner.processFor(project)(nativeNode, ['-e', 'console.log("ready");'], { timeout: 3000 });
		const previous = logs;
		runner.reportFailure('cancelled', new Error('idle wait cancelled', { cause: new DOMException('cancelled', 'AbortError') }));
		assert.equal(logs, previous);
	});

	test('does not cancel replacement setup when an old managed idle wait is aborted', async () => {
		assert.ok(folder);
		const config = vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri);
		const previousAutoSetup = config.inspect<boolean>('autoSetup')?.workspaceFolderValue;
		const previousRecompile = config.inspect<boolean>('recompileOnSave')?.workspaceFolderValue;
		await config.update('recompileOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
		await config.update('autoSetup', true, vscode.ConfigurationTarget.WorkspaceFolder);
		try {
			await runner.execute(folder, 'setup');
			writeFileSync(command, 'setInterval(()=>{},1000);');
			const oldWait = assert.rejects(runner.waitUntilIdle(folder), /abort/i);
			runner.forget(folder);
			writeFileSync(command, 'console.log(JSON.stringify({data:{result:{status:"completed"}}}));');
			const replacement = runner.execute(folder, 'setup');
			await oldWait;
			await replacement;
			assert.equal(readFileSync(marker, 'utf8'), 'installed\ninstalled\n');
		} finally {
			await config.update('autoSetup', previousAutoSetup, vscode.ConfigurationTarget.WorkspaceFolder);
			await config.update('recompileOnSave', previousRecompile, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});

	test('cleans completed launcher logs on a later invocation without touching an active launcher directory', async () => {
		const stale = mkdtempSync(path.join(tmpdir(), 'unity-cli-open-'));
		const active = mkdtempSync(path.join(tmpdir(), 'unity-cli-open-'));
		writeFileSync(path.join(stale, 'stdout.log'), 'old launcher');
		writeFileSync(`${stale}.complete`, '');
		try {
			await runProcess(nativeNode, ['-e', 'console.log("new launcher");'], { finishOnExit: true, timeout: 3000 });
			assert.equal(existsSync(stale), false);
			assert.equal(existsSync(`${stale}.complete`), false);
			assert.equal(existsSync(active), true);
		} finally {
			for (const directory of [stale, active]) { rmSync(directory, { recursive: true, force: true }); }
			rmSync(`${stale}.complete`, { force: true });
		}
	});
});
