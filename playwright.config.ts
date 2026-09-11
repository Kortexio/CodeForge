import { defineConfig } from '@playwright/test';

/**
 * CodeForge E2E — Electron smoke against the vscode:dev binary.
 * Scoped to tests/e2e so Playwright does not pick up Jest/unit or vscode tree tests.
 */
export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	expect: { timeout: 60_000 },
	reporter: [['list']],
	forbidOnly: !!process.env.CI,
});
