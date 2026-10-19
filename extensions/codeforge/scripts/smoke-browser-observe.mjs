/**
 * Smoke: navigate LocalTest + click start-btn; print After / UNCHANGED verdict.
 */
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const agent = require(path.join(__dirname, '../out/browser/agent.js'));

const url = process.argv[2] || 'http://localhost:3001/';

async function main() {
	console.log('=== navigate', url);
	const nav = await agent.browserNavigate(url);
	console.log(nav.slice(0, 1200));
	console.log('\n=== click #start-btn');
	const click1 = await agent.browserClick('button#start-btn');
	console.log(click1.slice(0, 1500));
	const unchanged = /UI UNCHANGED/i.test(click1);
	const changed = /UI changed after action/i.test(click1);
	console.log('\n=== verdict1', { unchanged, changed });
	console.log('\n=== click #start-btn again');
	const click2 = await agent.browserClick('button#start-btn');
	console.log(click2.slice(0, 800));
	console.log('\n=== verdict2', {
		unchanged: /UI UNCHANGED/i.test(click2),
		changed: /UI changed after action/i.test(click2),
	});
	await agent.browserClose();
	if (!unchanged && !changed) {
		console.error('FAIL: no verdict in click result');
		process.exit(1);
	}
	console.log('\nsmoke-browser-observe: ok');
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
