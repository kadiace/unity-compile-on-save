import * as assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { CompilerDiagnostics } from '../compilerDiagnostics';

suite('Unity compiler Problems', () => {
	const root = path.resolve(__dirname, '../../src/test/fixtures/UnityProject');
	let diagnostics: CompilerDiagnostics;
	setup(() => { diagnostics = new CompilerDiagnostics(); });
	teardown(() => { diagnostics.dispose(); });

	test('resolves absolute paths with spaces and defaults a missing column when compiler text is parsed', () => {
		const file = path.join(root, 'Assets', 'Folder With Spaces', 'Test.cs');
		diagnostics.parse(root, `\x1b[31m${file}(8): error CS0246: type not found\x1b[0m`);
		const entries = diagnostics.collection.get(vscode.Uri.file(file));
		assert.equal(entries?.length, 1);
		assert.equal(entries?.[0].range.start.line, 7);
		assert.equal(entries?.[0].range.start.character, 0);
		assert.equal(entries?.[0].message, 'type not found');
	});

	test('parses escaped compiler messages when Unity returns JSON', () => {
		diagnostics.parseJson(root, JSON.stringify({ errors: ['Assets/Test.cs(4,2): error CS1002: ; expected\nAssets/Test.cs(5,1): warning CS0168: unused'] }));
		const entries = diagnostics.collection.get(vscode.Uri.file(path.join(root, 'Assets/Test.cs')));
		assert.equal(entries?.length, 2);
		assert.equal(entries?.[0].range.start.line, 3);
	});

	test('parses a quoted compiler path without treating JSON properties as paths', () => {
		const file = path.join(root, 'Assets', 'Folder With Spaces', 'Test.cs');
		diagnostics.parse(root, `"${file}"(8,1): error CS1002: ; expected`);
		diagnostics.parse(root, '  "message": "Assets/Fake.cs(1,1): error CS1002: not a path",');
		assert.equal(diagnostics.collection.get(vscode.Uri.file(file))?.length, 1);
		assert.equal(diagnostics.collection.get(vscode.Uri.file(path.join(root, 'Assets/Fake.cs')))?.length ?? 0, 0);
	});

	test('preserves another project and deduplicates diagnostics when a project is cleared', () => {
		const other = path.join(root, 'NestedUnity');
		const message = 'Assets/Test.cs(4,2): error CS1002: ; expected';
		diagnostics.parse(root, message);
		diagnostics.parse(other, message);
		diagnostics.parse(other, message);
		diagnostics.clear(root);
		assert.equal(diagnostics.collection.get(vscode.Uri.file(path.join(root, 'Assets/Test.cs')))?.length ?? 0, 0);
		assert.equal(diagnostics.collection.get(vscode.Uri.file(path.join(other, 'Assets/Test.cs')))?.length, 1);
	});
});
