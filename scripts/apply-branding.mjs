/**
 * Apply OpenCodeIDE branding to Code-OSS product.json
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
	nameShort: 'OpenCodeIDE',
	nameLong: 'OpenCodeIDE - AI-Native Code Editor',
	applicationName: 'opencodeide',
	dataFolderName: '.opencodeide',
	sharedDataFolderName: '.opencodeide-shared',
	win32MutexName: 'opencodeide',
	licenseName: 'MIT',
	licenseUrl: 'https://github.com/Kortexio/OpenCodeIDE/blob/main/LICENSE',
	serverLicenseUrl: 'https://github.com/Kortexio/OpenCodeIDE/blob/main/LICENSE',
	serverApplicationName: 'opencodeide-server',
	serverDataFolderName: '.opencodeide-server',
	tunnelApplicationName: 'opencodeide-tunnel',
	win32DirName: 'OpenCodeIDE',
	win32NameVersion: 'OpenCodeIDE',
	win32RegValueName: 'OpenCodeIDE',
	win32AppUserModelId: 'Kortexio.OpenCodeIDE',
	win32ShellNameShort: 'OpenCodeIDE',
	win32TunnelServiceMutex: 'opencodeide-tunnelservice',
	win32TunnelMutex: 'opencodeide-tunnel',
	darwinBundleIdentifier: 'com.kortexio.opencodeide',
	linuxIconName: 'com.kortexio.opencodeide',
	reportIssueUrl: 'https://github.com/Kortexio/OpenCodeIDE/issues/new',
	urlProtocol: 'opencodeide',
};

Object.assign(product, branding);

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
console.log('Applied OpenCodeIDE branding to vscode/product.json');
console.log(`  nameShort: ${product.nameShort}`);
console.log(`  applicationName: ${product.applicationName}`);
console.log(`  dataFolderName: ${product.dataFolderName}`);
