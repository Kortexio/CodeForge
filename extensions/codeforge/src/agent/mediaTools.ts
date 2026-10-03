/**
 * generate_image + canvas_write (lightweight Canvas stand-in).
 * Voice is not implemented — tool returns guidance.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDir } from '../storage/paths';

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** SVG poster from prompt when no image API is configured. */
function svgFromPrompt(prompt: string, width = 1024, height = 1024): string {
	const lines = prompt.trim().slice(0, 280).split(/\s+/);
	const wrapped: string[] = [];
	let row = '';
	for (const w of lines) {
		if ((row + ' ' + w).trim().length > 36) {
			wrapped.push(row.trim());
			row = w;
		} else row = (row + ' ' + w).trim();
	}
	if (row) wrapped.push(row);
	const text = wrapped
		.slice(0, 8)
		.map((t, i) => `<text x="50%" y="${42 + i * 7}%" text-anchor="middle" fill="#e8e6e3" font-size="28" font-family="Georgia, serif">${escapeXml(t)}</text>`)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a2332"/>
      <stop offset="100%" stop-color="#3d5a4c"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  ${text}
</svg>
`;
}

export async function generateImage(opts: {
	workspaceRoot?: string;
	prompt: string;
	filename?: string;
	/** Optional OpenAI-compatible images endpoint + key */
	apiBaseUrl?: string;
	apiKey?: string;
}): Promise<string> {
	const prompt = String(opts.prompt ?? '').trim();
	if (!prompt) return 'Error: prompt is required';
	const root = opts.workspaceRoot || process.cwd();
	const dir = path.join(root, '.CodeForge', 'artifacts', 'images');
	await ensureDir(dir);
	const base = (opts.filename || `img-${Date.now()}`).replace(/[^\w.-]+/g, '_');

	if (opts.apiKey && opts.apiBaseUrl) {
		try {
			const endpoint = opts.apiBaseUrl.replace(/\/$/, '') + '/images/generations';
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${opts.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: 'dall-e-3',
					prompt,
					n: 1,
					size: '1024x1024',
					response_format: 'b64_json',
				}),
				signal: AbortSignal.timeout(120_000),
			});
			if (res.ok) {
				const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
				const b64 = data.data?.[0]?.b64_json;
				if (b64) {
					const file = path.join(dir, base.endsWith('.png') ? base : `${base}.png`);
					await fs.writeFile(file, Buffer.from(b64, 'base64'));
					const rel = path.relative(root, file).replace(/\\/g, '/');
					return `Image saved: ${rel}`;
				}
			}
		} catch {
			/* fall through to SVG */
		}
	}

	const file = path.join(dir, base.endsWith('.svg') ? base : `${base}.svg`);
	await fs.writeFile(file, svgFromPrompt(prompt), 'utf8');
	const rel = path.relative(root, file).replace(/\\/g, '/');
	return [
		`Image saved (SVG poster — configure an images API for photorealistic output): ${rel}`,
		`Prompt: ${prompt.slice(0, 200)}`,
	].join('\n');
}

export async function canvasWrite(opts: {
	workspaceRoot?: string;
	id: string;
	title: string;
	content: string;
	format?: 'md' | 'html';
}): Promise<string> {
	const root = opts.workspaceRoot || process.cwd();
	const id = String(opts.id || 'canvas').replace(/[^\w.-]+/g, '_');
	const format = opts.format === 'html' ? 'html' : 'md';
	const dir = path.join(root, '.CodeForge', 'canvas');
	await ensureDir(dir);
	const file = path.join(dir, `${id}.${format}`);
	const body =
		format === 'html'
			? `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeXml(opts.title)}</title>
<style>body{font-family:Georgia,serif;max-width:52rem;margin:2rem auto;padding:0 1rem;line-height:1.5;background:#0f1419;color:#e8e6e3}
h1{font-weight:600} pre{overflow:auto;background:#1a2332;padding:1rem}</style></head><body>
<h1>${escapeXml(opts.title)}</h1>
${opts.content}
</body></html>`
			: `# ${opts.title}\n\n${opts.content}\n`;
	await fs.writeFile(file, body, 'utf8');
	const rel = path.relative(root, file).replace(/\\/g, '/');
	return `Canvas written: ${rel}\nOpen this file in the editor for a side-panel style view.`;
}

export function voiceStatus(): string {
	return [
		'Voice input is not available in CodeForge yet (UX pending).',
		'Continue with typed chat, or attach an audio transcript as text.',
	].join('\n');
}
