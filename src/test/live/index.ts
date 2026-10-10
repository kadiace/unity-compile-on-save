import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const exec = promisify(execFile);

function nextRecompile(): { readonly completed: Promise<void>; readonly dispose: () => void } {
	let timer: NodeJS.Timeout;
	let subscription: vscode.Disposable;
	const completed = new Promise<void>((resolve, reject) => {
		subscription = vscode.tasks.onDidEndTaskProcess((event) => {
			if (event.execution.task.definition.type === 'unityCompileOnSave' && event.execution.task.definition.operation === 'recompile') {
				clearTimeout(timer);
				subscription.dispose();
				if (event.exitCode === 0) { resolve(); } else { reject(new Error(`Live Unity task failed: ${event.exitCode}`)); }
			}
		});
		timer = setTimeout(() => { subscription.dispose(); reject(new Error('Saved C# did not complete a Unity recompile task')); }, 360_000);
	});
	return { completed, dispose: () => { clearTimeout(timer); subscription.dispose(); } };
}

export async function run(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(folder);
	assert.equal(vscode.workspace.isTrusted, true);
	const extension = vscode.extensions.getExtension('kadiace.unity-compile-on-save');
	assert.ok(extension);
	await vscode.tasks.fetchTasks({ type: 'unityCompileOnSave' });
	assert.equal(extension.isActive, true, 'Unity-root opening should activate the extension automatically');
	const tasks = await vscode.tasks.fetchTasks({ type: 'unityCompileOnSave' });
	assert.equal(tasks.length, 2);
	console.log('LIVE_QA: Unity-root activation and setup/recompile task discovery succeeded');
	const name = `UnityCompileOnSaveQa_${randomUUID().replaceAll('-', '')}`;
	const file = vscode.Uri.joinPath(folder.uri, 'Assets', 'Editor', `${name}.cs`);
	const source = (value: number): string => `public static class ${name} { public const int Value = ${value}; }\n`;
	const first = nextRecompile();
	try {
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, 'Assets', 'Editor'));
		await vscode.workspace.fs.writeFile(file, Buffer.from(source(123)));
		await first.completed;
		console.log('LIVE_QA: Automatic Pipeline setup and external source change compiled successfully');
		const saved = nextRecompile();
		try {
			const document = await vscode.workspace.openTextDocument(file);
			await vscode.window.showTextDocument(document);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(file, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source(456));
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(await document.save(), true);
			await saved.completed;
		} finally { saved.dispose(); }
		const { stdout } = await exec('unity', ['command', '--project-path', folder.uri.fsPath, 'eval', '--code',
			`foreach (var assembly in System.AppDomain.CurrentDomain.GetAssemblies()) { var type = assembly.GetType("${name}"); if (type != null) return type.GetField("Value").GetRawConstantValue(); } return "type not loaded";`,
			'--result-only'], { windowsHide: true, timeout: 60_000 }).catch((error: unknown) => {
			if (error instanceof Error && 'stdout' in error) { console.error(error.stdout); }
			throw error;
		});
		assert.match(stdout, /\b456\b/);
		console.log(`LIVE_QA: Actual VS Code edit/save completed its task and connected Editor executed updated C# value: ${stdout.trim()}`);
	} finally {
		first.dispose();
		await vscode.workspace.fs.delete(file);
	}
}
