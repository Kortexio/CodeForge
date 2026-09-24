/**
 * Data clipping with explicit markers. Instructions are never clipped (see governance);
 * data (tool output, file bodies, history) may be, but always says what was left out.
 * Pure — no vscode.
 */

/** Lines a build/test run must never lose: compiler errors, failed tests, final summary. */
const SIGNAL_LINE =
	/\berror\s+(CS|RZ|MSB|NU|NETSDK)\d+|\bwarning\s+(CS|NU|MSB)\d+|:\s*error\b|\bFAILED\b|^\s*Failed\s+\S+|\bFailed!|\bPassed!|\bnot ok\b|Build (succeeded|FAILED)|\d+\s+(Warning|Error)\(s\)|Total tests|^\s*(Passed|Failed|Skipped|Total):|Assert\.|Expected:|Actual:|\bexit\s+\d+\b|# (pass|fail) \d+/i;

export function isSignalLine(line: string): boolean {
	return SIGNAL_LINE.test(line);
}

/** Head of `text` up to `max` chars, cut on a line boundary, with a marker saying what was omitted. */
export function clipData(text: string, max: number): string {
	const t = String(text ?? '');
	if (t.length <= max) return t;
	const lines = t.split('\n');
	let used = 0;
	let n = 0;
	while (n < lines.length && used + lines[n].length + 1 <= max) {
		used += lines[n].length + 1;
		n++;
	}
	if (n === 0) {
		return `${t.slice(0, max)}\n…[clipped: showing ${max} of ${t.length} chars]`;
	}
	return `${lines.slice(0, n).join('\n')}\n…[clipped: showing lines 1-${n} of ${lines.length}; ${t.length - used} chars omitted]`;
}

/**
 * Build/test output within `max` chars: every signal line (errors, failed tests, summary) is kept,
 * then as much head/tail context as fits. Marker reports the omitted line count.
 */
export function clipBuildOutput(text: string, max: number): string {
	const t = String(text ?? '').replace(/\r\n/g, '\n');
	if (t.length <= max) return t;
	const lines = t.split('\n');
	const keep = new Set<number>();
	let used = 0;
	const add = (i: number) => {
		if (keep.has(i) || i < 0 || i >= lines.length) return true;
		const cost = lines[i].length + 1;
		if (used + cost > max) return false;
		keep.add(i);
		used += cost;
		return true;
	};
	const seen = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		if (!isSignalLine(lines[i])) continue;
		const key = lines[i].trim();
		if (seen.has(key)) continue;
		seen.add(key);
		add(i);
	}
	for (let i = 0; i < Math.min(6, lines.length); i++) add(i);
	for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) add(i);
	const ordered = [...keep].sort((a, b) => a - b);
	const out: string[] = [];
	let prev = -1;
	for (const i of ordered) {
		if (i > prev + 1) out.push(`…[${i - prev - 1} lines omitted]`);
		out.push(lines[i]);
		prev = i;
	}
	if (prev < lines.length - 1) out.push(`…[${lines.length - 1 - prev} lines omitted]`);
	return `[summarized output: ${lines.length} lines → errors, failed tests and summary kept]\n${out.join('\n')}`;
}

/** Tool output clip that keeps build/test signal for shell/dotnet/oracle results. */
export function clipToolOutput(toolName: string, text: string, max: number): string {
	const buildLike =
		toolName === 'shell' || toolName === 'dotnet' || toolName === 'oracle' || /^exit\s+\d+/m.test(text);
	return buildLike ? clipBuildOutput(text, max) : clipData(text, max);
}
