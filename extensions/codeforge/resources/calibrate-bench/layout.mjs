/**
 * Resolve bench paths for repo checkout vs extension-packaged calibrate suite.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * @returns {{
 *   packaged: boolean;
 *   here: string;
 *   extRoot: string;
 *   extOut: string;
 *   vscodeMock: string;
 *   resultsDir: string;
 *   repoRoot: string;
 * }}
 */
export function resolveBenchLayout() {
	const packagedOut = path.resolve(HERE, '..', '..', 'out');
	const packagedMock = path.join(HERE, 'support', 'vscodeFsMock.js');
	const packagedMarker = path.join(HERE, '.packaged');
	if (
		fs.existsSync(packagedMarker) ||
		(fs.existsSync(packagedOut) && fs.existsSync(packagedMock))
	) {
		const extRoot = path.resolve(HERE, '..', '..');
		return {
			packaged: true,
			here: HERE,
			extRoot,
			extOut: packagedOut,
			vscodeMock: packagedMock,
			resultsDir: path.join(os.homedir(), '.CodeForge', 'ai', 'calibrate-results'),
			repoRoot: extRoot,
		};
	}
	const repo = path.resolve(HERE, '..');
	return {
		packaged: false,
		here: HERE,
		extRoot: path.join(repo, 'extensions', 'codeforge'),
		extOut: path.join(repo, 'extensions', 'codeforge', 'out'),
		vscodeMock: path.join(repo, 'tests', 'support', 'vscodeFsMock.js'),
		resultsDir: path.join(HERE, 'results'),
		repoRoot: repo,
	};
}

export { HERE };
