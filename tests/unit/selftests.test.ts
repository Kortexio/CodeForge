/**
 * Runs every extensions/codeforge/src selftest (*.selftest.ts) under Jest.
 * Sync selftests execute asserts on require; async ones export run().
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'extensions', 'codeforge', 'src');

function findSelftests(dir: string): string[] {
	const out: string[] = [];
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		const st = fs.statSync(full);
		if (st.isDirectory()) {
			out.push(...findSelftests(full));
		} else if (name.endsWith('.selftest.ts')) {
			out.push(full);
		}
	}
	return out;
}

const files = findSelftests(SRC_ROOT).sort();

describe('extension selftests', () => {
	expect(files.length).toBeGreaterThan(0);

	for (const file of files) {
		const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
		it(rel, async () => {
			await new Promise<void>((resolve, reject) => {
				jest.isolateModules(() => {
					try {
						// eslint-disable-next-line @typescript-eslint/no-require-imports
						const mod = require(file) as { run?: () => void | Promise<void> };
						const result = typeof mod?.run === 'function' ? mod.run() : undefined;
						Promise.resolve(result).then(() => resolve()).catch(reject);
					} catch (err) {
						reject(err);
					}
				});
			});
		}, 30_000);
	}
});
