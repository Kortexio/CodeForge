import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	learnFromShellFailure,
	lessonFromFailure,
	lessonsForText,
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
		const { getExtendedLessons } = await import(
			'../../extensions/codeforge/src/memory/extendedMemory'
		);
		const all = await getExtendedLessons(dir);
		expect(lessonsForText(all, 'please list files')).toEqual([]);
		expect(lessonsForText(all, ambiguousAd).map(l => l.id)).toEqual([
			lessonFromFailure('git log --format="%h %an"', ambiguousAn).id,
		]);
	});
});
