/**
 * Unit checks for lesson decay, unlearn, and match quality (npx tsx).
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	getExtendedLessons,
	isRedTestFailure,
	learnFromShellFailure,
	learnFromShellSuccess,
	lessonDecayScore,
	lessonFromFailure,
	lessonsForCommand,
	recordLesson,
	resetLessonsCacheForTests,
} from './extendedMemory';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(
	isRedTestFailure('dotnet test', 'Failed: 2 tests\nTotal tests: 5'),
	'detects dotnet test failure'
);
assert(!isRedTestFailure('dotnet build', 'Build succeeded.'), 'build is not red test');
assert(
	lessonFromFailure('echo hi', 'not recognized').advice.includes('Do not run it again'),
	'non-test failures still produce do-not-repeat advice'
);

async function main(): Promise<void> {
	resetLessonsCacheForTests();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-lesson-st-'));
	try {
		const out = 'error: flag is not recognized as an internal or external command';
		const weak = lessonFromFailure('foo --flag', 'flag failed');
		assert(!!weak.match && weak.match.split(/\[/).length <= 2, 'weak match is short');

		const learned = await learnFromShellFailure(dir, 'az account show', out);
		assert(!!learned, 'learns from failure');
		const cleared = await learnFromShellSuccess(dir, 'az account show');
		assert(!!cleared && cleared.id === learned!.lesson.id, 'success unlearns same signature');
		const after = await getExtendedLessons(dir);
		assert(!after.some(l => l.id === learned!.lesson.id), 'lesson removed after success');

		const old = await recordLesson(dir, {
			id: 'shell.old',
			kind: 'shell',
			title: 'old',
			pattern: 'old cmd',
			advice: 'avoid',
			match: 'azure\\s+cli',
			hits: 2,
		});
		// Force age by rewriting lastSeen on disk.
		const file = path.join(dir, '.CodeForge', 'memory', 'lessons.json');
		const raw = JSON.parse(await fs.readFile(file, 'utf8')) as {
			lessons: Array<{ id: string; lastSeen: string; hits: number; inactive?: boolean; match?: string }>;
		};
		const aged = new Date(Date.now() - 30 * 86_400_000).toISOString();
		for (const l of raw.lessons) {
			if (l.id === old.id) l.lastSeen = aged;
		}
		// One-word match stays inactive.
		raw.lessons.push({
			id: 'shell.flag',
			lastSeen: new Date().toISOString(),
			hits: 5,
			match: 'flag',
			inactive: false,
		} as (typeof raw.lessons)[number]);
		await fs.writeFile(file, JSON.stringify(raw, null, 2), 'utf8');
		resetLessonsCacheForTests();
		const lessons = await getExtendedLessons(dir);
		const agedLesson = lessons.find(l => l.id === old.id)!;
		assert(lessonDecayScore(agedLesson) < 0.5, '30-day lesson score below inject threshold');
		assert(
			lessonsForCommand(lessons, 'az account show').every(l => l.id !== old.id),
			'aged lesson not injected'
		);
		const flag = lessons.find(l => l.id === 'shell.flag');
		assert(!!flag?.inactive, 'one-word match inactive');

		// Eviction: fill to MAX then add one more; new lesson survives.
		resetLessonsCacheForTests();
		const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-lesson-evict-'));
		for (let i = 0; i < 40; i++) {
			await recordLesson(dir2, {
				id: `shell.fill-${i}`,
				kind: 'shell',
				title: `fill ${i}`,
				pattern: `cmd ${i}`,
				advice: 'x',
				match: `wordone${i}[\\s\\S]{0,40}wordtwo${i}`,
				hits: 1,
			});
		}
		const fresh = await recordLesson(dir2, {
			id: 'shell.fresh',
			kind: 'shell',
			title: 'fresh',
			pattern: 'new cmd',
			advice: 'y',
			match: 'freshone[\\s\\S]{0,40}freshtwo',
		});
		const all = await getExtendedLessons(dir2);
		assert(all.length <= 40, 'capped at 40');
		assert(all.some(l => l.id === fresh.id), 'new lesson not evicted');
		await fs.rm(dir2, { recursive: true, force: true });
	} finally {
		resetLessonsCacheForTests();
		await fs.rm(dir, { recursive: true, force: true });
	}
	console.log('extendedMemory.selftest: ok');
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
