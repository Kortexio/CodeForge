/**
 * Compile-time check: evaluate _getHtmlContent template and parse the embedded <script>.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const root = path.dirname(fileURLToPath(import.meta.url));
const jsPath = path.join(root, '../out/views/chatView.js');
const js = fs.readFileSync(jsPath, 'utf8');

const start = js.indexOf('return `<!DOCTYPE html>');
if (start < 0) {
	console.error('Could not find HTML template in chatView.js');
	process.exit(1);
}

// Walk the template literal and evaluate it as a JS expression.
let i = start + 'return '.length;
let depth = 0;
let end = -1;
for (let p = i; p < js.length; p++) {
	const ch = js[p];
	const prev = js[p - 1];
	if (ch === '`' && prev !== '\\') {
		if (depth === 0 && p > i) {
			// closing backtick of the outer template
			end = p;
			break;
		}
	}
	// ignore nested for this simple extract — template has no nested backticks for script
}
if (end < 0) {
	console.error('Could not find end of HTML template');
	process.exit(1);
}

const templateExpr = js.slice(i, end + 1);
let html;
try {
	html = vm.runInNewContext(templateExpr, {}, { timeout: 2000 });
} catch (err) {
	console.error('Failed to evaluate HTML template:', err.message);
	process.exit(1);
}

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
	console.error('No <script> in HTML');
	process.exit(1);
}
const script = scriptMatch[1];

// Detect accidental real newlines inside regex literals (common template bug)
const broken = [];
for (const m of script.matchAll(/\/(?:\\.|[^/\n\r])+\/[gimsuy]*/g)) {
	/* ok */
}
// Broader: any / ... / that spans lines
for (const m of script.matchAll(/\/[\s\S]*?\//g)) {
	if (m[0].includes('\n') || m[0].includes('\r')) {
		broken.push(m[0].slice(0, 60).replace(/\n/g, '\\n'));
	}
}

try {
	new vm.Script(script, { filename: 'webview.js' });
	console.log('OK: webview script parses');
} catch (err) {
	console.error('FAIL: webview script SyntaxError:', err.message);
	const lines = script.split(/\n/);
	const lineNo = Number(String(err.stack).match(/webview\.js:(\d+)/)?.[1] || 0);
	if (lineNo) {
		for (let L = Math.max(1, lineNo - 2); L <= Math.min(lines.length, lineNo + 2); L++) {
			console.error((L === lineNo ? '>' : ' ') + L + ': ' + lines[L - 1]);
		}
	}
	process.exit(1);
}

if (broken.length) {
	console.warn('WARN: possible multiline regex literals:', broken.length);
}
console.log('html bytes', html.length, 'script bytes', script.length);
