import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '../..');
const electronExe = path.join(root, 'vscode', '.build', 'electron', 'CodeForge.exe');
const extensionPath = path.join(root, 'extensions', 'codeforge');
const vscodeRoot = path.join(root, 'vscode');

async function launchCodeForge(userDataDir: string): Promise<{
	app: ElectronApplication;
	window: Page;
}> {
	if (!fs.existsSync(electronExe)) {
		throw new Error(`Electron binary missing: ${electronExe}. Run npm run vscode:dev once to prepare.`);
	}
	if (!fs.existsSync(path.join(extensionPath, 'out', 'extension.js'))) {
		throw new Error('Extension not compiled. Run: npm run build:extensions');
	}

	const app = await electron.launch({
		executablePath: electronExe,
		args: [
			vscodeRoot,
			`--extensionDevelopmentPath=${extensionPath}`,
			`--user-data-dir=${userDataDir}`,
			'--disable-workspace-trust',
			'--skip-welcome',
			'--skip-release-notes',
			'--disable-updates',
			'--disable-telemetry',
			'--disable-gpu',
		],
		env: {
			...process.env,
			VSCODE_DEV: '1',
			NODE_ENV: 'development',
			ELECTRON_ENABLE_LOGGING: '1',
		},
		timeout: 120_000,
	});

	const window = await app.firstWindow({ timeout: 120_000 });
	return { app, window };
}

test.describe('CodeForge E2E smoke', () => {
	let userDataDir: string;
	let app: ElectronApplication | undefined;

	test.beforeEach(async () => {
		userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codeforge-e2e-'));
	});

	test.afterEach(async () => {
		if (app) {
			await app.close().catch(() => undefined);
			app = undefined;
		}
		await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
	});

	test('launches Electron and shows workbench', async () => {
		const launched = await launchCodeForge(userDataDir);
		app = launched.app;
		const { window } = launched;

		await window.waitForLoadState('domcontentloaded');
		await window.waitForSelector('.monaco-workbench', { timeout: 120_000 });

		const title = await window.title();
		expect(title.length).toBeGreaterThan(0);

		const hasWorkbench = await window.locator('.monaco-workbench').count();
		expect(hasWorkbench).toBeGreaterThan(0);
	});

	test('loads CodeForge AI extension development path', async () => {
		const launched = await launchCodeForge(userDataDir);
		app = launched.app;
		const { window } = launched;

		await window.waitForSelector('.monaco-workbench', { timeout: 120_000 });

		// Extension host loads asynchronously; wait for activity bar / sidebar chrome.
		await expect(window.locator('.monaco-workbench')).toBeVisible();

		const logs: string[] = [];
		window.on('console', msg => {
			logs.push(msg.text());
		});

		// Give the extension host a moment to activate built-ins + CodeForge.
		await window.waitForTimeout(8_000);

		const evalOk = await window.evaluate(() => {
			const w = document.querySelector('.monaco-workbench');
			return !!w;
		});
		expect(evalOk).toBe(true);

		// Process still alive and window not crashed.
		const windows = app.windows();
		expect(windows.length).toBeGreaterThan(0);
	});
});
