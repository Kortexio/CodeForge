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
