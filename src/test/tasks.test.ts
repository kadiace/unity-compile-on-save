import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { UnityTaskRunner } from '../unityTasks';

suite('Unity VS Code tasks', () => {
	const project = path.resolve(__dirname, '../../src/test/fixtures/UnityProject');
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project));
	let storage: string;
	let runner: UnityTaskRunner;
	let output: vscode.OutputChannel;
	const pipeline = path.join(project, 'pipeline');
	const command = path.join(project, 'command');
	const marker = path.join(project, 'pipeline-task-count.txt');
	const script = 'const fs=require("node:fs");if(process.argv[2]==="install")fs.appendFileSync("pipeline-task-count.txt","installed\\n");else console.log(JSON.stringify({data:{instances:[{projectPath:process.cwd(),isRunning:true,pid:123}]}}));';

	setup(() => {
		assert.ok(folder);
		storage = mkdtempSync(path.join(tmpdir(), 'unity-tasks-'));
		const executable = path.join(storage, process.platform === 'win32' ? 'unity.exe' : 'unity');
		const node = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
		assert.ok(node);
		copyFileSync(node, executable);
		chmodSync(executable, 0o755);
		writeFileSync(pipeline, script);
		writeFileSync(command, 'console.log(JSON.stringify({data:{result:{status:"completed"}}}));');
		output = vscode.window.createOutputChannel('Unity task lifecycle test');
		runner = new UnityTaskRunner(storage, output, async () => executable);
	});
	teardown(() => {
		runner.dispose();
		output.dispose();
		for (const file of [pipeline, command, marker]) { rmSync(file, { force: true }); }
		rmSync(storage, { recursive: true, force: true });
	});

	test('resolves when a real custom setup task exits successfully', async () => {
		assert.ok(folder);
		await runner.execute(folder, 'setup');
		assert.equal(readFileSync(marker, 'utf8'), 'installed\n');
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
		await assert.rejects(runner.execute(folder, 'setup'), /Unity task failed/);
		writeFileSync(pipeline, script);
		await runner.execute(folder, 'setup');
		assert.equal(existsSync(marker), true);
	});

	test('rejects a cancelled task without cancelling CLI provisioning shared with its retry', async () => {
		assert.ok(folder);
		writeFileSync(pipeline, 'setInterval(()=>{},1000);');
		const listener = vscode.tasks.onDidStartTask((event) => {
			if (event.execution.task.definition.type === 'unityCompileOnSave') { event.execution.terminate(); }
		});
		try { await assert.rejects(runner.execute(folder, 'setup'), /Unity task failed/); } finally { listener.dispose(); }
		writeFileSync(pipeline, script);
		await runner.execute(folder, 'setup');
		assert.equal(existsSync(marker), true);
	});
});
