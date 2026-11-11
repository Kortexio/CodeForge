/**
 * Native web_search / web_fetch — no curl required.
 * web_fetch blocks private/loopback/link-local/metadata hosts (SSRF).
 */

import * as dns from 'dns/promises';
import * as net from 'net';

const MAX_FETCH_CHARS = 40_000;
const MAX_SEARCH_RESULTS = 8;

export interface WebSearchHit {
	title: string;
	url: string;
	snippet: string;
}

function stripTags(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

function decodeDuckUrl(raw: string): string {
	try {
		const u = new URL(raw, 'https://duckduckgo.com');
		const uddg = u.searchParams.get('uddg');
		if (uddg) return decodeURIComponent(uddg);
		return raw.startsWith('http') ? raw : `https://duckduckgo.com${raw}`;
	} catch {
		return raw;
	}
}

/** True when hostname/IP must not be fetched by the agent. */
export function isBlockedFetchHost(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
	if (!host) return true;
	if (
		host === 'localhost' ||
		host === 'metadata.google.internal' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host === '0.0.0.0' ||
		host === '::' ||
		host === '::1'
	) {
		return true;
	}

	if (net.isIP(host)) {
		return isBlockedIp(host);
	}

	return false;
}

export function isBlockedIp(ip: string): boolean {
	const v = ip.trim().toLowerCase();
	if (!net.isIP(v)) return true;

	if (net.isIPv4(v)) {
		const parts = v.split('.').map(n => Number(n));
		const [a, b] = parts;
		if (a === 10) return true;
		if (a === 127) return true;
		if (a === 0) return true;
		if (a === 169 && b === 254) return true; // link-local + cloud metadata
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		if (a >= 224) return true; // multicast / reserved
		return false;
	}

	// IPv6
	if (v === '::1' || v === '::') return true;
	if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
	if (v.startsWith('fe80:')) return true; // link-local
	if (v.startsWith('ff')) return true; // multicast
	// IPv4-mapped IPv6 ::ffff:x.x.x.x
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
	if (mapped) return isBlockedIp(mapped[1]);
	return false;
}

/**
 * Synchronous URL shape + hostname blocklist (before DNS).
 * Returns an error string or undefined when the URL looks publicly fetchable.
 */
export function assertSafeFetchUrlSync(urlArg: string): string | undefined {
	const raw = String(urlArg ?? '').trim();
	if (!/^https?:\/\//i.test(raw)) return 'Error: url must start with http:// or https://';
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return 'Error: invalid url';
	}
	if (parsed.username || parsed.password) {
		return 'Error: url must not include credentials';
	}
	if (isBlockedFetchHost(parsed.hostname)) {
		return `Error: blocked host (SSRF): ${parsed.hostname}`;
	}
	return undefined;
}

/** Resolve DNS and refuse if any address is private/loopback/link-local. */
export async function assertSafeFetchUrl(urlArg: string): Promise<string | undefined> {
	const sync = assertSafeFetchUrlSync(urlArg);
	if (sync) return sync;
	const parsed = new URL(String(urlArg).trim());
	if (net.isIP(parsed.hostname)) {
		return isBlockedIp(parsed.hostname)
			? `Error: blocked host (SSRF): ${parsed.hostname}`
			: undefined;
	}
	try {
		const records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
		if (!records.length) return `Error: could not resolve host: ${parsed.hostname}`;
		for (const rec of records) {
			if (isBlockedIp(rec.address)) {
				return `Error: blocked host (SSRF): ${parsed.hostname} → ${rec.address}`;
			}
		}
	} catch (err) {
		return `Error: DNS lookup failed for ${parsed.hostname}: ${
			err instanceof Error ? err.message : String(err)
		}`;
	}
	return undefined;
}

/** DuckDuckGo HTML results (no API key). */
export async function webSearch(query: string, maxResults = MAX_SEARCH_RESULTS): Promise<string> {
	const q = String(query ?? '').trim();
	if (!q) return 'Error: query is required';
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
	const res = await fetch(url, {
		headers: {
			'User-Agent': 'CodeForgeAgent/0.1 (compatible; +https://github.com/Kortexio/CodeForge)',
			Accept: 'text/html',
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) return `Error: web_search HTTP ${res.status}`;
	const html = await res.text();
	const hits: WebSearchHit[] = [];
	const re =
		/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>)?/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) && hits.length < Math.min(20, Math.max(1, maxResults))) {
		const href = decodeDuckUrl(m[1]);
		const title = stripTags(m[2]).slice(0, 200);
		const snippet = stripTags(m[3] ?? '').slice(0, 280);
		if (!title || !href.startsWith('http')) continue;
		hits.push({ title, url: href, snippet });
	}
	if (!hits.length) {
		// Fallback: DuckDuckGo Instant Answer API
		const ia = await fetch(
			`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`,
			{ signal: AbortSignal.timeout(15_000) }
		);
		if (ia.ok) {
			const data = (await ia.json()) as {
				AbstractText?: string;
				AbstractURL?: string;
				RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
			};
			const lines: string[] = [`Web search: ${q}`, ''];
			if (data.AbstractText) {
				lines.push(`Summary: ${data.AbstractText}`);
				if (data.AbstractURL) lines.push(`URL: ${data.AbstractURL}`);
				lines.push('');
			}
			for (const t of data.RelatedTopics ?? []) {
				if (t.Text && t.FirstURL) lines.push(`- ${t.Text}\n  ${t.FirstURL}`);
			}
			return lines.length > 2 ? lines.join('\n') : `No results for: ${q}`;
		}
		return `No results for: ${q}`;
	}
	return [
		`Web search: ${q}`,
		'',
		...hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`),
	].join('\n');
}

export async function webFetch(urlArg: string, maxChars = MAX_FETCH_CHARS): Promise<string> {
	const blocked = await assertSafeFetchUrl(urlArg);
	if (blocked) return blocked;

	const url = String(urlArg ?? '').trim();
	const res = await fetch(url, {
		headers: {
			'User-Agent': 'CodeForgeAgent/0.1',
			Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
		},
		redirect: 'manual',
		signal: AbortSignal.timeout(25_000),
	});

	// Follow redirects manually so each hop is SSRF-checked.
	let current = res;
	let finalUrl = url;
	for (let hop = 0; hop < 5 && current.status >= 300 && current.status < 400; hop++) {
		const loc = current.headers.get('location');
		if (!loc) break;
		const nextUrl = new URL(loc, finalUrl).toString();
		const hopBlocked = await assertSafeFetchUrl(nextUrl);
		if (hopBlocked) return hopBlocked;
		finalUrl = nextUrl;
		current = await fetch(finalUrl, {
			headers: {
				'User-Agent': 'CodeForgeAgent/0.1',
				Accept:
					'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
			},
			redirect: 'manual',
			signal: AbortSignal.timeout(25_000),
		});
	}

	const ctype = current.headers.get('content-type') ?? '';
	const buf = Buffer.from(await current.arrayBuffer());
	if (!current.ok) {
		return `Error: HTTP ${current.status} ${current.statusText}\n${buf.toString('utf8').slice(0, 2000)}`;
	}
	let text = buf.toString('utf8');
	if (/html/i.test(ctype) || /^\s*</.test(text)) {
		text = stripTags(text);
	}
	const limit = Math.min(MAX_FETCH_CHARS, Math.max(1000, maxChars));
	if (text.length > limit) {
		text = text.slice(0, limit) + `\n…[clipped ${text.length - limit} chars]`;
	}
	return [`URL: ${finalUrl}`, `Status: ${current.status}`, `Content-Type: ${ctype || 'unknown'}`, '', text].join(
		'\n'
	);
}
