/**
 * Pure apply_patch parser/applier (Cursor / OpenAI-style *** Begin Patch).
 * Used for gpt-* models; local/Qwen models keep edit/write only.
 */

export type PatchHunk =
	| { type: 'add'; path: string; contents: string }
	| { type: 'delete'; path: string }
	| { type: 'update'; path: string; chunks: PatchChunk[]; movePath?: string };

export type PatchChunk = {
	/** Context / change lines without the leading ' ' / '+' / '-' (stored with markers). */
	lines: string[];
};

export type ApplyPatchResult =
	| { ok: true; path: string; text: string; kind: 'add' | 'update' | 'delete' }
	| { ok: false; error: string };

export function modelUsesApplyPatch(modelId: string): boolean {
	const id = String(modelId || '').toLowerCase();
	return id.includes('gpt-') && !id.includes('oss') && !id.includes('gpt-4');
}

/** Parse patch text into hunks. Throws / returns error string on failure. */
export function parsePatch(patchText: string): { ok: true; hunks: PatchHunk[] } | { ok: false; error: string } {
	const text = String(patchText || '').replace(/\r\n/g, '\n').trim();
	if (!text) return { ok: false, error: 'patchText is required' };

	let body = text;
	const begin = /^(\*\*\*\s*Begin Patch\s*\n)?/i;
	const end = /\n?\*\*\*\s*End Patch\s*$/i;
	body = body.replace(begin, '').replace(end, '').trim();
	if (!body) return { ok: false, error: 'empty patch' };

	const hunks: PatchHunk[] = [];
	const sections = body.split(/(?=^\*\*\*\s*(?:Add|Update|Delete)\s+File:)/im).filter(s => s.trim());

	for (const section of sections) {
		const addMatch = /^\*\*\*\s*Add\s+File:\s*(.+)$/im.exec(section);
		const delMatch = /^\*\*\*\s*Delete\s+File:\s*(.+)$/im.exec(section);
		const updMatch = /^\*\*\*\s*Update\s+File:\s*(.+)$/im.exec(section);
		const moveMatch = /^\*\*\*\s*Move\s+to:\s*(.+)$/im.exec(section);

		if (addMatch) {
			const path = addMatch[1]!.trim();
			const rest = section.slice(addMatch.index! + addMatch[0].length).replace(/^\n/, '');
			const contents = rest
				.split('\n')
				.map(l => (l.startsWith('+') ? l.slice(1) : l.startsWith(' ') ? l.slice(1) : l))
				.join('\n');
			hunks.push({
				type: 'add',
				path,
				contents: contents.endsWith('\n') || contents === '' ? contents : `${contents}\n`,
			});
			continue;
		}
		if (delMatch) {
			hunks.push({ type: 'delete', path: delMatch[1]!.trim() });
			continue;
		}
		if (updMatch) {
			const path = updMatch[1]!.trim();
			const movePath = moveMatch?.[1]?.trim();
			let rest = section.slice(updMatch.index! + updMatch[0].length);
			if (moveMatch) {
				rest = rest.replace(moveMatch[0], '');
			}
			rest = rest.replace(/^\n/, '');
			const chunks: PatchChunk[] = [];
			const rawChunks = rest.split(/(?=^@@)/m).filter(c => c.trim());
			if (!rawChunks.length && rest.trim()) {
				chunks.push({
					lines: rest.split('\n').filter(l => /^[ +\-@]/.test(l) || l === ''),
				});
			} else {
				for (const raw of rawChunks) {
					const lines = raw.split('\n').filter((l, i) => !(i === 0 && l.startsWith('@@')));
					chunks.push({ lines: lines.filter(l => l.length === 0 || /^[ +\-]/.test(l) || l.startsWith(' ')) });
				}
			}
			hunks.push({ type: 'update', path, chunks, movePath });
			continue;
		}
		return { ok: false, error: `unrecognized patch section: ${section.slice(0, 80)}` };
	}

	if (!hunks.length) return { ok: false, error: 'empty patch' };
	return { ok: true, hunks };
}

function applyChunkToText(fileText: string, chunk: PatchChunk): { ok: true; text: string } | { ok: false; error: string } {
	const crlf = fileText.includes('\r\n');
	const src = fileText.replace(/\r\n/g, '\n');
	const oldLines: string[] = [];
	const newLines: string[] = [];
	for (const line of chunk.lines) {
		if (line.startsWith('@@')) continue;
		if (line.startsWith('-')) {
			oldLines.push(line.slice(1));
		} else if (line.startsWith('+')) {
			newLines.push(line.slice(1));
		} else if (line.startsWith(' ')) {
			oldLines.push(line.slice(1));
			newLines.push(line.slice(1));
		} else if (line === '') {
			/* skip */
		} else {
			// Bare context line without prefix
			oldLines.push(line);
			newLines.push(line);
		}
	}
	const oldBlock = oldLines.join('\n');
	const newBlock = newLines.join('\n');
	if (!oldBlock) {
		// Pure insert at EOF
		const joined = src.endsWith('\n') || src === '' ? src + newBlock : src + '\n' + newBlock;
		const out = joined.endsWith('\n') ? joined : joined + '\n';
		return { ok: true, text: crlf ? out.replace(/\n/g, '\r\n') : out };
	}
	const idx = src.indexOf(oldBlock);
	if (idx < 0) {
		// Try trailing-whitespace tolerant match line by line
		const srcLines = src.split('\n');
		const needle = oldLines.map(l => l.trimEnd());
		let found = -1;
		for (let i = 0; i <= srcLines.length - needle.length; i++) {
			if (srcLines.slice(i, i + needle.length).every((l, j) => l.trimEnd() === needle[j])) {
				found = i;
				break;
			}
		}
		if (found < 0) {
			return {
				ok: false,
				error: `hunk failed: context not found\n--- expected ---\n${oldBlock.slice(0, 400)}`,
			};
		}
		const before = srcLines.slice(0, found);
		const after = srcLines.slice(found + needle.length);
		const out = [...before, ...newLines, ...after].join('\n');
		return { ok: true, text: crlf ? out.replace(/\n/g, '\r\n') : out };
	}
	const out = src.slice(0, idx) + newBlock + src.slice(idx + oldBlock.length);
	return { ok: true, text: crlf ? out.replace(/\n/g, '\r\n') : out };
}

/** Apply a single update hunk to existing file text. */
export function applyUpdateToText(
	fileText: string,
	chunks: PatchChunk[]
): { ok: true; text: string } | { ok: false; error: string } {
	let text = fileText;
	for (let i = 0; i < chunks.length; i++) {
		const r = applyChunkToText(text, chunks[i]!);
		if (!r.ok) return { ok: false, error: `hunk ${i + 1}: ${r.error}` };
		text = r.text;
	}
	return { ok: true, text };
}

export function applyPatchHunk(
	hunk: PatchHunk,
	readExisting: (path: string) => string | undefined
): ApplyPatchResult {
	if (hunk.type === 'add') {
		return { ok: true, path: hunk.path, text: hunk.contents, kind: 'add' };
	}
	if (hunk.type === 'delete') {
		const existing = readExisting(hunk.path);
		if (existing === undefined) {
			return { ok: false, error: `Failed to delete ${hunk.path}: file does not exist` };
		}
		return { ok: true, path: hunk.path, text: '', kind: 'delete' };
	}
	const existing = readExisting(hunk.path);
	if (existing === undefined) {
		return { ok: false, error: `Failed to update ${hunk.path}: file does not exist` };
	}
	const applied = applyUpdateToText(existing, hunk.chunks);
	if (!applied.ok) return { ok: false, error: `${hunk.path}: ${applied.error}` };
	return {
		ok: true,
		path: hunk.movePath || hunk.path,
		text: applied.text,
		kind: 'update',
	};
}
