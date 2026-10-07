import * as assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createRecompileHandler } from '../extension';

suite('Recompile options', () => {
	const project = path.resolve(__dirname, '../../src/test/fixtures/UnityProject');
	const dll = path.join(project, 'Assets', 'Plugins', 'Managed.dll');
	const config = vscode.workspace.getConfiguration('unityCompileOnSave');
	const previous = new Map([
		'compileUnityOnSave', 'recompileOnSave', 'recompileOnSourceChanges', 'recompileOnProjectEnvironmentChanges', 'quietPeriodSeconds'
	].map((key) => [key, config.inspect<boolean | number>(key)?.globalValue]));

	suiteSetup(async () => {
		await config.update('quietPeriodSeconds', 0.2, vscode.ConfigurationTarget.Global);
	});
	suiteTeardown(async () => {
		for (const [key, value] of previous) {
			await config.update(key, value, vscode.ConfigurationTarget.Global);
		}
		rmSync(dll, { force: true });
		rmSync(`${dll}.meta`, { force: true });
	});

	test('legacy master disables both options until the new master is explicitly set', async () => {
		await config.update('compileUnityOnSave', false, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSave', undefined, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnProjectEnvironmentChanges', true, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createRecompileHandler(async (root) => { calls.push(root); });
		try {
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Assets', 'Example.cs')));
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Packages', 'manifest.json')));
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls.length, 0);
		} finally {
			handler.dispose();
		}
	});

	test('new master disables source and environment triggers together', async () => {
		await config.update('compileUnityOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSave', false, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnProjectEnvironmentChanges', true, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createRecompileHandler(async (root) => { calls.push(root); });
		try {
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Assets', 'Example.cs')));
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Packages', 'manifest.json')));
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls.length, 0);
		} finally {
			handler.dispose();
		}
	});

	test('native DLLs are ignored but managed DLLs and their metadata trigger recompilation', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		mkdirSync(path.dirname(dll), { recursive: true });
		writeFileSync(dll, 'not a managed assembly');
		const calls: string[] = [];
		const handler = createRecompileHandler(async (root) => { calls.push(root); });
		try {
			handler.onFileChange(vscode.Uri.file(dll));
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls.length, 0);
			const bytes = Buffer.alloc(0x200);
			bytes.write('MZ', 0);
			bytes.writeUInt32LE(0x80, 0x3c);
			bytes.write('PE\0\0', 0x80);
			bytes.writeUInt16LE(0x10b, 0x98);
			bytes.writeUInt32LE(0x2000, 0x98 + 96 + 14 * 8);
			writeFileSync(dll, bytes);
			handler.onFileChange(vscode.Uri.file(dll));
			handler.onFileChange(vscode.Uri.file(`${dll}.meta`));
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			assert.equal(calls.length, 1);
			rmSync(dll);
			handler.onFileChange(vscode.Uri.file(dll));
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			assert.equal(calls.length, 2);
		} finally {
			handler.dispose();
		}
	});
});
