/**
 * Optional Playwright-based browser agent.
 */

import * as fs from 'fs/promises';
import { getArtifactStore } from '../storage/artifacts';

export interface BrowserSnapshot {
	url: string;
	title: string;
	text: string;
}

type PlaywrightModule = {
	chromium: {
		launch: (opts?: { headless?: boolean }) => Promise<BrowserLike>;
	};
};

interface BrowserLike {
	newPage: () => Promise<PageLike>;
	close: () => Promise<void>;
}

interface PageLike {
	goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
	title: () => Promise<string>;
	url: () => string;
	content: () => Promise<string>;
	innerText: (sel: string) => Promise<string>;
	click: (sel: string) => Promise<void>;
	fill: (sel: string, value: string) => Promise<void>;
	screenshot: (opts?: { path?: string; fullPage?: boolean; type?: string }) => Promise<Buffer>;
	close: () => Promise<void>;
}

let browser: BrowserLike | null = null;
let page: PageLike | null = null;

async function loadPlaywright(): Promise<PlaywrightModule> {
	try {
		// Optional dependency — not bundled by default
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require('playwright') as PlaywrightModule;
	} catch {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			return require('playwright-core') as PlaywrightModule;
		} catch {
			throw new Error(
				'Playwright is not installed. Run `npm i playwright` in the extension folder, or use an MCP browser server.'
			);
		}
	}
}

async function ensurePage(headless = true): Promise<PageLike> {
	if (page) return page;
	const pw = await loadPlaywright();
	browser = await pw.chromium.launch({ headless });
	page = await browser.newPage();
	return page;
}

export async function browserNavigate(url: string): Promise<string> {
	const p = await ensurePage();
	await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	return `Navigated to ${p.url()} — title: ${await p.title()}`;
}

export async function browserSnapshot(): Promise<BrowserSnapshot> {
	const p = await ensurePage();
	let text = '';
	try {
		text = await p.innerText('body');
	} catch {
		text = (await p.content()).replace(/<[^>]+>/g, ' ').slice(0, 8000);
	}
	return {
		url: p.url(),
		title: await p.title(),
		text: text.slice(0, 12_000),
	};
}

export async function browserClick(selector: string): Promise<string> {
	const p = await ensurePage();
	await p.click(selector);
	return `Clicked ${selector}`;
}

export async function browserType(selector: string, text: string): Promise<string> {
	const p = await ensurePage();
	await p.fill(selector, text);
	return `Typed into ${selector}`;
}

export async function browserScreenshot(sessionId?: string): Promise<string> {
	const p = await ensurePage();
	const buf = await p.screenshot({ fullPage: true, type: 'png' });
	const artifact = await getArtifactStore().create(
		'screenshot',
		`browser-${Date.now()}.png`,
		buf,
		sessionId
	);
	return `Screenshot saved as artifact ${artifact.id} (${artifact.bytes} bytes) at ${artifact.path}`;
}

export async function browserClose(): Promise<void> {
	try {
		await page?.close();
	} catch {
		/* ignore */
	}
	try {
		await browser?.close();
	} catch {
		/* ignore */
	}
	page = null;
	browser = null;
}

/** Persist a text snapshot as an artifact (no Playwright required). */
export async function saveTextSnapshot(name: string, content: string, sessionId?: string): Promise<string> {
	const artifact = await getArtifactStore().create('snapshot', name, content, sessionId);
	await fs.access(artifact.path);
	return `Saved snapshot artifact ${artifact.id}`;
}
