import path from 'node:path';
import * as vscode from 'vscode';

export class CompilerDiagnostics implements vscode.Disposable {
	private readonly projects = new Map<string, Map<string, vscode.Diagnostic[]>>();
	readonly collection = vscode.languages.createDiagnosticCollection('Unity CLI');

	clear(projectRoot: string): void {
		this.projects.delete(projectRoot);
		this.publish();
	}

	private publish(): void {
		const files = new Map<string, vscode.Diagnostic[]>();
		for (const project of this.projects.values()) {
			for (const [file, diagnostics] of project) {
				files.set(file, [...(files.get(file) ?? []), ...diagnostics]);
			}
		}
		this.collection.clear();
		this.collection.set([...files].map(([file, diagnostics]) => [vscode.Uri.file(file), diagnostics]));
	}

	parse(projectRoot: string, output: string): void {
		// Unity/Roslyn: Assets/Foo.cs(12,3): error CS1002: ; expected
		const text = output.replace(/\x1b\[[0-9;]*m/g, '');
		for (const line of text.split(/\r?\n/)) {
			if (/^\s*[\[{]/.test(line) || /^\s*"[^"]+"\s*:/.test(line)) { continue; }
			const match = /^\s*("?[^\r\n]+?\.cs"?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning)\s+(CS\d+)\s*:\s*(.*)/i.exec(line);
			if (!match) { continue; }
			const [, file, row, column, severity, code, message] = match;
			this.add(projectRoot, file.trim().replace(/^['"]|['"]$/g, ''), Number(row), Number(column ?? 1), message, severity, code);
		}
	}

	parseJson(projectRoot: string, output: string): void {
		let value: unknown;
		try { value = JSON.parse(output); } catch (error) {
			if (error instanceof SyntaxError) { return; }
			throw error;
		}
		const visit = (entry: unknown): void => {
			if (typeof entry === 'string') { this.parse(projectRoot, entry); }
			else if (Array.isArray(entry)) { entry.forEach(visit); }
			else if (entry && typeof entry === 'object') {
				if ('file' in entry && typeof entry.file === 'string' && /\.cs$/i.test(entry.file) &&
					'line' in entry && typeof entry.line === 'number' && 'message' in entry && typeof entry.message === 'string' &&
					'type' in entry && (entry.type === 'error' || entry.type === 'warning')) {
					this.add(projectRoot, entry.file, entry.line,
						'column' in entry && typeof entry.column === 'number' ? entry.column : 1, entry.message, entry.type,
						'code' in entry && typeof entry.code === 'string' ? entry.code : undefined);
				}
				Object.values(entry).forEach(visit);
			}
		};
		visit(value);
	}

	private add(projectRoot: string, file: string, row: number, column: number, message: string, severity: string, code?: string): void {
		if (!Number.isInteger(row) || row < 1 || !Number.isInteger(column) || column < 1) { return; }
		const resolved = path.resolve(projectRoot, file.replace(/[\\/]/g, path.sep));
		const project = this.projects.get(projectRoot) ?? new Map<string, vscode.Diagnostic[]>();
		this.projects.set(projectRoot, project);
		const diagnostics = project.get(resolved) ?? [];
		const range = new vscode.Range(row - 1, column - 1, row - 1, column - 1);
		const level = severity.toLowerCase() === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
		if (diagnostics.some((item) => item.range.isEqual(range) && item.message === message && item.code === code && item.severity === level)) { return; }
		const diagnostic = new vscode.Diagnostic(range, message, level);
		diagnostic.source = 'Unity CLI';
		diagnostic.code = code;
		diagnostics.push(diagnostic);
		project.set(resolved, diagnostics);
		this.publish();
	}

	dispose(): void { this.projects.clear(); this.collection.dispose(); }
}
