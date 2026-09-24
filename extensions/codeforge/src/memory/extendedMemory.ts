/**
 * Extended memory — durable lessons learned from tool failures (esp. shell on Windows).
 * Persists per workspace under .CodeForge/memory/lessons.json (or ~/.CodeForge/ai/memory/{hash}/).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDir, projectMemoryDir, workspaceHash, homeRoot } from '../storage/paths';

export type LessonKind = 'shell' | 'tool' | 'platform';

export interface MemoryLesson {
	/** Stable id, e.g. shell.unix-tail */
	id: string;
	kind: LessonKind;
	/** Short human label */
	title: string;
	/** What to avoid / what went wrong */
	pattern: string;
	/** What to do instead */
	advice: string;
	hits: number;
	lastSeen: string;
	/** Optional regex source for matching future commands (string form) */
	match?: string;
}

interface LessonsFile {
	version: 1;
	workspace?: string;
	lessons: MemoryLesson[];
}

const MAX_LESSONS = 40;

/** Built-in platform lessons (always present; hits grow when reinforced). */
const SEED_LESSONS: MemoryLesson[] = [
	{
		id: 'shell.unix-tail',
		kind: 'platform',
		title: 'No Unix tail on cmd.exe',
		pattern: '| tail / head / grep (Unix)',
		advice: 'Shell is cmd.exe. Do not pipe to tail/head/grep. Run the full command (dotnet build/test) and read the output.',
		hits: 0,
		lastSeen: '',
		match: '\\|\\s*(tail|head|grep)\\b',
	},
	{
		id: 'shell.unix-cat',
		kind: 'platform',
		title: 'No cat for files',
		pattern: 'cat / type used to browse source',
		advice: 'Use the read or list tools for files — not shell cat/type/dir tours.',
		hits: 0,
		lastSeen: '',
		match: '^(cat|type)\\s+',
	},
	{
		id: 'shell.findstr-quotes',
		kind: 'platform',
		title: 'findstr multi-word quotes',
		pattern: 'findstr /i "a b c" misparsed as filenames',
		advice: 'Use a single findstr pattern (findstr /i error) or skip findstr and run the raw build/test.',
		hits: 0,
		lastSeen: '',
		match: 'findstr.*"[^"]*\\s[^"]*"',
	},
	{
		id: 'shell.findstr-exit1',
		kind: 'platform',
		title: 'findstr exit 1 ≠ build failed',
		pattern: 'findstr exit 1 with (no output)',
		advice: 'findstr returns exit 1 when there are no matches. That does NOT mean the build/test failed — re-run without findstr.',
		hits: 0,
		lastSeen: '',
		match: 'findstr',
	},
	{
		id: 'shell.cmd-semicolon',
		kind: 'platform',
		title: 'cmd does not chain with ;',
		pattern: 'cmd1 ; cmd2',
		advice: 'On Windows cmd.exe use && (or &) to chain commands — not bash-style semicolons.',
		hits: 0,
		lastSeen: '',
		match: ';\\s*(echo|dotnet|npm|dir)',
	},
];

let cache: LessonsFile | null = null;
let cacheKey: string | undefined;

function lessonsPath(workspaceFolder?: string): string {
	if (workspaceFolder) {
		return path.join(projectMemoryDir(workspaceFolder), 'lessons.json');
	}
	return path.join(homeRoot(), 'ai', 'memory', 'default', 'lessons.json');
}

async function load(workspaceFolder?: string): Promise<LessonsFile> {
	const key = workspaceFolder ? workspaceHash(workspaceFolder) : 'default';
	if (cache && cacheKey === key) return cache;
	const file = lessonsPath(workspaceFolder);
	try {
		const raw = JSON.parse(await fs.readFile(file, 'utf8')) as LessonsFile;
		cache = {
			version: 1,
			workspace: raw.workspace ?? workspaceFolder,
			lessons: mergeSeed(raw.lessons ?? []),
		};
	} catch {
		cache = {
			version: 1,
			workspace: workspaceFolder,
			lessons: SEED_LESSONS.map(l => ({ ...l })),
		};
	}
	cacheKey = key;
	return cache;
}

function mergeSeed(existing: MemoryLesson[]): MemoryLesson[] {
	const map = new Map(existing.map(l => [l.id, l]));
	for (const seed of SEED_LESSONS) {
		if (!map.has(seed.id)) {
			map.set(seed.id, { ...seed });
		} else {
			const cur = map.get(seed.id)!;
			map.set(seed.id, {
				...seed,
				...cur,
				advice: cur.advice || seed.advice,
				pattern: cur.pattern || seed.pattern,
				match: cur.match || seed.match,
			});
		}
	}
	return [...map.values()];
}

async function save(workspaceFolder: string | undefined, data: LessonsFile): Promise<void> {
	const file = lessonsPath(workspaceFolder);
	await ensureDir(path.dirname(file));
	await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
	cache = data;
	cacheKey = workspaceFolder ? workspaceHash(workspaceFolder) : 'default';
}

export async function getExtendedLessons(workspaceFolder?: string): Promise<MemoryLesson[]> {
	const data = await load(workspaceFolder);
	return [...data.lessons].sort((a, b) => b.hits - a.hits || b.lastSeen.localeCompare(a.lastSeen));
}

export async function recordLesson(
	workspaceFolder: string | undefined,
	lesson: Omit<MemoryLesson, 'hits' | 'lastSeen'> & { hits?: number }
): Promise<MemoryLesson> {
	const data = await load(workspaceFolder);
	const now = new Date().toISOString();
	const idx = data.lessons.findIndex(l => l.id === lesson.id);
	let next: MemoryLesson;
	if (idx >= 0) {
		const prev = data.lessons[idx];
		next = {
			...prev,
			...lesson,
			hits: prev.hits + 1,
			lastSeen: now,
			advice: lesson.advice || prev.advice,
			pattern: lesson.pattern || prev.pattern,
		};
		data.lessons[idx] = next;
	} else {
		next = {
			...lesson,
			hits: lesson.hits ?? 1,
			lastSeen: now,
		};
		data.lessons.push(next);
	}
	data.lessons = data.lessons
		.sort((a, b) => b.hits - a.hits)
		.slice(0, MAX_LESSONS);
	await save(workspaceFolder, data);
	return next;
}

export interface ShellLessonResult {
	lesson: MemoryLesson;
	/** Extra advice to append to tool output */
	adviceBlock: string;
	/** Treat as cmd-unix noise (not a real implementation failure) */
	isCmdNoise: boolean;
}

/**
 * Classify a failed shell result and reinforce extended memory.
 */
export async function learnFromShellFailure(
	workspaceFolder: string | undefined,
	command: string,
	output: string
): Promise<ShellLessonResult | null> {
	const cmd = command.trim();
	const out = output || '';
	const classified = classifyShellFailure(cmd, out);
	if (!classified) return null;

	const lesson = await recordLesson(workspaceFolder, classified);
	return {
		lesson,
		isCmdNoise: classified.kind === 'platform' || classified.id.startsWith('shell.'),
		adviceBlock: `(known issue — ${lesson.title}: ${lesson.advice})`,
	};
}

export function classifyShellFailure(
	command: string,
	output: string
): Omit<MemoryLesson, 'hits' | 'lastSeen'> | null {
	const cmd = command.trim();
	const out = output;

	if (/\|\s*(tail|head|grep)\b/i.test(cmd) || /'tail' is not recognized|'head' is not recognized|'grep' is not recognized/i.test(out)) {
		return {
			id: 'shell.unix-tail',
			kind: 'platform',
			title: 'No Unix tail/grep on cmd.exe',
			pattern: cmd.slice(0, 160),
			advice:
				'Do not use | tail / | head / | grep. Re-run the same command WITHOUT the pipe and read the full output.',
			match: '\\|\\s*(tail|head|grep)\\b',
		};
	}

	if (/FINDSTR:\s*Cannot open/i.test(out)) {
		return {
			id: 'shell.findstr-quotes',
			kind: 'platform',
			title: 'findstr quotes broken',
			pattern: cmd.slice(0, 160),
			advice:
				'findstr treated words as filenames. Use one simple pattern (findstr /i error) or omit findstr entirely.',
			match: 'findstr',
		};
	}

	if (
		/\bfindstr\b/i.test(cmd) &&
		(/\(no output\)/i.test(out) || /exit\s+1/i.test(out)) &&
		!/Build FAILED|error CS|error RZ/i.test(out)
	) {
		return {
			id: 'shell.findstr-exit1',
			kind: 'platform',
			title: 'findstr exit 1 is not a build failure',
			pattern: cmd.slice(0, 160),
			advice:
				'findstr exit 1 usually means no matches. Re-run dotnet build/test WITHOUT findstr to see the real result.',
			match: 'findstr',
		};
	}

	if (/;\s*(echo|dotnet|npm|dir|type)\b/i.test(cmd) && /exit\s+[1-9]/i.test(out)) {
		return {
			id: 'shell.cmd-semicolon',
			kind: 'platform',
			title: 'cmd semicolon chaining',
			pattern: cmd.slice(0, 160),
			advice: 'Use && between commands on Windows cmd.exe, not ;',
			match: ';\\s*(echo|dotnet|npm)',
		};
	}

	if (/^(dir|ls)\b/i.test(cmd) && /\|/.test(cmd)) {
		return {
			id: 'shell.dir-pipe',
			kind: 'shell',
			title: 'Prefer list tool over dir|findstr',
			pattern: cmd.slice(0, 160),
			advice: 'Use the list / retrieve / search tools to discover files — not dir piped through findstr.',
			match: '^(dir|ls)\\b.*\\|',
		};
	}

	if (/is not recognized as an internal or external command/i.test(out)) {
		const m = /'([^']+)' is not recognized/i.exec(out);
		const bin = m?.[1] || 'command';
		return {
			id: `shell.missing-${bin.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
			kind: 'shell',
			title: `Missing binary: ${bin}`,
			pattern: cmd.slice(0, 160),
			advice: `"${bin}" is not available in this shell. Use a Windows/cmd-compatible command or an IDE tool instead.`,
		};
	}

	return null;
}

export function formatLessonsForPrompt(lessons: MemoryLesson[], max = 8): string {
	const top = lessons.filter(l => l.hits > 0 || l.kind === 'platform').slice(0, max);
	if (!top.length) {
		// Still show seed platform tips (hits may be 0)
		const seeds = lessons.filter(l => l.kind === 'platform').slice(0, 5);
		if (!seeds.length) return '';
		return [
			'### Platform notes',
			...seeds.map(l => `- ${l.title}: ${l.advice}`),
		].join('\n');
	}
	return [
		'### Known issues from earlier errors',
		...top.map(l => {
			const n = l.hits > 0 ? ` ×${l.hits}` : '';
			return `- [${l.id}]${n} ${l.title}: ${l.advice}`;
		}),
	].join('\n');
}

/** True if this shell failure should not inflate "implementation blocked" heuristics. */
export function isShellNoiseFailure(command: string, output: string): boolean {
	return classifyShellFailure(command, output) !== null;
}
