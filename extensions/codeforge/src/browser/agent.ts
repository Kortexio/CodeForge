/**
 * Playwright browser tools. One session; headed unless CI/bench or codeforge.ai.browserHeadless.
 */

import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { getArtifactStore } from '../storage/artifacts';
import { formatActionWithObservation, formatPageState, type PageState } from './observe';
import {
	captureState,
	clickTarget,
	closeTab,
	ensurePage,
	fillTarget,
	headlessFromEnv,
	listTabs,
	loadPlaywright,
	openTab,
	publishMirror,
	refreshRefs,
	rememberPlaywrightMissing,
	resetBrowserSession,
	stashVision,
	switchTab,
	activePage,
} from './session';

export interface BrowserSnapshot {
	url: string;
	title: string;
	text: string;
	issues?: string;
	refs?: string;
}

export function browserHeadless(): boolean {
	if (headlessFromEnv()) return true;
	try {
		return vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('browserHeadless') === true;
	} catch {
		return false;
	}
}

export async function warnIfPlaywrightMissing(): Promise<void> {
	try {
		await loadPlaywright();
	} catch (err) {
		if (!rememberPlaywrightMissing()) return;
		const message = err instanceof Error ? err.message : String(err);
		try {
			void vscode.window.showWarningMessage(message);
		} catch {
			/* headless */
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function page() {
	return ensurePage(browserHeadless());
}

export async function browserNavigate(url: string): Promise<string> {
	const p = await page();
	const before = await captureState().catch(
		(): PageState => ({ url: '', title: '', text: '' })
	);
	await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await delay(200);
	const after = await captureState();
	const refs = await refreshRefs(p);
	await publishMirror();
	const body = formatActionWithObservation({
		actionLine: `Navigated to ${after.url} — title: ${after.title}`,
		before,
		after,
		warnIfUnchanged: false,
	});
	return refs ? `${body}\n\n${refs}` : body;
}

export async function browserSnapshot(): Promise<BrowserSnapshot> {
	const p = await page();
	const state = await captureState();
	const refs = await refreshRefs(p);
	return {
		url: state.url,
		title: state.title,
		text: state.text,
		issues: state.issues,
		refs,
	};
}

export async function browserClick(selector: string): Promise<string> {
	const p = await page();
	const before = await captureState();
	await clickTarget(p, selector);
	await delay(350);
	const after = await captureState();
	await publishMirror();
	return formatActionWithObservation({
		actionLine: `Clicked ${selector}.`,
		before,
		after,
		warnIfUnchanged: true,
	});
}

export async function browserType(selector: string, text: string): Promise<string> {
	const p = await page();
	const before = await captureState();
	await fillTarget(p, selector, text);
	await delay(200);
	const after = await captureState();
	await publishMirror();
	return formatActionWithObservation({
		actionLine: `Typed into ${selector}.`,
		before,
		after,
		warnIfUnchanged: true,
	});
}

export async function browserScreenshot(sessionId?: string): Promise<string> {
	const p = await page();
	const buf = await p.screenshot({ fullPage: false, type: 'png' });
	stashVision(buf);
	const artifact = await getArtifactStore().create(
		'screenshot',
		`browser-${Date.now()}.png`,
		buf,
		sessionId
	);
	await publishMirror(buf);
	const after = await captureState();
	return [
		`Screenshot saved as artifact ${artifact.id} (${artifact.bytes} bytes) at ${artifact.path}`,
		'',
		'### After (page state)',
		formatPageState(after, 4000),
	].join('\n');
}

export async function browserScroll(dy: number): Promise<string> {
	const p = await page();
	const before = await captureState();
	if (!p.mouse?.wheel) throw new Error('This Playwright build has no mouse.wheel');
	await p.mouse.wheel(0, dy);
	await delay(200);
	const after = await captureState();
	return formatActionWithObservation({
		actionLine: `Scrolled by ${dy} px.`,
		before,
		after,
		warnIfUnchanged: true,
	});
}

export async function browserPressKey(key: string): Promise<string> {
	const p = await page();
	const before = await captureState();
	if (!p.keyboard?.press) throw new Error('This Playwright build has no keyboard.press');
	await p.keyboard.press(key);
	await delay(200);
	const after = await captureState();
	return formatActionWithObservation({
		actionLine: `Pressed ${key}.`,
		before,
		after,
		warnIfUnchanged: true,
	});
}

export async function browserHover(selector: string): Promise<string> {
	const p = await page();
	const before = await captureState();
	if (!p.hover) throw new Error('This Playwright build has no hover');
	await p.hover(selector);
	await delay(150);
	const after = await captureState();
	return formatActionWithObservation({
		actionLine: `Hovered ${selector}.`,
		before,
		after,
		warnIfUnchanged: false,
	});
}

export async function browserSelectOption(selector: string, value: string): Promise<string> {
	const p = await page();
	const before = await captureState();
	if (!p.selectOption) throw new Error('This Playwright build has no selectOption');
	await p.selectOption(selector, value);
	await delay(200);
	const after = await captureState();
	return formatActionWithObservation({
		actionLine: `Selected ${value} in ${selector}.`,
		before,
		after,
		warnIfUnchanged: true,
	});
}

export async function browserWait(ms: number): Promise<string> {
	const p = await page();
	const wait = Math.min(10_000, Math.max(0, ms));
	if (p.waitForTimeout) await p.waitForTimeout(wait);
	else await delay(wait);
	const after = await captureState();
	return `Waited ${wait} ms.\n\n### After (page state)\n${formatPageState(after, 4000)}`;
}

export async function browserTabs(action: string, id?: string): Promise<string> {
	const act = action.trim().toLowerCase();
	if (act === 'list' || !act) {
		await page();
		return listTabs().join('\n') || '(no tabs)';
	}
	if (act === 'new') {
		const created = await openTab(browserHeadless());
		await publishMirror();
		return `Opened ${created}`;
	}
	if (act === 'switch') {
		if (!id) return 'Error: id is required to switch tabs';
		await switchTab(id);
		const after = await captureState();
		await publishMirror();
		return `Switched to ${id}.\n\n### After (page state)\n${formatPageState(after, 2000)}`;
	}
	if (act === 'close') {
		if (!id) return 'Error: id is required to close a tab';
		await closeTab(id);
		return `Closed ${id}`;
	}
	return `Error: unknown tabs action ${action}`;
}

export async function browserClose(): Promise<string> {
	await resetBrowserSession();
	return 'Browser closed.';
}

export function browserHasPage(): boolean {
	return activePage() !== null;
}

/** Persist a text snapshot as an artifact (no Playwright required). */
export async function saveTextSnapshot(name: string, content: string, sessionId?: string): Promise<string> {
	const artifact = await getArtifactStore().create('snapshot', name, content, sessionId);
	await fs.access(artifact.path);
	return `Saved snapshot artifact ${artifact.id}`;
}
