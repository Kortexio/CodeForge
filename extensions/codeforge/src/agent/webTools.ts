/**
 * Native web_search / web_fetch — no curl required.
 */

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
	const url = String(urlArg ?? '').trim();
	if (!/^https?:\/\//i.test(url)) return 'Error: url must start with http:// or https://';
	const res = await fetch(url, {
		headers: {
			'User-Agent': 'CodeForgeAgent/0.1',
			Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
		},
		redirect: 'follow',
		signal: AbortSignal.timeout(25_000),
	});
	const ctype = res.headers.get('content-type') ?? '';
	const buf = Buffer.from(await res.arrayBuffer());
	if (!res.ok) {
		return `Error: HTTP ${res.status} ${res.statusText}\n${buf.toString('utf8').slice(0, 2000)}`;
	}
	let text = buf.toString('utf8');
	if (/html/i.test(ctype) || /^\s*</.test(text)) {
		text = stripTags(text);
	}
	const limit = Math.min(MAX_FETCH_CHARS, Math.max(1000, maxChars));
	if (text.length > limit) {
		text = text.slice(0, limit) + `\n…[clipped ${text.length - limit} chars]`;
	}
	return [`URL: ${url}`, `Status: ${res.status}`, `Content-Type: ${ctype || 'unknown'}`, '', text].join('\n');
}
