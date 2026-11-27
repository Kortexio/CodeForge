/**
 * Single Playwright session. The headed Chromium window is the page the user sees.
 * The editor panel only mirrors URL + last screenshot (it does not navigate a second browser).
 */

import { formatPageState, type PageState } from './observe';
import { setPendingVision } from './visionHandoff';

export interface BrowserIssue {
	kind: 'console' | 'pageerror' | 'requestfailed';
	text: string;
}

export interface A11yRef {
	role: string;
	name: string;
}

type ConsoleMessageLike = { type?: () => string; text?: () => string };
type RequestLike = { url?: () => string; failure?: () => { errorText?: string } | null };

export interface PageLike {
	goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
	title: () => Promise<string>;
	url: () => string;
	content: () => Promise<string>;
	innerText: (sel: string) => Promise<string>;
	click: (sel: string) => Promise<void>;
	fill: (sel: string, value: string) => Promise<void>;
	screenshot: (opts?: { fullPage?: boolean; type?: string }) => Promise<Buffer>;
	close: () => Promise<void>;
	on?: (event: string, cb: (arg: unknown) => void) => void;
	hover?: (sel: string) => Promise<void>;
	selectOption?: (sel: string, value: string) => Promise<unknown>;
	waitForTimeout?: (ms: number) => Promise<void>;
	keyboard?: { press: (key: string) => Promise<void> };
	mouse?: { wheel: (dx: number, dy: number) => Promise<void> };
	getByRole?: (role: string, opts?: { name?: string }) => {
		click: () => Promise<void>;
		fill: (text: string) => Promise<void>;
	};
	accessibility?: { snapshot: (opts?: { interestingOnly?: boolean }) => Promise<unknown> };
	context?: () => { newPage: () => Promise<PageLike>; browser?: () => { close: () => Promise<void> } };
}

interface BrowserLike {
	newPage: () => Promise<PageLike>;
	close: () => Promise<void>;
}

type PlaywrightModule = {
	chromium: {
		launch: (opts?: { headless?: boolean }) => Promise<BrowserLike>;
	};
};

export interface MirrorFrame {
	url: string;
	title: string;
	png?: Buffer;
}

let browser: BrowserLike | null = null;
let pages = new Map<string, PageLike>();
let activeId = '';
let tabSeq = 0;
const issues: BrowserIssue[] = [];
const refs = new Map<string, A11yRef>();
let mirrorListener: ((frame: MirrorFrame) => void) | undefined;
let playwrightWarned = false;

export function onBrowserMirror(listener: (frame: MirrorFrame) => void): void {
	mirrorListener = listener;
}

export function browserIssues(): BrowserIssue[] {
	return issues.slice();
}

export function clearBrowserIssues(): void {
	issues.length = 0;
}

export function headlessFromEnv(): boolean {
	return (
		process.env.CI === 'true' ||
		process.env.CODEFORGE_HEADLESS === '1' ||
		process.env.CODEFORGE_BENCH === '1'
	);
}

export function rememberPlaywrightMissing(): boolean {
	if (playwrightWarned) return false;
	playwrightWarned = true;
	return true;
}

export async function loadPlaywright(): Promise<PlaywrightModule> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires -- optional runtime dependency
		return require('playwright') as PlaywrightModule;
	} catch {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires -- optional runtime dependency
			return require('playwright-core') as PlaywrightModule;
		} catch {
			throw new Error(
				'Playwright is not installed. Run `npm i playwright` in the extension folder, or use an MCP browser server. Prefer native browser_* tools once Playwright loads.'
			);
		}
	}
}

function pushIssue(kind: BrowserIssue['kind'], text: string): void {
	const line = text.replace(/\s+/g, ' ').trim().slice(0, 300);
	if (!line) return;
	issues.push({ kind, text: line });
	if (issues.length > 40) issues.shift();
}

function attachListeners(page: PageLike): void {
	page.on?.('console', arg => {
		const msg = arg as ConsoleMessageLike;
		const type = typeof msg.type === 'function' ? msg.type() : '';
		if (type !== 'error' && type !== 'warning') return;
		const text = typeof msg.text === 'function' ? msg.text() : String(arg);
		pushIssue('console', `${type}: ${text}`);
	});
	page.on?.('pageerror', arg => {
		pushIssue('pageerror', arg instanceof Error ? arg.message : String(arg));
	});
	page.on?.('requestfailed', arg => {
		const req = arg as RequestLike;
		const url = typeof req.url === 'function' ? req.url() : '';
		const fail = typeof req.failure === 'function' ? req.failure()?.errorText : '';
		pushIssue('requestfailed', `${fail || 'failed'} ${url}`.trim());
	});
}

function issueText(): string {
	if (!issues.length) return '';
	return issues
		.slice(-12)
		.map(i => `- ${i.kind}: ${i.text}`)
		.join('\n');
}

export function activePage(): PageLike | null {
	return pages.get(activeId) ?? null;
}

export async function ensurePage(headless: boolean): Promise<PageLike> {
	const existing = activePage();
	if (existing) return existing;
	const pw = await loadPlaywright();
	browser = await pw.chromium.launch({ headless });
	const page = await browser.newPage();
	attachListeners(page);
	tabSeq += 1;
	activeId = `tab-${tabSeq}`;
	pages.set(activeId, page);
	return page;
}

export async function resetBrowserSession(): Promise<void> {
	for (const page of pages.values()) {
		try {
			await page.close();
		} catch {
			/* ignore */
		}
	}
	try {
		await browser?.close();
	} catch {
		/* ignore */
	}
	pages = new Map();
	browser = null;
	activeId = '';
	refs.clear();
	issues.length = 0;
}

async function readText(page: PageLike): Promise<string> {
	try {
		return await page.innerText('body');
	} catch {
		return (await page.content()).replace(/<[^>]+>/g, ' ').slice(0, 8000);
	}
}

export async function captureState(): Promise<PageState> {
	const page = activePage();
	if (!page) return { url: '', title: '', text: '', issues: issueText() };
	let text = '';
	try {
		text = await readText(page);
	} catch {
		text = '';
	}
	let title = '';
	try {
		title = await page.title();
	} catch {
		title = '';
	}
	return {
		url: page.url(),
		title,
		text: text.slice(0, 12_000),
		issues: issueText(),
	};
}

export function formatState(state: PageState): string {
	return formatPageState(state);
}

function emitMirror(url: string, title: string, png?: Buffer): void {
	try {
		mirrorListener?.({ url, title, png });
	} catch {
		/* panel failures must not fail the tool */
	}
}

export async function publishMirror(png?: Buffer): Promise<void> {
	const state = await captureState();
	emitMirror(state.url, state.title, png);
}

function walkA11y(node: unknown, out: Array<A11yRef & { id: string }>): void {
	if (!node || typeof node !== 'object') return;
	const row = node as { role?: string; name?: string; children?: unknown[] };
	if (row.role && row.name) {
		out.push({ id: `e${out.length + 1}`, role: String(row.role), name: String(row.name) });
	}
	for (const child of row.children ?? []) walkA11y(child, out);
}

export async function refreshRefs(page: PageLike): Promise<string> {
	refs.clear();
	if (!page.accessibility?.snapshot) return '';
	let tree: unknown;
	try {
		tree = await page.accessibility.snapshot({ interestingOnly: true });
	} catch {
		return '';
	}
	const flat: Array<A11yRef & { id: string }> = [];
	walkA11y(tree, flat);
	const lines: string[] = [];
	for (const item of flat.slice(0, 40)) {
		refs.set(item.id, { role: item.role, name: item.name });
		lines.push(`- @${item.id} ${item.role} "${item.name}"`);
	}
	return lines.length ? ['Accessibility refs:', ...lines].join('\n') : '';
}

export function refTarget(token: string): A11yRef | undefined {
	const id = token.trim().replace(/^@/, '');
	return refs.get(id);
}

export async function clickTarget(page: PageLike, target: string): Promise<void> {
	const ref = target.startsWith('@') ? refTarget(target) : undefined;
	if (ref && page.getByRole) {
		await page.getByRole(ref.role, { name: ref.name }).click();
		return;
	}
	await page.click(target);
}

export async function fillTarget(page: PageLike, target: string, text: string): Promise<void> {
	const ref = target.startsWith('@') ? refTarget(target) : undefined;
	if (ref && page.getByRole) {
		await page.getByRole(ref.role, { name: ref.name }).fill(text);
		return;
	}
	await page.fill(target, text);
}

export function stashVision(png: Buffer): void {
	if (png.length > 1_500_000) {
		setPendingVision(undefined);
		return;
	}
	setPendingVision(`data:image/png;base64,${png.toString('base64')}`);
}

export function listTabs(): string[] {
	return [...pages.keys()].map(id => (id === activeId ? `${id} (active)` : id));
}

export async function openTab(headless: boolean): Promise<string> {
	await ensurePage(headless);
	if (!browser) throw new Error('Browser is not open');
	const page = await browser.newPage();
	attachListeners(page);
	tabSeq += 1;
	const id = `tab-${tabSeq}`;
	pages.set(id, page);
	activeId = id;
	return id;
}

export async function switchTab(id: string): Promise<void> {
	if (!pages.has(id)) throw new Error(`Unknown tab ${id}`);
	activeId = id;
}

export async function closeTab(id: string): Promise<void> {
	const page = pages.get(id);
	if (!page) throw new Error(`Unknown tab ${id}`);
	await page.close();
	pages.delete(id);
	if (activeId === id) {
		activeId = [...pages.keys()][0] ?? '';
	}
	if (!pages.size) await resetBrowserSession();
}
