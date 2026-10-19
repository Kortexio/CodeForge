/**
 * Cursor-style browser observe helpers.
 */
import {
	formatActionWithObservation,
	formatPageState,
	pageStateChanged,
	pageStateFingerprint,
} from './observe';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const menu = {
	url: 'http://localhost:3000/',
	title: 'Game',
	text: 'INICIAR JOGO WASD mover',
};
const playing = {
	url: 'http://localhost:3000/',
	title: 'Game',
	text: 'Inimigos: 3 HP 100',
};

assert(pageStateChanged(menu, playing), 'menu → playing changes');
assert(!pageStateChanged(menu, { ...menu, text: '  INICIAR JOGO   WASD mover  ' }), 'whitespace-normalized same');
assert(pageStateFingerprint(menu).includes('INICIAR'), 'fingerprint carries text');

const unchanged = formatActionWithObservation({
	actionLine: 'Clicked button#start-btn.',
	before: menu,
	after: menu,
	warnIfUnchanged: true,
});
assert(/UI UNCHANGED/i.test(unchanged), 'unchanged warning');
assert(/### After/i.test(unchanged), 'after block');
assert(!/UI changed after action/i.test(unchanged), 'no false changed');

const changed = formatActionWithObservation({
	actionLine: 'Clicked button#start-btn.',
	before: menu,
	after: playing,
	warnIfUnchanged: true,
});
assert(/UI changed after action/i.test(changed), 'changed verdict');
assert(changed.includes('Inimigos'), 'after state in result');

assert(formatPageState(menu, 20).includes('…[clipped]') || formatPageState(menu, 20).length <= 80, 'clip');

console.log('observe.selftest: ok');
