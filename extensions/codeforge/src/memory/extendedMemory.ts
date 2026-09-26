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

const SIGNATURE_STOP = new Set([
	'the',
	'and',
	'for',
	'with',
	'from',
	'this',
	'that',
	'not',
	'into',
	'your',
	'was',
	'are',
	'error',
	'failed',
	'failure',
	'command',
	'unknown',
	'path',
	'file',
]);

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
			lessons: Array.isArray(raw.lessons) ? raw.lessons : [],
		};
	} catch {
		cache = {
			version: 1,
			workspace: workspaceFolder,
			lessons: [],
		};
	}
	cacheKey = key;
	return cache;
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
 * Learn from a failed command. The lesson id comes from the error text, so the same
 * failure reinforces one record. Previously saved lessons match by their stored regex.
 */
export async function learnFromShellFailure(
	workspaceFolder: string | undefined,
	command: string,
	output: string
): Promise<ShellLessonResult | null> {
	const cmd = command.trim();
	const out = output || '';
	if (!cmd && !out.trim()) return null;

	const derived = lessonFromFailure(cmd, out);
	const known = (await load(workspaceFolder)).lessons.find(
		l => l.hits > 0 && (l.id === derived.id || lessonHitsText(l, `${cmd}\n${out}`))
	);
	const classified = known
		? {
				...derived,
				id: known.id,
				kind: known.kind,
				title: known.title,
				advice: known.advice,
				match: known.match || derived.match,
			}
		: derived;

	const lesson = await recordLesson(workspaceFolder, classified);
	const seen = lesson.hits > 1 ? ` Seen ${lesson.hits} times.` : '';
	return {
		lesson,
		isCmdNoise: isShellNoiseFailure(cmd, out),
		adviceBlock: `(lesson — ${lesson.title}: ${lesson.advice}${seen})`,
	};
}

/** Build a lesson from the failure text. Same error signature → same id. */
export function lessonFromFailure(
	command: string,
	output: string
): Omit<MemoryLesson, 'hits' | 'lastSeen'> {
	const cmd = command.trim();
	const errorLine = firstErrorLine(output) || 'command failed with no output';
	const signature = normalizeSignature(errorLine);
	const id = `shell.${slugSignature(signature)}`;
	return {
		id,
		kind: 'shell',
		title: clipText(errorLine, 80),
		pattern: clipText(cmd || errorLine, 160),
		advice: `This command failed: ${clipText(errorLine, 180)}. Do not run it again unchanged.`,
		match: matchFromError(errorLine),
	};
}

/** @deprecated Use lessonFromFailure. Kept so older callers still compile. */
export function classifyShellFailure(
	command: string,
	output: string
): Omit<MemoryLesson, 'hits' | 'lastSeen'> | null {
	if (!command.trim() && !output.trim()) return null;
	return lessonFromFailure(command, output);
}

export function formatLessonsForPrompt(lessons: MemoryLesson[], max = 8): string {
	const top = lessons.filter(l => l.hits > 0).slice(0, max);
	if (!top.length) return '';
	return [
		'### Known issues from earlier errors',
		...top.map(formatLessonItem),
	].join('\n');
}

/** One lesson as a context item (no heading). */
export function formatLessonItem(lesson: MemoryLesson): string {
	return `- [${lesson.id}] ×${lesson.hits} ${lesson.title}: ${lesson.advice}`;
}

/** Lessons already learned whose stored pattern appears in this text. */
export function lessonsForText(lessons: MemoryLesson[], text: string, max = 4): MemoryLesson[] {
	return lessons.filter(l => l.hits > 0 && lessonHitsText(l, text)).slice(0, max);
}

/** Shell rejected the invocation itself (missing program, Unix pipe). Real program failures stay visible. */
export function isShellNoiseFailure(command: string, output: string): boolean {
	const blob = `${command}\n${output}`;
	return (
		/is not recognized as an internal or external command/i.test(blob) ||
		/Removed Unix pipe/i.test(blob)
	);
}

export function resetLessonsCacheForTests(): void {
	cache = null;
	cacheKey = undefined;
}

function lessonHitsText(lesson: MemoryLesson, text: string): boolean {
	const source = lesson.match?.trim();
	if (!source || !text) return false;
	try {
		return new RegExp(source, 'i').test(text);
	} catch {
		return false;
	}
}

function firstErrorLine(output: string): string {
	const lines = output
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(Boolean);
	const skip = /^(exit\s+\d+|cwd:|sandbox:|\[shell\])/i;
	const preferred = lines.find(l =>
		/fatal:|error:|is not recognized|not recognized|exception|failed/i.test(l)
	);
	if (preferred) return preferred;
	return lines.find(l => !skip.test(l)) || '';
}

function normalizeSignature(line: string): string {
	return line
		.replace(/%[A-Za-z_][A-Za-z0-9_]*/g, '%VAR')
		.replace(/'[^']*'/g, "'…'")
		.replace(/"[^"]*"/g, '"…"')
		.replace(/[A-Za-z]:\\[^\s]+/g, 'PATH')
		.replace(/\b[0-9a-f]{7,}\b/gi, 'SHA')
		.replace(/\d+/g, 'N')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
		.slice(0, 140);
}

function slugSignature(signature: string): string {
	const words = signature
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(w => w.length > 2 && !SIGNATURE_STOP.has(w))
		.slice(0, 6);
	const base = (words.join('-') || 'failure').slice(0, 48);
	return base.replace(/-+$/g, '') || 'failure';
}

function matchFromError(errorLine: string): string {
	const words = errorLine
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter(w => w.length > 3 && !SIGNATURE_STOP.has(w))
		.slice(0, 4);
	if (!words.length) return '';
	return words
		.slice(0, 3)
		.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('[\\s\\S]{0,40}');
}

function clipText(text: string, max: number): string {
	const t = text.replace(/\s+/g, ' ').trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
