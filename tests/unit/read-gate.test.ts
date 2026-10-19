import {
	applyReadGateRemedy,
	createReadGateState,
	decideEditReadGate,
	decideWriteReadGate,
	markReadThisTurn,
	pathSeenBefore,
} from '../../extensions/codeforge/src/agent/readGate';

const FILE = `export function greet(name: string): string {
  return "hi " + name;
}
`;

describe('readGate', () => {
	it('allows edit after markReadThisTurn', () => {
		const state = createReadGateState();
		markReadThisTurn(state, 'src/A.ts');
		const d = decideEditReadGate(state, 'src/A.ts', FILE, 'return "hi "');
		expect(d.allow).toBe(true);
	});

	it('refuses edit without read and attaches numbered excerpt', () => {
		const state = createReadGateState();
		const d = decideEditReadGate(state, 'src/A.ts', FILE, 'return "hi " + name;');
		expect(d.allow).toBe(false);
		if (d.allow) return;
		expect(d.message).toMatch(/must copy old_string/i);
		expect(d.excerpt).toMatch(/\d+\|/);
		expect(d.excerpt).toContain('return "hi "');
		applyReadGateRemedy(state, d);
		expect(state.readThisTurn.has('src/a.ts') || [...state.readThisTurn].some(k => k.endsWith('a.ts'))).toBe(
			true
		);
		const again = decideEditReadGate(state, 'src/A.ts', FILE, 'return "hi " + name;');
		expect(again.allow).toBe(true);
	});

	it('refuses edit when file missing', () => {
		const state = createReadGateState();
		const d = decideEditReadGate(state, 'missing.ts', undefined);
		expect(d.allow).toBe(false);
		if (d.allow) return;
		expect(d.message).toMatch(/file missing or unreadable/i);
	});

	it('write gate allows new files; refuses overwrite without read this turn', () => {
		const state = createReadGateState();
		const fresh = decideWriteReadGate(state, 'new.ts', undefined);
		expect(fresh.allow).toBe(true);

		state.readPathsSeen.add('src/a.ts');
		const overwrite = decideWriteReadGate(state, 'src/A.ts', FILE);
		expect(overwrite.allow).toBe(false);
		if (overwrite.allow) return;
		expect(overwrite.excerpt).toMatch(/export function greet/);
		applyReadGateRemedy(state, overwrite);
		expect(decideWriteReadGate(state, 'src/A.ts', FILE).allow).toBe(true);
	});

	it('pathSeenBefore matches suffix aliases', () => {
		const state = createReadGateState();
		state.readPathsSeen.add('src/widgets/a.ts');
		expect(pathSeenBefore(state, 'a.ts')).toBe(true);
		expect(pathSeenBefore(state, 'b.ts')).toBe(false);
	});
});
