import {
	buildCompactionPrompt,
	formatCheckpointUserMessage,
	looksLikeStructuredSummary,
} from './structuredCompaction';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const prompt = buildCompactionPrompt({ update: false, planHint: 'Focus: configs' });
assert(prompt.includes('## Objective'), 'template');
assert(prompt.includes('Focus: configs'), 'plan hint');
assert(looksLikeStructuredSummary('## Objective\nx\n## Work State\ny\n## Next Move\nz'), 'valid');
assert(!looksLikeStructuredSummary('just prose'), 'invalid');
const msg = formatCheckpointUserMessage('## Objective\n- hi', 'a.ts: L1-10');
assert(msg.includes('Checkpoint') && msg.includes('FILES ALREADY READ'), 'checkpoint msg');

console.log('structuredCompaction.selftest: ok');
