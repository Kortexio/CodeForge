import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	getExtendedLessons,
	learnFromShellFailure,
	learnFromShellSuccess,
	lessonDecayScore,
	lessonFromFailure,
	lessonsForCommand,
	lessonsForText,
	recordLesson,
	resetLessonsCacheForTests,
} from '../../extensions/codeforge/src/memory/extendedMemory';

const ambiguousAn = [
	'exit 128',
	"fatal: ambiguous argument '%an': unknown revision or path not in the working tree.",
].join('\n');

const ambiguousAd = [
	'exit 128',
	"fatal: ambiguous argument '%ad': unknown revision or path not in the working tree.",
].join('\n');

describe('dynamic shell lessons', () => {
	let dir: string;

	beforeEach(async () => {
		resetLessonsCacheForTests();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-lessons-'));
	});

	afterEach(async () => {
		resetLessonsCacheForTests();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('gives the same id to the same error with different percent tokens', () => {
		const a = lessonFromFailure('git log --format="%h %an"', ambiguousAn);
		const b = lessonFromFailure('git log --format="%h %ad"', ambiguousAd);
		expect(a.id).toBe(b.id);
		expect(a.id.startsWith('shell.')).toBe(true);
		expect(a.advice).toContain('ambiguous argument');
	});

	it('records a lesson for an unrecognized failure and reinforces it', async () => {
		const first = await learnFromShellFailure(dir, 'git log --format="%h %an"', ambiguousAn);
		const second = await learnFromShellFailure(dir, 'git log --format="%h %ad %s"', ambiguousAd);
		expect(first?.lesson.hits).toBe(1);
		expect(second?.lesson.id).toBe(first?.lesson.id);
		expect(second?.lesson.hits).toBe(2);
		expect(second?.adviceBlock).toContain('Seen 2 times');

		const file = JSON.parse(
			await fs.readFile(path.join(dir, '.CodeForge', 'memory', 'lessons.json'), 'utf8')
		);
		expect(file.lessons).toHaveLength(1);
		expect(file.lessons.some((l: { id: string }) => l.id === 'shell.unix-tail')).toBe(false);
	});

	it('learns a build error without a hardcoded tag', async () => {
		const output = 'error CS0246: The type or namespace name Foo could not be found';
		const learned = await learnFromShellFailure(dir, 'dotnet build app.csproj', output);
		expect(learned?.lesson.id.startsWith('shell.')).toBe(true);
		expect(learned?.lesson.hits).toBe(1);
		const again = await learnFromShellFailure(dir, 'dotnet build other.csproj', output);
		expect(again?.lesson.id).toBe(learned?.lesson.id);
		expect(again?.lesson.hits).toBe(2);
	});

	it('puts a learned lesson back when the text matches', async () => {
		await learnFromShellFailure(dir, 'git log --format="%h %an"', ambiguousAn);
		const all = await getExtendedLessons(dir);
		expect(lessonsForText(all, 'please list files')).toEqual([]);
		expect(lessonsForText(all, ambiguousAd).map(l => l.id)).toEqual([
			lessonFromFailure('git log --format="%h %an"', ambiguousAn).id,
		]);
	});

	it('unlearns on success of the same command signature', async () => {
		const learned = await learnFromShellFailure(
			dir,
			'az account show',
			'error: subscription not found in tenant'
		);
		expect(learned).toBeTruthy();
		const cleared = await learnFromShellSuccess(dir, 'az account show');
		expect(cleared?.id).toBe(learned!.lesson.id);
		const all = await getExtendedLessons(dir);
		expect(all.find(l => l.id === learned!.lesson.id)).toBeUndefined();
	});

	it('keeps a new lesson when the store is already full', async () => {
		for (let i = 0; i < 40; i++) {
			await recordLesson(dir, {
				id: `shell.fill-${i}`,
				kind: 'shell',
				title: `fill ${i}`,
				pattern: `cmd ${i}`,
				advice: 'x',
				match: `alpha${i}[\\s\\S]{0,40}beta${i}`,
			});
		}
		const fresh = await recordLesson(dir, {
			id: 'shell.fresh',
			kind: 'shell',
			title: 'fresh',
			pattern: 'new',
			advice: 'y',
			match: 'freshone[\\s\\S]{0,40}freshtwo',
		});
		const all = await getExtendedLessons(dir);
		expect(all.length).toBeLessThanOrEqual(40);
		expect(all.some(l => l.id === fresh.id)).toBe(true);
	});

	it('does not inject aged or one-word-match lessons', async () => {
		const old = await recordLesson(dir, {
			id: 'shell.old',
			kind: 'shell',
			title: 'old',
			pattern: 'az login',
			advice: 'retry',
			match: 'azure[\\s\\S]{0,40}login',
			hits: 2,
		});
		const file = path.join(dir, '.CodeForge', 'memory', 'lessons.json');
		const raw = JSON.parse(await fs.readFile(file, 'utf8')) as {
			lessons: Array<{ id: string; lastSeen: string; match?: string; hits: number }>;
		};
		for (const l of raw.lessons) {
			if (l.id === old.id) {
				l.lastSeen = new Date(Date.now() - 30 * 86_400_000).toISOString();
			}
		}
		raw.lessons.push({
			id: 'shell.flag',
			lastSeen: new Date().toISOString(),
			hits: 5,
			match: 'flag',
		});
		await fs.writeFile(file, JSON.stringify(raw, null, 2), 'utf8');
		resetLessonsCacheForTests();
		const all = await getExtendedLessons(dir);
		expect(lessonDecayScore(all.find(l => l.id === old.id)!)).toBeLessThan(0.5);
		expect(lessonsForCommand(all, 'az login').map(l => l.id)).not.toContain(old.id);
		expect(all.find(l => l.id === 'shell.flag')?.inactive).toBe(true);
	});
});
