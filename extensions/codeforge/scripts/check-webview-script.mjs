/**
 * Parse-check the Agent webview script from the compiled chatViewHtml.js template.
 * (scripts/check-webview-html.mjs still points at the old chatView.js location.)
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const jsPath = path.join(root, '../out/views/chatViewHtml.js');
const js = fs.readFileSync(jsPath, 'utf8');

const marker = 'return `<!DOCTYPE html>';
const start = js.indexOf(marker);
if (start < 0) {
	console.error('Could not find HTML template in chatViewHtml.js');
	process.exit(1);
}
const exprStart = start + 'return '.length;
let end = -1;
for (let p = exprStart + 1; p < js.length; p++) {
	if (js[p] === '`' && js[p - 1] !== '\\') {
		end = p;
		break;
	}
}
if (end < 0) {
	console.error('Could not find end of HTML template');
	process.exit(1);
}

const assets = {
	cspSource: 'x',
	cspNonce: 'n',
	markedJs: '',
	hljsJs: '',
	dompurifyJs: '',
	hljsCss: '',
	katexJs: '',
	katexCss: '',
	katexAutoRenderJs: '',
	mermaidJs: '',
};
let html;
try {
	html = vm.runInNewContext(js.slice(exprStart, end + 1), { assets }, { timeout: 2000 });
} catch (err) {
	console.error('Failed to evaluate HTML template:', err.message);
	process.exit(1);
}

const script = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)?.[1];
if (!script) {
	console.error('No <script> in HTML');
	process.exit(1);
}

try {
	new vm.Script(script, { filename: 'webview.js' });
	console.log(`OK: webview script parses (html ${html.length} bytes, script ${script.length} bytes)`);
} catch (err) {
	console.error('FAIL: webview script SyntaxError:', err.message);
	process.exit(1);
}
