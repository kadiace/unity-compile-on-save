import { defineConfig } from '@vscode/test-cli';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: './src/test/fixtures/UnityProjects.code-workspace',
	launchArgs: ['--user-data-dir', path.join(tmpdir(), `unity-compile-on-save-tests-${randomUUID()}`)],
	mocha: { timeout: 10000 },
});
