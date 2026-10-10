import * as assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStatusBar, parseConnection } from '../connectionStatus';
import type { Connection } from '../connectionStatus';

suite('Unity Pipeline connection', () => {
	const project = path.resolve(__dirname, '../../src/test/fixtures/UnityProject');
	const response = (status: string, projectPath = project): string => JSON.stringify({
		success: true, data: { target: { projectPath }, result: { status } }
	});

	for (const status of ['idle', 'completed', 'up_to_date']) {
		test(`reports readiness when this project's Pipeline returns ${status}`, () => {
			assert.equal(parseConnection(response(status), project), 'connected');
		});
	}
	test('reports busy when this project is still compiling', () => {
		assert.equal(parseConnection(response('compiling'), project), 'busy');
	});
	test('reports busy when a recompile request has just been triggered', () => {
		assert.equal(parseConnection(response('triggered'), project), 'busy');
	});
	test('does not accept a connected Editor for another project', () => {
		assert.throws(() => parseConnection(response('idle', path.join(project, 'other')), project), /this Unity project/);
	});
	test('does not infer readiness from an installed Pipeline or running process', () => {
		assert.throws(() => parseConnection(JSON.stringify({ data: { instances: [{ projectPath: project, isRunning: true, pid: 1 }] } }), project));
	});
	test('does not accept unsuccessful or unknown command responses', () => {
		assert.throws(() => parseConnection(JSON.stringify({ success: false, data: null }), project));
		assert.throws(() => parseConnection(response('unsupported'), project));
	});
	test('ignores an old probe result after a newer check has completed', async () => {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project));
		assert.ok(folder);
		const config = vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri);
		await config.update('showConnectionStatus', true, vscode.ConfigurationTarget.WorkspaceFolder);
		const pending: ((value: Connection) => void)[] = [];
		const item = vscode.window.createStatusBarItem();
		const status = new ConnectionStatusBar(() => new Promise((resolve) => { pending.push(resolve); }), () => [folder], item);
		try {
			const old = pending[0];
			assert.ok(old);
			status.refresh();
			const current = pending[1];
			assert.ok(current);
			current('busy');
			await Promise.resolve();
			old('connected');
			await Promise.resolve();
			assert.match(item.text, /Busy/);
			assert.equal(typeof item.command, 'object');
			if (typeof item.command === 'object') { assert.deepEqual(item.command.arguments, [folder.uri]); }
		} finally {
			status.dispose();
			await config.update('showConnectionStatus', false, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});
	test('displays and reconnects the most specific Unity root in a nested workspace', async () => {
		const outer = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project));
		assert.ok(outer);
		const uri = vscode.Uri.file(path.join(project, 'NestedUnity'));
		const inner = vscode.workspace.getWorkspaceFolder(uri);
		assert.ok(inner);
		assert.equal(inner.uri.toString(), uri.toString());
		const config = vscode.workspace.getConfiguration('unityCompileOnSave', uri);
		await config.update('showConnectionStatus', true, vscode.ConfigurationTarget.WorkspaceFolder);
		const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(uri, 'Fixture.txt'));
		await vscode.window.showTextDocument(document);
		const item = vscode.window.createStatusBarItem();
		const status = new ConnectionStatusBar(async () => 'connected', () => [outer, inner], item);
		try {
			await Promise.resolve();
			assert.match(item.text, /Connected \(NestedUnity\)/);
			assert.equal(typeof item.command, 'object');
			if (typeof item.command === 'object') { assert.deepEqual(item.command.arguments, [inner.uri]); }
		} finally {
			status.dispose();
			await config.update('showConnectionStatus', false, vscode.ConfigurationTarget.WorkspaceFolder);
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});
});
