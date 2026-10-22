/**
 * Shell cd-normalization checks (run via node after compile).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPathInsideWorkspace, prepareWindowsCommand } from './shellPrep';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shell-'));
const sub = path.join(root, 'sub');
fs.mkdirSync(sub);

const ok = prepareWindowsCommand('cd sub && echo hi', root);
assert(!('notRun' in ok && ok.notRun), 'existing subdir runs');
if (!('notRun' in ok && ok.notRun)) {
	assert(ok.cwd === sub, 'cwd is subfolder');
}

const missing = prepareWindowsCommand('cd nowhere && echo hi', root);
assert('notRun' in missing && missing.notRun === true, 'missing cd target does not run');
assert(
	'message' in missing && String(missing.message).includes('does not exist'),
	'missing cd message'
);

const outside = prepareWindowsCommand('cd .. && echo hi', root);
assert('notRun' in outside && outside.notRun === true, 'outside workspace cd does not run');

assert(isPathInsideWorkspace(root, sub), 'sub inside workspace');
assert(!isPathInsideWorkspace(root, path.dirname(root)), 'parent outside workspace');

fs.rmSync(root, { recursive: true, force: true });

console.log('shellPrep ok');
