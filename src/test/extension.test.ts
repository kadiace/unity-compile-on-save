import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { createSaveHandler, findUnityProjectRoot } from '../extension';

suite('Unity Compile on Save', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'unity-compile-on-save-'));
	const project = path.resolve(__dirname, '../../src/test/fixtures/UnityProject');
	const scripts = path.join(project, 'Assets', 'Scripts');
	const csharp = path.join(scripts, 'Example.cs');
	const other = path.join(scripts, 'Example.txt');
	const outsideProject = path.join(root, 'OutsideUnityProject');
	const outside = path.join(outsideProject, 'Assets', 'Outside.cs');
	const config = vscode.workspace.getConfiguration('unityCompileOnSave');
	const previous = config.inspect<boolean>('compileUnityOnSave')?.globalValue;

	suiteSetup(() => {
		mkdirSync(scripts, { recursive: true });
		mkdirSync(path.join(outsideProject, 'ProjectSettings'), { recursive: true });
		mkdirSync(path.dirname(outside), { recursive: true });
		writeFileSync(path.join(outsideProject, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 1');
		writeFileSync(csharp, 'class Example {}');
		writeFileSync(other, 'not C#');
		writeFileSync(outside, 'class Outside {}');
	});

	suiteTeardown(async () => {
		await config.update('compileUnityOnSave', previous, vscode.ConfigurationTarget.Global);
		rmSync(path.join(project, 'Assets'), { recursive: true, force: true });
		rmSync(path.join(project, 'recompile'), { force: true });
		rmSync(path.join(project, 'recompile-called.txt'), { force: true });
		rmSync(root, { recursive: true, force: true });
	});

	test('defaults to enabled when no user setting exists', async () => {
		await config.update('compileUnityOnSave', undefined, vscode.ConfigurationTarget.Global);
		assert.equal(config.get<boolean>('compileUnityOnSave'), true);
	});

	test('finds a Unity project only when ProjectVersion.txt exists in an ancestor', () => {
		assert.equal(findUnityProjectRoot(csharp), project);
		assert.equal(findUnityProjectRoot(outside), outsideProject);
		assert.equal(findUnityProjectRoot(path.join(root, 'NotUnity.cs')), undefined);
	});

	test('does not schedule disabled, non-C# or Unity files outside the opened project', async () => {
		await config.update('compileUnityOnSave', false, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createSaveHandler((projectRoot) => calls.push(projectRoot));
		const listener = vscode.workspace.onDidSaveTextDocument(handler.onSave);
		try {
			const csDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(csharp));
			const edit = new vscode.WorkspaceEdit();
			edit.insert(csDocument.uri, new vscode.Position(0, 0), '// saved\n');
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(await csDocument.save(), true);
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls.length, 0);
			await config.update('compileUnityOnSave', true, vscode.ConfigurationTarget.Global);
			handler.onSave(await vscode.workspace.openTextDocument(vscode.Uri.file(other)));
			handler.onSave(await vscode.workspace.openTextDocument(vscode.Uri.file(outside)));
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls.length, 0);
		} finally {
			listener.dispose();
			handler.dispose();
		}
	});

	test('debounces consecutive C# saves in one Unity project', async () => {
		await config.update('compileUnityOnSave', true, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createSaveHandler((projectRoot) => calls.push(projectRoot));
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(csharp));
			handler.onSave(document);
			handler.onSave(document);
			assert.equal(calls.length, 0);
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			assert.deepEqual(calls.map((value) => value.toLowerCase()), [project.toLowerCase()]);
		} finally {
			handler.dispose();
		}
	});

	test('runs unity recompile from the project root after an enabled C# save', async () => {
		const bin = path.join(root, 'bin');
		mkdirSync(bin);
		const executable = path.join(bin, process.platform === 'win32' ? 'unity.exe' : 'unity');
		const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
		const node = execFileSync(lookup, ['node'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
		assert.ok(node);
		copyFileSync(node, executable);
		chmodSync(executable, 0o755);
		writeFileSync(path.join(project, 'recompile'), 'require("node:fs").writeFileSync("recompile-called.txt", JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))');
		const originalPath = process.env.PATH ?? '';
		process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
		await config.update('compileUnityOnSave', true, vscode.ConfigurationTarget.Global);
		try {
			const extension = vscode.extensions.all.find((item) => item.packageJSON.name === 'unity-compile-on-save');
			assert.ok(extension);
			await extension.activate();

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
			edit.insert(document.uri, new vscode.Position(0, 0), '// enabled save\n');
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(await document.save(), true);
			await observed;
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
});
