/**
 * Sync CodeForge AI extension into vscode/extensions as a built-in.
 *
 * Source of truth: extensions/codeforge/
 * Destination:     vscode/extensions/codeforge/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcExt = path.join(root, 'extensions', 'codeforge');
const destExt = path.join(root, 'vscode', 'extensions', 'codeforge');

if (!fs.existsSync(path.join(root, 'vscode', 'product.json'))) {
	console.error('vscode/ not found. Run: npm run vscode:setup');
	process.exit(1);
}

if (!fs.existsSync(srcExt)) {
	console.error('extensions/codeforge not found');
	process.exit(1);
}

function copyDir(from, to, { skip = [] } = {}) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		if (skip.includes(entry.name)) continue;
		const srcPath = path.join(from, entry.name);
		const destPath = path.join(to, entry.name);
		if (entry.isDirectory()) {
			copyDir(srcPath, destPath, { skip });
		} else {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

if (fs.existsSync(destExt)) {
	fs.rmSync(destExt, { recursive: true, force: true });
}

copyDir(srcExt, destExt, {
	skip: ['node_modules', 'out', 'dist', '.vscode-test', 'package-lock.json'],
});

// Built-in tsconfig: use Code-OSS vscode.d.ts + shared @types
const tsconfig = {
	extends: '../tsconfig.base.json',
	compilerOptions: {
		rootDir: './src',
		outDir: './out',
		noUnusedLocals: false,
		noUnusedParameters: false,
		skipLibCheck: true,
		types: ['node'],
		typeRoots: ['../../node_modules/@types'],
	},
	include: ['src/**/*', '../../src/vscode-dts/vscode.d.ts'],
};

fs.writeFileSync(path.join(destExt, 'tsconfig.json'), JSON.stringify(tsconfig, null, '\t') + '\n');

// Align package.json with first-party extension conventions
const pkgPath = path.join(destExt, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.publisher = 'kortexio';
pkg.license = 'MIT';
pkg.main = './out/extension.js';
pkg.scripts = {
	compile: 'gulp compile-extension:codeforge',
	watch: 'gulp watch-extension:codeforge',
};
delete pkg.devDependencies;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

console.log(`Synced built-in extension → ${path.relative(root, destExt)}`);
