/**
 * Editor-group mirror of the Playwright session: URL and the last screenshot.
 * It does not load the site in an iframe (that would be a second browser).
 */

import * as vscode from 'vscode';
import { onBrowserMirror, type MirrorFrame } from './session';

let panel: vscode.WebviewPanel | undefined;

function html(frame: MirrorFrame): string {
	const img = frame.png
		? `<img alt="Page mirror" src="data:image/png;base64,${frame.png.toString('base64')}" />`
		: '<p>No screenshot yet. The headed Chromium window is the live page.</p>';
	const url = frame.url.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
	const title = frame.title.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
	return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#1e1e1e;color:#ddd">
<p><strong>${title || 'Browser'}</strong></p>
<p>${url || '(no url)'}</p>
${img}
</body></html>`;
}

function show(frame: MirrorFrame): void {
	if (!panel) {
		panel = vscode.window.createWebviewPanel(
			'codeforge.browserMirror',
			'CodeForge Browser',
			vscode.ViewColumn.One,
			{ enableScripts: false }
		);
		panel.onDidDispose(() => {
			panel = undefined;
		});
	}
	panel.webview.html = html(frame);
	panel.reveal(vscode.ViewColumn.One, true);
}

export function registerBrowserMirror(): vscode.Disposable {
	onBrowserMirror(show);
	return {
		dispose() {
			panel?.dispose();
			panel = undefined;
		},
	};
}
