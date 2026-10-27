/**
 * Contract fingerprint changes when defaults change; config hash changes with sampling.
 */
import { contractFingerprint, profileConfigHash, stampForProfile } from './harnessFingerprint';
import { defaultModelProfile, mergeModelProfile } from './modelProfile';
import { emptyHarnessArtifact, learnedHarnessBlock, stampScreen } from './harnessRevision';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const a = contractFingerprint();
const b = contractFingerprint();
assert(a === b, 'contract fingerprint is stable');

const withTools = contractFingerprint({
	toolSchemas: [{ name: 'read', parameters: { type: 'object' } }],
});
assert(withTools !== a, 'tool schemas change the contract fingerprint');

const p1 = defaultModelProfile('s', 'm');
const p2 = mergeModelProfile(p1, {
	sampling: {
		...p1.sampling,
		toolThinking: { ...p1.sampling.toolThinking, temperature: 0.4 },
	},
});
assert(profileConfigHash(p1) !== profileConfigHash(p2), 'sampling changes config hash');
assert(profileConfigHash(p1, 0) !== profileConfigHash(p1, 1), 'harness revision changes config hash');

const stamp = stampForProfile(p1, 2);
assert(!!stamp.contract && !!stamp.configHash, 'stamp has both hashes');
assert(stamp.harnessRevision === 2, 'stamp carries harness revision');

const screened = stampScreen(
	{
		...emptyHarnessArtifact(),
		revision: 1,
		sections: {
			workflow: 'Prefer edit over write for small fixes.',
			writePolicy: '',
			toolContract: '',
		},
		contract: 'old-contract',
	},
	1
);
assert(learnedHarnessBlock(screened, 'old-contract').includes('Learned harness'), 'matching contract renders');
assert(learnedHarnessBlock(screened, 'new-contract') === '', 'mismatched contract is silent');

console.log('harnessFingerprint.selftest: ok');
