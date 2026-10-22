/**
 * Sandbox policy unit checks (run via node after compile).
 */
import {
	hasShellChaining,
	isBlockedCommand,
	pickSandboxLevel,
	resolveSandboxLevel,
} from './runtime';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(
	resolveSandboxLevel('echo hi', { configured: 'restricted' }) === 'restricted',
	'restricted config stays restricted'
);
assert(
	resolveSandboxLevel('echo hi', { configured: 'restricted', fullFreedom: true }) ===
		'unrestricted',
	'full freedom overrides restricted'
);
assert(
	pickSandboxLevel('rm -rf ~', 'unrestricted') === 'unrestricted',
	'pickSandboxLevel uses configured only'
);
assert(
	resolveSandboxLevel('echo ok', { configured: 'restricted' }) === 'restricted',
	'tool sandbox hint cannot elevate — only configured level'
);

assert(hasShellChaining('npm test && npm run build'), 'detects && chaining');
assert(isBlockedCommand('rm -rf ~') !== undefined, 'blocks rm -rf ~');
assert(isBlockedCommand('rd /s /q C:\\temp') !== undefined, 'blocks rd /s');
assert(isBlockedCommand('Remove-Item -Recurse -Force x') !== undefined, 'blocks Remove-Item -Recurse');
assert(isBlockedCommand('del /f /q /s *.log') !== undefined, 'blocks del with /f /q /s any order');

console.log('sandbox runtime ok');
