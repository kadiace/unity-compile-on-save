import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { UnityTaskRunner } from './unityTasks';

export type Change = 'source' | 'environment' | 'packages';
type Pending = { uri: vscode.Uri; kinds: Set<Change>; timer?: NodeJS.Timeout };

export function findUnityProjectRoot(filePath: string): string | undefined {
	let directory = path.dirname(filePath);
	while (true) {
		if (existsSync(path.join(directory, 'ProjectSettings', 'ProjectVersion.txt'))) {
			return directory;
		}
		const parent = path.dirname(directory);
		if (parent === directory) {
			return undefined;
		}
		directory = parent;
	}
}

function enabled(config: vscode.WorkspaceConfiguration): boolean {
	const setting = config.inspect<boolean>('recompileOnSave');
	if (setting?.globalValue !== undefined || setting?.workspaceValue !== undefined || setting?.workspaceFolderValue !== undefined) {
		return config.get<boolean>('recompileOnSave', true);
	}
	const legacy = config.inspect<boolean>('compileUnityOnSave');
	if (legacy?.globalValue !== undefined || legacy?.workspaceValue !== undefined || legacy?.workspaceFolderValue !== undefined) {
		return config.get<boolean>('compileUnityOnSave', true);
	}
	return config.get<boolean>('recompileOnSave', true);
}

function isManagedDll(filePath: string): boolean {
	if (!existsSync(filePath)) {
		return true;
	}
	let file: number;
	try {
		file = openSync(filePath, 'r');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return true;
		}
		throw error;
	}
	try {
		const dos = Buffer.alloc(0x40);
		if (readSync(file, dos, 0, dos.length, 0) < dos.length || dos.toString('ascii', 0, 2) !== 'MZ') {
			return false;
		}
		const pe = Buffer.alloc(24 + 240);
		const count = readSync(file, pe, 0, pe.length, dos.readUInt32LE(0x3c));
		if (count < 26 || pe.toString('ascii', 0, 4) !== 'PE\0\0') {
			return false;
		}
		const magic = pe.readUInt16LE(24);
		if (magic !== 0x10b && magic !== 0x20b) {
			return false;
		}
		const clrDirectory = 24 + (magic === 0x20b ? 112 : 96) + 14 * 8;
		return clrDirectory + 4 <= count && pe.readUInt32LE(clrDirectory) !== 0;
	} finally {
		closeSync(file);
	}
}

function classify(filePath: string, projectRoot: string): Change | undefined {
	const relative = path.relative(projectRoot, filePath).replaceAll('\\', '/').toLowerCase();
	if (relative === 'packages/manifest.json' || relative === 'packages/packages-lock.json' ||
		/^packages\/[^/]+\/package\.json$/.test(relative)) {
		return 'packages';
	}
	if (relative === 'projectsettings/projectsettings.asset' ||
		/^assets\/(?:.*\/)?build profiles\/.*\.asset$/.test(relative)) {
		return 'environment';
	}
	if (relative.startsWith('assets/') || relative.startsWith('packages/')) {
		if (relative.endsWith('.dll') || relative.endsWith('.dll.meta')) {
			return isManagedDll(filePath.replace(/\.meta$/i, '')) ? 'source' : undefined;
		}
		if (/\.(cs|asmdef|asmref)$/.test(relative) || relative === 'assets/csc.rsp') {
			return 'source';
		}
	}
	return undefined;
}

export function createRecompileHandler(
	run: (projectRoot: string, kinds: ReadonlySet<Change>) => Promise<void>,
	waitUntilEditorIdle: (projectRoot: string) => Promise<void> = async () => {}
): {
	onSave: (document: vscode.TextDocument) => void;
	onFileChange: (uri: vscode.Uri) => void;
	forget: (projectRoot: string) => void;
	dispose: () => void;
} {
	const pending = new Map<string, Pending>();
	const running = new Map<string, ReadonlySet<Change>>();
	const waiting = new Map<string, Pending>();
	const resolvedLocks = new Map<string, string>();
	const lockFingerprint = (projectRoot: string): string | undefined => {
		const lockFile = path.join(projectRoot, 'Packages', 'packages-lock.json');
		return existsSync(lockFile) ? createHash('sha256').update(readFileSync(lockFile)).digest('hex') : undefined;
	};

	const flush = (projectRoot: string): void => {
		const item = pending.get(projectRoot);
		if (!item || running.has(projectRoot)) {
			return;
		}
		pending.delete(projectRoot);
		const config = vscode.workspace.getConfiguration('unityCompileOnSave', item.uri);
		if (!enabled(config)) {
			return;
		}
		const kinds = new Set([...item.kinds].filter((kind) => config.get<boolean>(
			kind === 'source' ? 'recompileOnSourceChanges' : 'recompileOnProjectEnvironmentChanges', kind === 'source'
		)));
		if (kinds.size === 0) {
			return;
		}
		running.set(projectRoot, kinds);
		void run(projectRoot, kinds).catch((error: unknown) => {
			void vscode.window.showErrorMessage(`Unity recompilation failed: ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => {
			if (kinds.has('packages')) {
				const fingerprint = lockFingerprint(projectRoot);
				if (fingerprint) {
					resolvedLocks.set(projectRoot, fingerprint);
				}
			}
			running.delete(projectRoot);
			prepare(projectRoot);
		});
	};

	const prepare = (projectRoot: string): void => {
		const item = pending.get(projectRoot);
		if (!item || item.timer || waiting.has(projectRoot) || running.has(projectRoot)) {
			return;
		}
		waiting.set(projectRoot, item);
		void waitUntilEditorIdle(projectRoot).then(() => {
			if (waiting.get(projectRoot) !== item) { return; }
			waiting.delete(projectRoot);
			if (pending.get(projectRoot)?.timer === undefined) {
				flush(projectRoot);
			}
		}).catch((error: unknown) => {
			if (waiting.get(projectRoot) !== item) { return; }
			waiting.delete(projectRoot);
			pending.delete(projectRoot);
			waiting.delete(projectRoot);
			void vscode.window.showErrorMessage(`Unity recompilation failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	};

	const schedule = (uri: vscode.Uri): void => {
		if (uri.scheme !== 'file' || !vscode.workspace.isTrusted) {
			return;
		}
		const projectRoot = findUnityProjectRoot(uri.fsPath);
		if (!projectRoot || !vscode.workspace.workspaceFolders?.some((folder) =>
			folder.uri.scheme === 'file' && path.relative(folder.uri.fsPath, projectRoot) === '')) {
			return;
		}
		const relative = path.relative(projectRoot, uri.fsPath).replaceAll('\\', '/').toLowerCase();
		if (!relative.startsWith('assets/') && !relative.startsWith('packages/') &&
			!relative.startsWith('projectsettings/')) {
			return;
		}
		const config = vscode.workspace.getConfiguration('unityCompileOnSave', uri);
		if (!enabled(config)) {
			return;
		}
		const kind = classify(uri.fsPath, projectRoot);
		let requested = kind !== undefined && config.get<boolean>(
			kind === 'source' ? 'recompileOnSourceChanges' : 'recompileOnProjectEnvironmentChanges', kind === 'source'
		);
		if (requested && relative === 'packages/packages-lock.json') {
			const fingerprint = lockFingerprint(projectRoot);
			if (running.get(projectRoot)?.has('packages') || (fingerprint && fingerprint === resolvedLocks.get(projectRoot))) {
				requested = false;
			}
		}
		const item = pending.get(projectRoot) ?? (requested ? { uri, kinds: new Set<Change>() } : undefined);
		if (!item) {
			return;
		}
		item.uri = uri;
		if (requested && kind) {
			item.kinds.add(kind);
		}
		if (item.timer) {
			clearTimeout(item.timer);
		}
		const quietPeriod = config.get<number>('quietPeriodSeconds', 2);
		item.timer = setTimeout(() => {
			item.timer = undefined;
			prepare(projectRoot);
		}, quietPeriod * 1000);
		pending.set(projectRoot, item);
	};

	return {
		onSave(document) {
			schedule(document.uri);
		},
		onFileChange: schedule,
		forget(projectRoot: string): void {
			const state = pending.get(projectRoot);
			if (state?.timer) { clearTimeout(state.timer); }
			pending.delete(projectRoot);
		},
		dispose() {
			for (const item of pending.values()) {
				if (item.timer) {
					clearTimeout(item.timer);
				}
			}
			pending.clear();
			waiting.clear();
			resolvedLocks.clear();
		}
	};
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Unity Compile on Save');
	const runner = new UnityTaskRunner(context.globalStorageUri.fsPath, output);
	const unityFolders = (): vscode.WorkspaceFolder[] => (vscode.workspace.workspaceFolders ?? []).filter((folder) =>
		folder.uri.scheme === 'file' && existsSync(path.join(folder.uri.fsPath, 'ProjectSettings', 'ProjectVersion.txt')));
	const folderFor = (root: string): vscode.WorkspaceFolder => {
		const folder = unityFolders().find((item) => path.relative(item.uri.fsPath, root) === '');
		if (!folder) {
			throw new Error('The Unity project root is no longer open in this workspace.');
		}
		return folder;
	};
	const handler = createRecompileHandler(
		(root, kinds) => runner.execute(folderFor(root), 'recompile', kinds),
		(root) => runner.waitUntilIdle(folderFor(root))
	);
	const setupFolder = (folder: vscode.WorkspaceFolder): void => {
		const config = vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri);
		if (vscode.workspace.isTrusted && enabled(config) && config.get<boolean>('autoSetup', true)) {
			void runner.execute(folder, 'setup').catch((error: unknown) => {
				void vscode.window.showErrorMessage(`Unity automatic setup failed: ${error instanceof Error ? error.message : String(error)}`, 'Show Output')
					.then((choice) => { if (choice === 'Show Output') { output.show(); } });
			});
		}
	};
	const watchers = new Map<string, vscode.Disposable>();
	const watchFolder = (folder: vscode.WorkspaceFolder): void => {
		if (folder.uri.scheme !== 'file' || !existsSync(path.join(folder.uri.fsPath, 'ProjectSettings', 'ProjectVersion.txt'))) {
			return;
		}
		const subscriptions: vscode.Disposable[] = [];
		for (const directory of ['Assets', 'Packages', 'ProjectSettings']) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(path.join(folder.uri.fsPath, directory)), '**/*')
			);
			subscriptions.push(
				watcher.onDidChange(handler.onFileChange),
				watcher.onDidCreate(handler.onFileChange),
				watcher.onDidDelete(handler.onFileChange),
				watcher
			);
		}
		watchers.set(folder.uri.toString(), new vscode.Disposable(() => {
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
		}));
		setupFolder(folder);
	};
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		watchFolder(folder);
	}
	context.subscriptions.push(
		output,
		runner,
		vscode.tasks.registerTaskProvider('unityCompileOnSave', {
			provideTasks: () => vscode.workspace.isTrusted ? unityFolders().flatMap((folder) =>
				[runner.createTask(folder, 'setup'), runner.createTask(folder, 'recompile')]) : [],
			resolveTask: (task) => {
				const scope = task.scope;
				if (!vscode.workspace.isTrusted || !scope || typeof scope === 'number' ||
					!unityFolders().some((folder) => folder.uri.toString() === scope.uri.toString())) {
					return undefined;
				}
				const operation: unknown = task.definition.operation;
				return operation === 'setup' || operation === 'recompile' ?
					runner.createTask(scope, operation, undefined, task.definition) : undefined;
			}
		}),
		vscode.commands.registerCommand('unityCompileOnSave.setup', async () => {
			for (const folder of unityFolders()) {
				await runner.execute(folder, 'setup');
			}
		}),
		vscode.workspace.onDidGrantWorkspaceTrust(() => { for (const folder of unityFolders()) { setupFolder(folder); } }),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('unityCompileOnSave.recompileOnSave') ||
				event.affectsConfiguration('unityCompileOnSave.compileUnityOnSave') || event.affectsConfiguration('unityCompileOnSave.autoSetup')) {
				for (const folder of unityFolders()) {
					if (!enabled(vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri))) {
						handler.forget(folder.uri.fsPath);
						runner.forget(folder);
					} else { setupFolder(folder); }
				}
			}
		}),
		vscode.workspace.onDidSaveTextDocument(handler.onSave),
		vscode.workspace.onDidChangeWorkspaceFolders((event) => {
			for (const folder of event.removed) {
				handler.forget(folder.uri.fsPath);
				runner.forget(folder);
				watchers.get(folder.uri.toString())?.dispose();
				watchers.delete(folder.uri.toString());
			}
			for (const folder of event.added) {
				watchFolder(folder);
			}
		}),
		new vscode.Disposable(() => {
			for (const watcher of watchers.values()) {
				watcher.dispose();
			}
			watchers.clear();
		}),
		handler
	);
}
