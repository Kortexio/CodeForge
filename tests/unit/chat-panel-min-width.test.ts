import * as fs from 'fs';
import * as path from 'path';
import { getChatViewHtml } from '../../extensions/codeforge/src/views/chatViewHtml';

const root = path.resolve(__dirname, '../..');

describe('AI chat panel minimum width', () => {
	it('keeps the Auxiliary Bar sash from crushing the composer (360px)', () => {
		const patchScript = fs.readFileSync(
			path.join(root, 'scripts/apply-vscode-patches.mjs'),
			'utf8'
		);
		expect(patchScript).toContain('Auxiliary Bar min width for AI chat');
		expect(patchScript).toContain('CodeForge: 360px keeps mode/model/permissions chips + send on one row.');
		expect(patchScript).toContain('override readonly minimumWidth: number = 360;');
		expect(patchScript).toContain('return Math.max(width, 360);');

		const partPath = path.join(
			root,
			'vscode/src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts'
		);
		if (fs.existsSync(partPath)) {
			const part = fs.readFileSync(partPath, 'utf8');
			expect(part).toContain('CodeForge: 360px');
			expect(part).toMatch(/minimumWidth:\s*number\s*=\s*360/);
			expect(part).not.toMatch(/minimumWidth:\s*number\s*=\s*170/);
		}
	});

	it('pins send on the right like Cursor while chips shrink on the left', () => {
		const html = getChatViewHtml({
			cspSource: 'vscode-resource:',
			cspNonce: 'test',
			markedJs: '',
			hljsJs: '',
			dompurifyJs: '',
			hljsCss: '',
			katexJs: '',
			katexCss: '',
			katexAutoRenderJs: '',
			mermaidJs: '',
		});
		expect(html).toMatch(/\.composer-actions\s*\{[^}]*flex-wrap:\s*nowrap/);
		expect(html).toMatch(/\.composer-actions-main\s*\{[^}]*flex:\s*1 1 auto/);
		expect(html).toMatch(/\.composer-actions-end\s*\{[^}]*margin-left:\s*auto/);
		expect(html).toMatch(/composer-actions-main[\s\S]*id="attachBtn"[\s\S]*composer-actions-end[\s\S]*id="sendButton"/);
		expect(html).not.toMatch(/\.composer-actions\s*\{[^}]*flex-wrap:\s*wrap/);
	});
});
