import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');

run({
	platform: 'node',
	entryPoints: {
		extension: path.join(srcDir, 'extension.ts'),
	},
	srcDir,
	outdir: outDir,
	// Optional browser agent — do not bundle Playwright (chromium-bidi is unresolved in CI).
	additionalOptions: {
		external: [
			'vscode',
			'playwright',
			'playwright-core',
			'chromium-bidi',
			'chromium-bidi/*',
		],
	},
}, process.argv);
