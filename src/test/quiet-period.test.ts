import * as assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { createRecompileHandler } from '../extension';

suite('Quiet period', () => {
	const project = path.resolve(__dirname, '../../src/test/fixtures/UnityProject');
	const uri = vscode.Uri.file(path.join(project, 'Assets', 'Example.cs'));
	const config = vscode.workspace.getConfiguration('unityCompileOnSave');
	const previous = new Map([
		'recompileOnSave', 'recompileOnSourceChanges', 'quietPeriodSeconds'
	].map((key) => [key, config.inspect<boolean | number>(key)?.globalValue]));

	suiteTeardown(async () => {
		for (const [key, value] of previous) {
			await config.update(key, value, vscode.ConfigurationTarget.Global);
		}
	});

	test('coalesces changes spaced farther apart than 200 ms until a full quiet period passes', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('quietPeriodSeconds', 1, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createRecompileHandler(async (projectRoot) => { calls.push(projectRoot); });
		try {
			for (let index = 0; index < 4; index++) {
				handler.onFileChange(uri);
				await new Promise<void>((resolve) => setTimeout(resolve, 230));
			}
			assert.equal(calls.length, 0);
			await new Promise<void>((resolve) => setTimeout(resolve, 1200));
			assert.deepEqual(calls.map((value) => value.toLowerCase()), [project.toLowerCase()]);
		} finally {
			handler.dispose();
		}
	});

	test('unrelated project file changes extend an existing quiet period without requesting a compile', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('quietPeriodSeconds', 0.2, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createRecompileHandler(async (projectRoot) => { calls.push(projectRoot); });
		try {
			const image = vscode.Uri.file(path.join(project, 'Assets', 'Textures', 'Icon.png'));
			handler.onFileChange(image);
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			assert.equal(calls.length, 0);
			handler.onFileChange(uri);
			await new Promise<void>((resolve) => setTimeout(resolve, 130));
			handler.onFileChange(image);
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			assert.equal(calls.length, 0);
			await new Promise<void>((resolve) => setTimeout(resolve, 200));
			assert.deepEqual(calls.map((value) => value.toLowerCase()), [project.toLowerCase()]);
		} finally {
			handler.dispose();
		}
	});

	test('package and project settings files also extend the wait, but Library files do not', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('quietPeriodSeconds', 0.4, vscode.ConfigurationTarget.Global);
		const calls: string[] = [];
		const handler = createRecompileHandler(async (projectRoot) => { calls.push(projectRoot); });
		try {
			for (const file of ['Packages/notes.txt', 'ProjectSettings/EditorSettings.asset']) {
				handler.onFileChange(uri);
				await new Promise<void>((resolve) => setTimeout(resolve, 240));
				handler.onFileChange(vscode.Uri.file(path.join(project, file)));
				await new Promise<void>((resolve) => setTimeout(resolve, 230));
				assert.equal(calls.length, file.startsWith('Packages') ? 0 : 1);
				await new Promise<void>((resolve) => setTimeout(resolve, 230));
			}
			assert.equal(calls.length, 2);
			handler.onFileChange(uri);
			await new Promise<void>((resolve) => setTimeout(resolve, 240));
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Library', 'cache.bin')));
			await new Promise<void>((resolve) => setTimeout(resolve, 230));
			assert.equal(calls.length, 3);
		} finally {
			handler.dispose();
		}
	});

	test('collects changes while the Editor is compiling and runs once after it becomes idle', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('quietPeriodSeconds', 0.2, vscode.ConfigurationTarget.Global);
		let releaseEditor: (() => void) | undefined;
		const editorIdle = new Promise<void>((resolve) => { releaseEditor = resolve; });
		let completed: (() => void) | undefined;
		const ran = new Promise<void>((resolve) => { completed = resolve; });
		const calls: string[] = [];
		let waits = 0;
		const handler = createRecompileHandler(async (projectRoot) => {
			calls.push(projectRoot);
			completed?.();
		}, async () => {
			waits++;
			await editorIdle;
		});
		try {
			for (let index = 0; index < 4; index++) {
				handler.onFileChange(uri);
				await new Promise<void>((resolve) => setTimeout(resolve, 230));
			}
			assert.equal(calls.length, 0);
			assert.equal(waits, 1);
			assert.ok(releaseEditor);
			releaseEditor();
			await ran;
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.deepEqual(calls.map((value) => value.toLowerCase()), [project.toLowerCase()]);
		} finally {
			handler.dispose();
		}
	});

	test('runs only one follow-up after changes arrive during its own recompile', async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('quietPeriodSeconds', 0.2, vscode.ConfigurationTarget.Global);
		let releaseFirst: (() => void) | undefined;
		const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let firstStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => { firstStarted = resolve; });
		let secondStarted: (() => void) | undefined;
		const followUp = new Promise<void>((resolve) => { secondStarted = resolve; });
		let calls = 0;
		const handler = createRecompileHandler(async () => {
			calls++;
			if (calls === 1) {
				firstStarted?.();
				await firstFinished;
			} else {
				secondStarted?.();
			}
		});
		try {
			handler.onFileChange(uri);
			await started;
			for (let index = 0; index < 4; index++) {
				handler.onFileChange(uri);
				await new Promise<void>((resolve) => setTimeout(resolve, 230));
			}
			assert.equal(calls, 1);
			assert.ok(releaseFirst);
			releaseFirst();
			await followUp;
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			assert.equal(calls, 2);
		} finally {
			handler.dispose();
		}
	});
});
