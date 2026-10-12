import * as assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { CompilerDiagnostics } from '../compilerDiagnostics';
import { createRecompileHandler } from '../extension';
import type { Change } from '../extension';

suite('Pre-compilation validation', () => {
	const project = path.resolve(__dirname, '../../src/test/fixtures/UnityProject');
	const uri = vscode.Uri.file(path.join(project, 'Assets', 'Validation.cs'));
	const config = vscode.workspace.getConfiguration('unityCompileOnSave');
	const keys = ['recompileOnSave', 'recompileOnSourceChanges', 'recompileOnProjectEnvironmentChanges', 'quietPeriodSeconds'];
	const previous = new Map(keys.map((key) => [key, config.inspect<boolean | number>(key)?.globalValue]));
	const diagnostics = vscode.languages.createDiagnosticCollection('validation-language-server');
	const error = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'Invalid C#', vscode.DiagnosticSeverity.Error);
	error.source = 'csharp';
	error.code = 'CS1002';

	suiteSetup(async () => {
		await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnSourceChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('recompileOnProjectEnvironmentChanges', true, vscode.ConfigurationTarget.Global);
		await config.update('quietPeriodSeconds', 0.2, vscode.ConfigurationTarget.Global);
	});
	teardown(() => diagnostics.clear());
	suiteTeardown(async () => {
		diagnostics.dispose();
		for (const [key, value] of previous) { await config.update(key, value, vscode.ConfigurationTarget.Global); }
	});

	test('keeps mixed changes pending without readiness calls until every project C# error clears', async () => {
		// Given
		const second = vscode.Uri.file(path.join(project, 'Packages', 'Tool', 'Other.cs'));
		diagnostics.set(uri, [error]);
		diagnostics.set(second, [error]);
		const calls: ReadonlySet<Change>[] = [];
		let waits = 0;
		const handler = createRecompileHandler(async (_root, kinds) => { calls.push(kinds); }, async () => { waits++; });
		try {
			// When
			handler.onFileChange(uri);
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Packages', 'manifest.json')));
			await delay(350);
			assert.equal(waits, 0);
			assert.equal(calls.length, 0);
			diagnostics.delete(uri);
			await delay(150);
			assert.equal(waits, 0);
			diagnostics.delete(second);
			await delay(150);
			// Then
			assert.equal(waits, 1);
			assert.equal(calls.length, 1);
			assert.deepEqual([...calls[0]].sort(), ['packages', 'source']);
		} finally { handler.dispose(); }
	});

	test('allows warnings, previous Unity compiler errors and errors outside this project C# scope', async () => {
		// Given
		const own = new CompilerDiagnostics();
		own.parse(project, 'Assets/Validation.cs(1,1): error CS1002: ; expected');
		diagnostics.set(uri, [new vscode.Diagnostic(error.range, 'Warning', vscode.DiagnosticSeverity.Warning)]);
		diagnostics.set(vscode.Uri.file(path.join(project, 'Assets', 'data.json')), [error]);
		diagnostics.set(vscode.Uri.file(path.join(project, 'NestedUnity', 'Assets', 'Other.cs')), [error]);
		diagnostics.set(vscode.Uri.file(`${project}-other/Assets/Other.cs`), [error]);
		let calls = 0;
		const handler = createRecompileHandler(async () => { calls++; });
		try {
			// When
			handler.onFileChange(uri);
			await delay(350);
			// Then
			assert.equal(calls, 1);
			assert.equal(own.collection.get(uri)?.length, 1);
		} finally { handler.dispose(); own.dispose(); }
	});

	test('rechecks errors that arrive during Editor readiness before requesting recompilation', async () => {
		// Given
		let release: (() => void) | undefined;
		const idle = new Promise<void>((resolve) => { release = resolve; });
		let started: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => { started = resolve; });
		let calls = 0;
		const handler = createRecompileHandler(async () => { calls++; }, async () => { started?.(); await idle; });
		try {
			handler.onFileChange(uri);
			await waiting;
			// When
			diagnostics.set(uri, [error]);
			release?.();
			await delay(150);
			// Then
			assert.equal(calls, 0);
			diagnostics.clear();
			await delay(150);
			assert.equal(calls, 1);
		} finally { release?.(); handler.dispose(); }
	});

	test('does not bypass a new file quiet period when diagnostics clear', async () => {
		// Given
		diagnostics.set(uri, [error]);
		let calls = 0;
		const handler = createRecompileHandler(async () => { calls++; });
		try {
			handler.onFileChange(uri);
			await delay(350);
			// When
			handler.onFileChange(vscode.Uri.file(path.join(project, 'Assets', 'Texture.png')));
			diagnostics.clear();
			await delay(100);
			// Then
			assert.equal(calls, 0);
			await delay(250);
			assert.equal(calls, 1);
		} finally { handler.dispose(); }
	});

	for (const action of ['forget', 'dispose', 'disable'] as const) {
		test(`does not resume retained work after ${action}`, async () => {
			// Given
			diagnostics.set(uri, [error]);
			let calls = 0;
			let waits = 0;
			const handler = createRecompileHandler(async () => { calls++; }, async () => { waits++; });
			try {
				handler.onFileChange(uri);
				await delay(350);
				// When
				switch (action) {
					case 'forget': handler.forget(project); break;
					case 'dispose': handler.dispose(); break;
					case 'disable': await config.update('recompileOnSave', false, vscode.ConfigurationTarget.Global); break;
				}
				diagnostics.clear();
				await delay(150);
				// Then
				assert.equal(calls, 0);
				assert.equal(waits, 0);
			} finally {
				handler.dispose();
				await config.update('recompileOnSave', true, vscode.ConfigurationTarget.Global);
			}
		});
	}
});
