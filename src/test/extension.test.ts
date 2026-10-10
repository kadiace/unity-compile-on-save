import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { createRecompileHandler, findUnityProjectRoot } from '../extension';

function nextCompletedRecompile(): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const listener = vscode.tasks.onDidEndTaskProcess((event) => {
			if (event.execution.task.definition.type === 'unityCompileOnSave' && event.execution.task.definition.operation === 'recompile') {
				clearTimeout(timeout);
				listener.dispose();
				if (event.exitCode === 0) { resolve(); } else { reject(new Error('Unity recompile task failed')); }
			}
		});
		const timeout = setTimeout(() => { listener.dispose(); reject(new Error('Unity recompile task did not finish')); }, 8000);
	});
}

suite('Unity Compile on Save', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'unity-compile-on-save-'));
	const project = path.resolve(__dirname, '../../src/test/fixtures/UnityProject');
	const scripts = path.join(project, 'Assets', 'Scripts');
	const csharp = path.join(scripts, 'Example.cs');
	const other = path.join(scripts, 'Example.txt');
	const outsideProject = path.join(root, 'OutsideUnityProject');
	const outside = path.join(outsideProject, 'Assets', 'Outside.cs');
	const config = vscode.workspace.getConfiguration('unityCompileOnSave');
	const previous = new Map([
		'compileUnityOnSave', 'recompileOnSave', 'recompileOnSourceChanges', 'recompileOnProjectEnvironmentChanges', 'quietPeriodSeconds'
	].map((key) => [key, config.inspect<boolean | number>(key)?.globalValue]));

	suiteSetup(async () => {
		await config.update('quietPeriodSeconds', 0.2, vscode.ConfigurationTarget.Global);
		mkdirSync(scripts, { recursive: true });
		mkdirSync(path.join(outsideProject, 'ProjectSettings'), { recursive: true });
		mkdirSync(path.dirname(outside), { recursive: true });
		writeFileSync(path.join(outsideProject, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 1');
		writeFileSync(csharp, 'class Example {}');
		writeFileSync(other, 'not C#');
		writeFileSync(outside, 'class Outside {}');
	});

	suiteTeardown(async () => {
		for (const [key, value] of previous) {
			await config.update(key, value, vscode.ConfigurationTarget.Global);
		}
		rmSync(path.join(project, 'Assets'), { recursive: true, force: true });
		rmSync(path.join(project, 'Packages'), { recursive: true, force: true });
		rmSync(path.join(project, 'command'), { force: true });
		rmSync(path.join(project, 'editor-idle.flag'), { force: true });
		rmSync(path.join(project, 'status-probed.txt'), { force: true });
		rmSync(path.join(project, 'cli-calls.log'), { force: true });
		rmSync(path.join(project, 'recompile'), { force: true });
		rmSync(path.join(project, 'recompile-called.txt'), { force: true });
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	test('defaults to source recompilation but not environment recompilation', async () => {
		await config.update('compileUnityOnSave', undefined, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSave', undefined, vscode.ConfigurationTarget.Global);
		assert.equal(config.get<boolean>('recompileOnSave'), true);
		assert.equal(config.get<boolean>('recompileOnSourceChanges'), true);
		assert.equal(config.get<boolean>('recompileOnProjectEnvironmentChanges'), false);
	});

	test('schedules source recompilation when neither master setting is explicitly configured', async () => {
		await config.update('compileUnityOnSave', undefined, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSave', undefined, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createRecompileHandler(async (root) => { calls.push(root); });
		try {
			handler.onFileChange(vscode.Uri.file(csharp));
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			assert.deepEqual(calls, [project]);
		} finally { handler.dispose(); }
	});

	test('finds a Unity project only when ProjectVersion.txt exists in an ancestor', () => {
		assert.equal(findUnityProjectRoot(csharp), project);
		assert.equal(findUnityProjectRoot(outside), outsideProject);
		assert.equal(findUnityProjectRoot(path.join(root, 'NotUnity.cs')), undefined);
	});

	test('does not schedule disabled, non-C# or Unity files outside the opened project', async () => {
		await config.update('recompileOnSave', false, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createRecompileHandler(async (projectRoot) => { calls.push(projectRoot); });
		const listener = vscode.workspace.onDidSaveTextDocument(handler.onSave);
		try {
			const csDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(csharp));
			const edit = new vscode.WorkspaceEdit();
			edit.insert(csDocument.uri, new vscode.Position(0, 0), '// saved\n');
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(await csDocument.save(), true);
			handler.onFileChange(csDocument.uri);
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls.length, 0);
			await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
			handler.onSave(await vscode.workspace.openTextDocument(vscode.Uri.file(other)));
			handler.onSave(await vscode.workspace.openTextDocument(vscode.Uri.file(outside)));
			handler.onFileChange(vscode.Uri.file(outside));
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls.length, 0);
		} finally {
			listener.dispose();
			handler.dispose();
		}
	});

	test('debounces save and file-change events in one Unity project', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createRecompileHandler(async (projectRoot) => { calls.push(projectRoot); });
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(csharp));
			handler.onSave(document);
			handler.onFileChange(document.uri);
			assert.equal(calls.length, 0);
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			assert.deepEqual(calls.map((value) => value.toLowerCase()), [project.toLowerCase()]);
		} finally {
			handler.dispose();
		}
	});

	test('source setting filters assembly, response and DLL changes', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnProjectEnvironmentChanges', false, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createRecompileHandler(async (projectRoot) => { calls.push(projectRoot); });
		try {
			for (const file of ['Assets/Scripts/Game.asmdef', 'Assets/Scripts/Game.asmref', 'Assets/csc.rsp', 'Assets/Plugins/Game.dll', 'Assets/Plugins/Game.dll.meta']) {
				handler.onFileChange(vscode.Uri.file(path.join(project, file)));
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			assert.equal(calls.length, 1);
			await config.update('recompileOnSourceChanges', false, vscode.ConfigurationTarget.Global);
			handler.onFileChange(vscode.Uri.file(csharp));
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls.length, 1);
		} finally {
			handler.dispose();
		}
	});

	test('environment setting filters package and scripting define files', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', false, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnProjectEnvironmentChanges', true, vscode.ConfigurationTarget.Global);
		const calls: ReadonlySet<string>[] = [];
		const handler = createRecompileHandler(async (_root, kinds) => { calls.push(kinds); });
		try {
			for (const file of ['Packages/manifest.json', 'Packages/packages-lock.json', 'Packages/com.example.tool/package.json',
				'ProjectSettings/ProjectSettings.asset', 'Assets/Settings/Build Profiles/Windows.asset']) {
				handler.onFileChange(vscode.Uri.file(path.join(project, file)));
			}
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Assets/Scripts/data.json')));
			handler.onFileChange(vscode.Uri.file(csharp));
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			assert.equal(calls.length, 1);
			assert.deepEqual([...calls[0]].sort(), ['environment', 'packages']);
			await config.update('recompileOnProjectEnvironmentChanges', false, vscode.ConfigurationTarget.Global);
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Packages/manifest.json')));
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls.length, 1);
		} finally {
			handler.dispose();
		}
	});

	test('both settings share a single project debounce', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnProjectEnvironmentChanges', true, vscode.ConfigurationTarget.Global);
		const calls: ReadonlySet<string>[] = [];
		const handler = createRecompileHandler(async (_root, kinds) => { calls.push(kinds); });
		try {
			handler.onFileChange(vscode.Uri.file(csharp));
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Packages/manifest.json')));
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			assert.equal(calls.length, 1);
			assert.deepEqual([...calls[0]].sort(), ['packages', 'source']);
		} finally {
			handler.dispose();
		}
	});

	test('runs a VS Code Unity task from the project root after a C# save', async () => {
		await config.update('recompileOnSave', false, vscode.ConfigurationTarget.Global);
		const bin = path.join(root, 'bin');
		mkdirSync(bin);
		const executable = path.join(bin, process.platform === 'win32' ? 'unity.exe' : 'unity');
		const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
		const node = execFileSync(lookup, ['node'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
		assert.ok(node);
		copyFileSync(node, executable);
		chmodSync(executable, 0o755);
		writeFileSync(path.join(project, 'command'), 'require("node:fs").writeFileSync("status-probed.txt","yes");console.log(JSON.stringify({data:{result:{status:require("node:fs").existsSync("editor-idle.flag")?"completed":"compiling"}}}))');
		writeFileSync(path.join(project, 'recompile'), 'require("node:fs").writeFileSync("recompile-called.txt", JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))');
		const originalPath = process.env.PATH ?? '';
		process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('quietPeriodSeconds', 1, vscode.ConfigurationTarget.Global);
		try {
			const extension = vscode.extensions.getExtension('kadiace.unity-compile-on-save');
			assert.ok(extension);
			await extension.activate();
			rmSync(path.join(project, 'status-probed.txt'), { force: true });
			rmSync(path.join(project, 'editor-idle.flag'), { force: true });
			const completed = nextCompletedRecompile();
			const marker = path.join(project, 'recompile-called.txt');
			const observed = new Promise<void>((resolve, reject) => {
				const observer = watch(project, (_, filename) => {
					if (filename === 'recompile-called.txt') {
						clearTimeout(timeout);
						observer.close();
						resolve();
					}
				});
				const timeout = setTimeout(() => {
					observer.close();
					reject(new Error('Unity CLI was not invoked after the save'));
				}, 5000);
			});
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(csharp));
			const edit = new vscode.WorkspaceEdit();
			edit.insert(document.uri, new vscode.Position(0, 0), '// actual VS Code save\n');
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(await document.save(), true);
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			writeFileSync(path.join(scripts, 'Background.png'), 'unrelated asset');
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			assert.equal(existsSync(path.join(project, 'status-probed.txt')), false);
			assert.equal(existsSync(marker), false);
			writeFileSync(path.join(project, 'editor-idle.flag'), 'ready');
			await observed;
			await completed;
			const result: unknown = JSON.parse(readFileSync(marker, 'utf8'));
			assert.ok(result && typeof result === 'object' && 'cwd' in result && 'args' in result);
			assert.ok(typeof result.cwd === 'string');
			assert.equal(result.cwd.toLowerCase(), project.toLowerCase());
			assert.ok(Array.isArray(result.args));
			assert.deepEqual(result.args.map((value: unknown) =>
				typeof value === 'string' ? value.toLowerCase() : value), ['--project-path', project.toLowerCase()]);
		} finally {
			process.env.PATH = originalPath;
		}
	});

	test('resolves packages and refreshes once before recompiling mixed changes', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('quietPeriodSeconds', 0.2, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnProjectEnvironmentChanges', true, vscode.ConfigurationTarget.Global);
		const bin = path.join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		const executable = path.join(bin, process.platform === 'win32' ? 'unity.exe' : 'unity');
		const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
		const node = execFileSync(lookup, ['node'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
		assert.ok(node);
		copyFileSync(node, executable);
		chmodSync(executable, 0o755);
		const command = path.join(project, 'command');
		const recompile = path.join(project, 'recompile');
		const manifest = path.join(project, 'Packages', 'manifest.json');
		mkdirSync(path.dirname(manifest), { recursive: true });
		writeFileSync(command, 'const fs=require("node:fs");const args=process.argv.slice(2);const name=args.find(x=>["package_resolve","package_status","recompile_status","menu"].includes(x));fs.appendFileSync("cli-calls.log",name+"\\n");if(name==="package_resolve")fs.writeFileSync("Packages/packages-lock.json","{}");if(name==="package_status"||name==="recompile_status")console.log(JSON.stringify({data:{result:{status:"completed"}}}));');
		writeFileSync(recompile, 'require("node:fs").appendFileSync("cli-calls.log","recompile\\n")');
		const originalPath = process.env.PATH ?? '';
		process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
		try {
			const extension = vscode.extensions.getExtension('kadiace.unity-compile-on-save');
			assert.ok(extension);
			await extension.activate();
			const completed = nextCompletedRecompile();
			const observed = new Promise<void>((resolve, reject) => {
				const observer = watch(project, (_, filename) => {
					if (filename === 'cli-calls.log' && readFileSync(path.join(project, filename), 'utf8').split('\n').includes('recompile')) {
						clearTimeout(timeout);
						observer.close();
						resolve();
					}
				});
				const timeout = setTimeout(() => {
					observer.close();
					reject(new Error('Unity CLI did not finish the combined change'));
				}, 8000);
			});
			writeFileSync(csharp, 'class Example { int sourceChanged; }');
			writeFileSync(manifest, '{"dependencies":{}}');
			await observed;
			await completed;
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			assert.deepEqual(readFileSync(path.join(project, 'cli-calls.log'), 'utf8').trim().split('\n'),
				['recompile_status', 'package_resolve', 'package_status', 'menu', 'recompile_status', 'recompile', 'recompile_status']);
		} finally {
			process.env.PATH = originalPath;
		}
	});
});
