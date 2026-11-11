import { redactSecrets } from './redactSecrets';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const a = redactSecrets('Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz');
assert(!/sk-abcdefgh/.test(a), 'redacts sk');
assert(/REDACTED/.test(a), 'marks redacted');

const b = redactSecrets('api_key=supersecretvalue123');
assert(!/supersecretvalue123/.test(b), 'redacts api_key assignment');

const c = redactSecrets('token: ghp_abcdefghijklmnopqrstuvwx');
assert(!/ghp_abcdefgh/.test(c), 'redacts ghp');

const d = redactSecrets('safe text with no secrets');
assert(d === 'safe text with no secrets', 'passthrough');

console.log('redactSecrets.selftest: ok');
