/**
 * Smoke checks for Cursor-parity helpers.
 */
import { formatTodos, writeTodos } from './todoStore';
import { awaitBgShell, formatBgStart, startBgShell } from './bgShell';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
	writeTodos('test-sess', [
		{ id: '1', content: 'a', status: 'pending' },
		{ id: '2', content: 'b', status: 'in_progress' },
	]);
	assert(formatTodos('test-sess').includes('in_progress'), 'todos format');

	const job = startBgShell('echo parity-ok');
	assert(!!job.id, 'bg job id');
	const waited = await awaitBgShell(job.id, { pattern: 'parity-ok', blockUntilMs: 10_000 });
	assert(
		waited.matched === true || /parity-ok/i.test(waited.output),
		'await sees output'
	);
	assert(formatBgStart(job).includes(job.id), 'bg start message');

	console.log('parityTools ok');
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
