import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { clipWithSpill, spillToolOutput, toolOutputDir } from './toolOutputSpill';
import { clipToolOutput } from './clip';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

export async function run(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-spill-'));
	const big = 'line\n'.repeat(500);
	const rel = await spillToolOutput(root, big, { toolName: 'shell' });
	assert(!!rel && rel.includes('.CodeForge/tool-output/'), 'spill path');
	const abs = path.join(root, rel!);
	const body = await fs.readFile(abs, 'utf8');
	assert(body === big, 'full body');
	const clipped = await clipWithSpill(root, 'shell', big, 200, clipToolOutput);
	assert(/full output saved to/i.test(clipped), 'marker');
	assert((await fs.readdir(toolOutputDir(root))).includes('.gitignore'), 'gitignore');
	await fs.rm(root, { recursive: true, force: true });
}

if (require.main === module) {
	run()
		.then(() => console.log('toolOutputSpill.selftest: ok'))
		.catch(err => {
			console.error(err);
			process.exit(1);
		});
}
