import { isRedTestFailure, lessonFromFailure } from './extendedMemory';

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

console.log('extendedMemory.selftest: ok');
