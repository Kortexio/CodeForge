/**
 * Chat composer attachments — files, images, and URIs for the model.
 */

import * as vscode from 'vscode';
import * as path from 'path';

export type AttachmentKind = 'text' | 'image' | 'uri';

export interface PendingAttachment {
	id: string;
	kind: AttachmentKind;
	/** Chip label shown in the composer. */
	label: string;
	/** Workspace-relative or absolute path when from disk. */
	path?: string;
	/** Text file content (truncated). */
	text?: string;
	/** data:image/...;base64,... for vision models. */
	dataUrl?: string;
	mime?: string;
	/** External http(s) link. */
	url?: string;
}

const MAX_ATTACHMENTS = 8;
const MAX_TEXT_CHARS = 12_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB

const TEXT_EXT = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.json',
	'.md',
	'.txt',
	'.css',
	'.scss',
	'.html',
	'.htm',
	'.xml',
	'.yml',
	'.yaml',
	'.toml',
	'.ini',
	'.cfg',
	'.env',
	'.py',
	'.rs',
	'.go',
	'.java',
	'.kt',
	'.cs',
	'.fs',
	'.cpp',
	'.c',
	'.h',
	'.hpp',
	'.sql',
	'.sh',
	'.ps1',
	'.bat',
	'.cmd',
	'.dockerfile',
	'.gitignore',
	'.editorconfig',
	'.vue',
	'.svelte',
	'.rb',
	'.php',
	'.swift',
	'.r',
	'.csv',
	'.log',
]);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

const IMAGE_MIME: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.svg': 'image/svg+xml',
};

function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isHttpUrl(text: string): boolean {
	return /^https?:\/\/\S+$/i.test(text.trim());
}

export function looksLikeImageMime(mime?: string): boolean {
	return Boolean(mime && mime.startsWith('image/'));
}

export function mergeAttachments(
	existing: PendingAttachment[],
	incoming: PendingAttachment[]
): PendingAttachment[] {
	const byKey = new Map<string, PendingAttachment>();
	for (const a of existing) {
		byKey.set(attachmentKey(a), a);
	}
	for (const a of incoming) {
		byKey.set(attachmentKey(a), a);
	}
	return Array.from(byKey.values()).slice(-MAX_ATTACHMENTS);
}

function attachmentKey(a: PendingAttachment): string {
	return a.path || a.url || a.dataUrl?.slice(0, 64) || a.id;
}

export async function attachmentsFromUris(uris: vscode.Uri[]): Promise<PendingAttachment[]> {
	const out: PendingAttachment[] = [];
	for (const uri of uris.slice(0, MAX_ATTACHMENTS)) {
		try {
			if (uri.scheme === 'http' || uri.scheme === 'https') {
				out.push({
					id: newId(),
					kind: 'uri',
					label: uri.toString(),
					url: uri.toString(),
				});
				continue;
			}
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.type & vscode.FileType.Directory) {
				out.push({
					id: newId(),
					kind: 'uri',
					label: vscode.workspace.asRelativePath(uri) + '/',
					path: vscode.workspace.asRelativePath(uri),
					url: uri.toString(),
					text: `(directory) ${vscode.workspace.asRelativePath(uri)}`,
				});
				continue;
			}
			const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
			const rel = vscode.workspace.asRelativePath(uri);
			const ext = path.extname(uri.fsPath).toLowerCase();
			if (IMAGE_EXT.has(ext) || looksLikeImage(bytes)) {
				if (bytes.length > MAX_IMAGE_BYTES) {
					vscode.window.showWarningMessage(`Image too large to attach (>${MAX_IMAGE_BYTES / 1024 / 1024}MB): ${rel}`);
					continue;
				}
				const mime = IMAGE_MIME[ext] || sniffImageMime(bytes) || 'image/png';
				out.push({
					id: newId(),
					kind: 'image',
					label: rel,
					path: rel,
					mime,
					dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
				});
				continue;
			}
			const text = bytes.toString('utf8');
			// Skip obvious binary
			if (TEXT_EXT.has(ext) || !hasNul(text)) {
				out.push({
					id: newId(),
					kind: 'text',
					label: rel,
					path: rel,
					text: text.slice(0, MAX_TEXT_CHARS),
				});
			} else {
				out.push({
					id: newId(),
					kind: 'uri',
					label: rel,
					path: rel,
					text: `(binary file, ${bytes.length} bytes) — use tools to inspect if needed`,
				});
			}
		} catch (err) {
			vscode.window.showWarningMessage(
				`Could not attach ${uri.toString()}: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}
	return out;
}

export function attachmentFromBlob(input: {
	name: string;
	mime?: string;
	base64: string;
}): PendingAttachment | undefined {
	const mime = input.mime || 'application/octet-stream';
	const buf = Buffer.from(input.base64, 'base64');
	if (looksLikeImageMime(mime) || IMAGE_EXT.has(path.extname(input.name).toLowerCase())) {
		if (buf.length > MAX_IMAGE_BYTES) {
			vscode.window.showWarningMessage(`Image too large to attach: ${input.name}`);
			return undefined;
		}
		const resolved = mime.startsWith('image/') ? mime : IMAGE_MIME[path.extname(input.name).toLowerCase()] || 'image/png';
		return {
			id: newId(),
			kind: 'image',
			label: input.name || 'pasted-image',
			path: input.name,
			mime: resolved,
			dataUrl: `data:${resolved};base64,${input.base64}`,
		};
	}
	const text = buf.toString('utf8');
	if (!hasNul(text)) {
		return {
			id: newId(),
			kind: 'text',
			label: input.name || 'pasted.txt',
			path: input.name,
			text: text.slice(0, MAX_TEXT_CHARS),
		};
	}
	return {
		id: newId(),
		kind: 'uri',
		label: input.name || 'binary',
		path: input.name,
		text: `(binary attachment, ${buf.length} bytes)`,
	};
}

export function attachmentFromHttpUrl(url: string): PendingAttachment {
	const trimmed = url.trim();
	return {
		id: newId(),
		kind: 'uri',
		label: trimmed,
		url: trimmed,
	};
}

/** Build prompt text + optional vision parts for the model. */
export function buildAttachmentPayload(attachments: PendingAttachment[]): {
	textBlock: string;
	images: Array<{ mime: string; dataUrl: string; label: string }>;
	displaySummary: string;
} {
	const parts: string[] = [];
	const images: Array<{ mime: string; dataUrl: string; label: string }> = [];
	for (const a of attachments) {
		if (a.kind === 'image' && a.dataUrl) {
			images.push({
				mime: a.mime || 'image/png',
				dataUrl: a.dataUrl,
				label: a.label,
			});
			parts.push(`### Attached image: ${a.label}\n(Image attached for visual analysis.)`);
		} else if (a.kind === 'uri' && a.url && !a.text) {
			parts.push(`### Attached link: ${a.url}\n${a.url}`);
		} else if (a.kind === 'text' || a.text) {
			const body = a.text ?? '';
			parts.push(`### Attached: ${a.label}\n\`\`\`\n${body}\n\`\`\``);
		} else if (a.url) {
			parts.push(`### Attached link: ${a.url}\n${a.url}`);
		}
	}
	return {
		textBlock: parts.join('\n\n'),
		images,
		displaySummary: attachments.map(a => a.label).join(', '),
	};
}

function hasNul(text: string): boolean {
	return text.includes('\u0000');
}

function looksLikeImage(buf: Buffer): boolean {
	if (buf.length < 4) return false;
	// PNG
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
	// JPEG
	if (buf[0] === 0xff && buf[1] === 0xd8) return true;
	// GIF
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
	// WEBP
	if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
	return false;
}

function sniffImageMime(buf: Buffer): string | undefined {
	if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
	if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
	if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
	if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
	return undefined;
}

export function parseDroppedUriList(raw: string): vscode.Uri[] {
	const lines = raw
		.split(/\r?\n/)
		.map(s => s.trim())
		.filter(s => s && !s.startsWith('#'));
	const uris: vscode.Uri[] = [];
	for (const line of lines) {
		try {
			uris.push(vscode.Uri.parse(line));
		} catch {
			/* skip */
		}
	}
	return uris;
}
