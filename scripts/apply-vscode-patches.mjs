/**
 * Apply OpenCodeIDE patches on top of Code-OSS.
 * Currently:
 * - Allow Visual Studio 2026 (folder "18") in Windows toolchain check
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const preinstallPath = path.join(root, 'vscode', 'build', 'npm', 'preinstall.ts');

if (!fs.existsSync(preinstallPath)) {
	console.error('vscode/build/npm/preinstall.ts not found. Run vscode setup first.');
	process.exit(1);
}

let source = fs.readFileSync(preinstallPath, 'utf8');

const oldVersions = `const supportedVersions = ['2022', '2019'];`;
const newVersions = `const supportedVersions = ['2022', '2019', '18', '2026'];`;

if (!source.includes(oldVersions) && source.includes(newVersions)) {
	console.log('VS toolchain patch already applied');
	process.exit(0);
}

if (!source.includes(oldVersions)) {
	console.error('Could not find supportedVersions marker in preinstall.ts — upstream may have changed.');
	process.exit(1);
}

source = source.replace(oldVersions, newVersions);

// Also teach the custom-location hint about VS 2026
source = source.replace(
	'set vs2022_install=<path> (or vs2019_install for older versions)',
	'set vs2022_install=<path> (or vs2019_install / vs18_install / vs2026_install)'
);

fs.writeFileSync(preinstallPath, source, 'utf8');
console.log('Patched vscode/build/npm/preinstall.ts to accept Visual Studio 2026 (18)');
