/**
 * Apply CodeForge branding to Code-OSS product.json
 *
 * Usage: node scripts/apply-branding.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const productPath = path.join(root, 'vscode', 'product.json');

if (!fs.existsSync(productPath)) {
	console.error('vscode/product.json not found. Run: npm run vscode:setup');
	process.exit(1);
}

const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));

const branding = {
	nameShort: 'CodeForge',
	nameLong: 'CodeForge - AI-Native Code Editor',
	applicationName: 'codeforge',
	dataFolderName: '.codeforge',
	sharedDataFolderName: '.codeforge-shared',
	win32MutexName: 'codeforge',
	licenseName: 'MIT',
	licenseUrl: 'https://github.com/Kortexio/CodeForge/blob/main/LICENSE',
	serverLicenseUrl: 'https://github.com/Kortexio/CodeForge/blob/main/LICENSE',
	serverApplicationName: 'codeforge-server',
	serverDataFolderName: '.codeforge-server',
	tunnelApplicationName: 'codeforge-tunnel',
	win32DirName: 'CodeForge',
	win32NameVersion: 'CodeForge',
	win32RegValueName: 'CodeForge',
	win32AppUserModelId: 'Kortexio.CodeForge',
	win32ShellNameShort: 'CodeForge',
	win32TunnelServiceMutex: 'codeforge-tunnelservice',
	win32TunnelMutex: 'codeforge-tunnel',
	darwinBundleIdentifier: 'com.kortexio.codeforge',
	linuxIconName: 'com.kortexio.codeforge',
	reportIssueUrl: 'https://github.com/Kortexio/CodeForge/issues/new',
	urlProtocol: 'codeforge',
	// Avoid 'stable'/'insider' here — those require AppX context-menu packages.
	quality: 'exploration',
};

Object.assign(product, branding);

product.configurationDefaults = {
	...(product.configurationDefaults || {}),
	'workbench.sideBar.location': 'left',
	'workbench.secondarySideBar.defaultVisibility': 'visible',
	'chat.commandCenter.enabled': false,
	'chat.disableAIFeatures': true,
	// Code-OSS lacks Microsoft's extension signing infrastructure.
	'extensions.verifySignature': false,
};

// Keep existing AppIds / UUIDs from upstream if present; only set if missing
if (!product.win32x64AppId) {
	product.win32x64AppId = '{{F8A2A209-72B3-11EC-90D6-0242AC120003}';
}
if (!product.win32arm64AppId) {
	product.win32arm64AppId = '{{F8A2A20A-72B3-11EC-90D6-0242AC120003}';
}
if (!product.win32x64UserAppId) {
	product.win32x64UserAppId = '{{F8A2A20C-72B3-11EC-90D6-0242AC120003}';
}
if (!product.win32arm64UserAppId) {
	product.win32arm64UserAppId = '{{F8A2A20D-72B3-11EC-90D6-0242AC120003}';
}

fs.writeFileSync(productPath, JSON.stringify(product, null, '\t') + '\n', 'utf8');
console.log('Applied CodeForge branding to vscode/product.json');
console.log(`  nameShort: ${product.nameShort}`);
console.log(`  applicationName: ${product.applicationName}`);
console.log(`  dataFolderName: ${product.dataFolderName}`);
console.log(`  chat.disableAIFeatures: ${product.configurationDefaults['chat.disableAIFeatures']}`);
console.log(`  extensions.verifySignature: ${product.configurationDefaults['extensions.verifySignature']}`);

// Windows window / installer / taskbar icons (gulp embeds resources/win32/code.ico into the .exe)
const win32Dir = path.join(root, 'vscode', 'resources', 'win32');
const iconsWin = path.join(root, 'resources', 'icons', 'win');
const icon150 = path.join(iconsWin, 'code_150x150.png');
const icon70 = path.join(iconsWin, 'code_70x70.png');
const brandIconIco = path.join(iconsWin, 'code.ico');
if (fs.existsSync(win32Dir)) {
	if (fs.existsSync(icon150)) {
		fs.copyFileSync(icon150, path.join(win32Dir, 'code_150x150.png'));
		console.log('  win32 code_150x150.png: updated (dev window / taskbar icon)');
	}
	if (fs.existsSync(icon70)) {
		fs.copyFileSync(icon70, path.join(win32Dir, 'code_70x70.png'));
		console.log('  win32 code_70x70.png: updated');
	}
	if (fs.existsSync(brandIconIco)) {
		fs.copyFileSync(brandIconIco, path.join(win32Dir, 'code.ico'));
		console.log('  win32 code.ico: copied from resources/icons/win/code.ico');
	}
}

// Title-bar / banner app icon (custom chrome)
const titlebarSvgCandidates = [
	path.join(root, 'resources', 'icons', 'src', 'codeforge-icon.svg'),
];
const titlebarSvgSrc = titlebarSvgCandidates.find((p) => fs.existsSync(p));
if (titlebarSvgSrc) {
	const titlebarTargets = [
		path.join(root, 'vscode', 'src', 'vs', 'workbench', 'browser', 'media', 'code-icon.svg'),
		path.join(root, 'vscode', 'out', 'vs', 'workbench', 'browser', 'media', 'code-icon.svg'),
		path.join(root, 'vscode', 'out-vscode', 'vs', 'workbench', 'browser', 'media', 'code-icon.svg'),
		path.join(root, 'vscode', 'out-vscode', 'media', 'code-icon.svg'),
	];
	for (const dest of titlebarTargets) {
		if (fs.existsSync(path.dirname(dest))) {
			fs.copyFileSync(titlebarSvgSrc, dest);
		}
	}
	console.log(`  titlebar code-icon.svg: copied from ${path.relative(root, titlebarSvgSrc)}`);
}