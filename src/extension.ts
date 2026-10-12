import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { OperationError, UnityTaskRunner } from './unityTasks';
import type { OperationResult } from './unityTasks';
import { processFailure } from './cliProcess';
import { checkConnection, ConnectionStatusBar } from './connectionStatus';
import { compilerDiagnosticSource } from './compilerDiagnostics';

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
	waitUntilEditorIdle: (projectRoot: string) => Promise<void> = async () => {},
	reportFailure: (error: unknown) => void = (error) => {
		console.error('Unity recompilation failed', error);
	}
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
	const gitOperations = new Map<vscode.TerminalShellExecution, { readonly terminal: vscode.Terminal; readonly roots: ReadonlySet<string> }>();
	const gitBusy = (projectRoot: string): boolean => [...gitOperations.values()].some((operation) => operation.roots.has(projectRoot));
	const restartQuietPeriod = (projectRoot: string): void => {
		const item = pending.get(projectRoot);
		if (!item) { return; }
		if (item.timer) { clearTimeout(item.timer); item.timer = undefined; }
		if (gitBusy(projectRoot)) { return; }
		const quietPeriod = vscode.workspace.getConfiguration('unityCompileOnSave', item.uri).get<number>('quietPeriodSeconds', 2);
		item.timer = setTimeout(() => {
			item.timer = undefined;
			prepare(projectRoot);
		}, quietPeriod * 1000);
	};
	const diagnosticBelongsTo = (uri: vscode.Uri, projectRoot: string): boolean => {
		if (uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.cs') { return false; }
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		return folder !== undefined && path.relative(folder.uri.fsPath, projectRoot) === '';
	};
	const hasBlockingErrors = (projectRoot: string): boolean => vscode.languages.getDiagnostics().some(([uri, diagnostics]) =>
		diagnosticBelongsTo(uri, projectRoot) && diagnostics.some((diagnostic) =>
			diagnostic.severity === vscode.DiagnosticSeverity.Error && diagnostic.source !== compilerDiagnosticSource));
	const lockFingerprint = (projectRoot: string): string | undefined => {
		const lockFile = path.join(projectRoot, 'Packages', 'packages-lock.json');
		return existsSync(lockFile) ? createHash('sha256').update(readFileSync(lockFile)).digest('hex') : undefined;
	};

	const flush = (projectRoot: string): void => {
		const item = pending.get(projectRoot);
		if (!item || item.timer || running.has(projectRoot) || gitBusy(projectRoot)) {
			return;
		}
		// Diagnostics can change while the Editor readiness check is in flight.
		if (hasBlockingErrors(projectRoot)) { return; }
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
		let packagesResolved = false;
		void run(projectRoot, kinds).then(() => { packagesResolved = kinds.has('packages'); }).catch((error: unknown) => {
			packagesResolved = error instanceof OperationError && error.result.packagesResolved;
			reportFailure(error);
			if (error instanceof OperationError && error.result.status === 'deferred') {
				const retained = pending.get(projectRoot) ?? item;
				for (const kind of kinds) { retained.kinds.add(kind); }
				if (!retained.timer) {
					retained.timer = setTimeout(() => {
						retained.timer = undefined;
						prepare(projectRoot);
					}, 5000);
				}
				pending.set(projectRoot, retained);
			}
		}).finally(() => {
			if (packagesResolved) {
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
		if (!item || item.timer || waiting.has(projectRoot) || running.has(projectRoot) || gitBusy(projectRoot)) {
			return;
		}
		const config = vscode.workspace.getConfiguration('unityCompileOnSave', item.uri);
		if (!enabled(config) || ![...item.kinds].some((kind) => config.get<boolean>(
			kind === 'source' ? 'recompileOnSourceChanges' : 'recompileOnProjectEnvironmentChanges', kind === 'source'
		))) {
			pending.delete(projectRoot);
			return;
		}
		// Leave changes pending without polling Unity while C# Problems contain errors.
		if (hasBlockingErrors(projectRoot)) { return; }
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
			reportFailure(error);
			if (processFailure(error).connection || (error instanceof OperationError && error.result.status === 'deferred')) {
				const retained = pending.get(projectRoot);
				if (retained && !retained.timer) {
					retained.timer = setTimeout(() => {
						retained.timer = undefined;
						prepare(projectRoot);
					}, 5000);
				}
			} else {
				const discarded = pending.get(projectRoot);
				if (discarded?.timer) { clearTimeout(discarded.timer); }
				pending.delete(projectRoot);
			}
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
		pending.set(projectRoot, item);
		restartQuietPeriod(projectRoot);
	};

	const repositoryRoot = (directory: string): string | undefined => {
		let current = directory;
		while (!existsSync(path.join(current, '.git'))) {
			const parent = path.dirname(current);
			if (parent === current) { return undefined; }
			current = parent;
		}
		return current;
	};
	const contains = (parent: string, child: string): boolean => {
		const relative = path.relative(parent, child);
		return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	};
	const gitStarted = vscode.window.onDidStartTerminalShellExecution(({ terminal, execution, shellIntegration }) => {
		const cwd = execution.cwd ?? shellIntegration.cwd;
		if (cwd?.scheme !== 'file') { return; }
		const roots = new Set<string>();
		// Parse only direct Git commands, not arbitrary shell scripts or aliases.
		for (const match of execution.commandLine.value.matchAll(/(?:^|[;&|\r\n])\s*(?:&\s*)?git(?:\.exe)?\s+([^;&|\r\n]*)/gi)) {
			const args = (match[1].match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((arg) => arg.replace(/^["']|["']$/g, ''));
			let directory = cwd.fsPath;
			let index = 0;
			while (args[index]?.startsWith('-')) {
				const option = args[index++];
				if (option === '-C' || option === '-c') {
					const value = args[index++];
					if (value === undefined) { break; }
					if (option === '-C') { directory = path.resolve(directory, value); }
				}
			}
			if (!/^(checkout|switch|pull|merge|rebase|reset|restore|stash|cherry-pick|revert|apply|clean)$/.test(args[index] ?? '')) { continue; }
			const repository = repositoryRoot(directory);
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				const root = folder.uri.fsPath;
				if (folder.uri.scheme === 'file' && existsSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt')) &&
					(contains(root, directory) || contains(directory, root) || (repository !== undefined && repositoryRoot(root) === repository))) {
					roots.add(root);
				}
			}
		}
		if (roots.size === 0) { return; }
		gitOperations.set(execution, { terminal, roots });
		for (const root of roots) { restartQuietPeriod(root); }
	});
	const releaseGit = (execution: vscode.TerminalShellExecution): void => {
		const operation = gitOperations.get(execution);
		if (!operation) { return; }
		gitOperations.delete(execution);
		for (const root of operation.roots) { restartQuietPeriod(root); }
	};
	const gitEnded = vscode.window.onDidEndTerminalShellExecution(({ execution }) => releaseGit(execution));
	const terminalClosed = vscode.window.onDidCloseTerminal((terminal) => {
		for (const [execution, operation] of gitOperations) {
			if (operation.terminal === terminal) { releaseGit(execution); }
		}
	});
	const diagnosticChanges = vscode.languages.onDidChangeDiagnostics((event) => {
		for (const projectRoot of pending.keys()) {
			if (event.uris.some((uri) => diagnosticBelongsTo(uri, projectRoot))) { prepare(projectRoot); }
		}
	});
	return {
		onSave(document) {
			schedule(document.uri);
		},
		onFileChange: schedule,
		forget(projectRoot: string): void {
			const state = pending.get(projectRoot);
			if (state?.timer) { clearTimeout(state.timer); }
			pending.delete(projectRoot);
			waiting.delete(projectRoot);
		},
		dispose() {
			gitStarted.dispose();
			gitEnded.dispose();
			terminalClosed.dispose();
			gitOperations.clear();
			diagnosticChanges.dispose();
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

export function activate(context: vscode.ExtensionContext): UnityTaskRunner {
	const output = vscode.window.createOutputChannel('Unity CLI');
	const runner = new UnityTaskRunner(context.globalStorageUri.fsPath, output);
	const unityFolders = (): vscode.WorkspaceFolder[] => (vscode.workspace.workspaceFolders ?? []).filter((folder) =>
		folder.uri.scheme === 'file' && existsSync(path.join(folder.uri.fsPath, 'ProjectSettings', 'ProjectVersion.txt')));
	const connection = new ConnectionStatusBar(async (folder, signal) => {
		const executable = await runner.connectionExecutable(folder);
		signal.throwIfAborted();
		return checkConnection(folder.uri.fsPath, executable, signal, runner.processFor(folder.uri.fsPath));
	}, unityFolders);
	const folderFor = (root: string): vscode.WorkspaceFolder => {
		const folder = unityFolders().find((item) => path.relative(item.uri.fsPath, root) === '');
		if (!folder) {
			throw new Error('The Unity project root is no longer open in this workspace.');
		}
		return folder;
	};
	const handler = createRecompileHandler(
		async (root, kinds) => { await runner.execute(folderFor(root), 'recompile', kinds); },
		(root) => runner.waitUntilIdle(folderFor(root)),
		(error) => runner.reportFailure('Unity recompilation failed', error, false)
	);
	const setupFolder = (folder: vscode.WorkspaceFolder): void => {
		const config = vscode.workspace.getConfiguration('unityCompileOnSave', folder.uri);
		if (vscode.workspace.isTrusted && enabled(config) && config.get<boolean>('autoSetup', true)) {
			void runner.execute(folder, 'setup').catch((error: unknown) => {
				runner.reportFailure('Unity automatic setup failed', error, false);
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
		connection,
		vscode.commands.registerCommand('unityCompileOnSave.setup', async (uri?: vscode.Uri) => {
			const results: OperationResult[] = [];
			for (const folder of unityFolders().filter((folder) => !uri || folder.uri.toString() === uri.toString())) {
				const result = await runner.request(folder, 'setup');
				results.push(result);
				if (result.status !== 'success' && result.status !== 'cancelled') { runner.reportFailure('Unity Pipeline setup failed', new Error(result.message)); }
			}
			return results;
		}),
		vscode.commands.registerCommand('unityCompileOnSave.recompile', async (uri?: vscode.Uri) => {
			const results: OperationResult[] = [];
			if (!vscode.workspace.isTrusted) { return results; }
			for (const folder of unityFolders().filter((folder) => !uri || folder.uri.toString() === uri.toString())) {
				const result = await runner.request(folder, 'recompile');
				results.push(result);
				if (result.status !== 'success' && result.status !== 'cancelled') { runner.reportFailure('Unity recompilation failed', new Error(result.message)); }
			}
			return results;
		}),
		runner.onDidComplete(() => connection.refresh()),
		vscode.workspace.onDidGrantWorkspaceTrust(() => { for (const folder of unityFolders()) { setupFolder(folder); } }),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('unityCompileOnSave.recompileOnSave') ||
				event.affectsConfiguration('unityCompileOnSave.compileUnityOnSave') || event.affectsConfiguration('unityCompileOnSave.autoSetup')) {
				for (const folder of unityFolders()) {
					if (event.affectsConfiguration('unityCompileOnSave.autoSetup', folder.uri)) {
						handler.forget(folder.uri.fsPath);
						runner.forget(folder);
					}
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
	return runner;
}
