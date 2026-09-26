/**
 * LSP / code-intelligence helpers via VS Code language APIs.
 */

import * as vscode from 'vscode';
import * as path from 'path';

export interface SymbolRange {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	depth: number;
}

export async function documentSymbolRanges(filePath: string): Promise<SymbolRange[]> {
	const uri = resolveUri(filePath);
	const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
		'vscode.executeDocumentSymbolProvider',
		uri
	);
	if (!symbols?.length) {
		return [];
	}
	return collectSymbolRanges(symbols, 0);
}

export async function documentSymbols(filePath: string): Promise<string> {
	const ranges = await documentSymbolRanges(filePath);
	if (!ranges.length) {
		return `No symbols found in ${filePath}`;
	}
	return ranges
		.map(s => {
			const pad = '  '.repeat(s.depth);
			return `${pad}${s.kind} ${s.name} @${s.startLine}`;
		})
		.join('\n');
}

/** Compact outline for read tool: `name (kind) L10-85`. */
export function formatOutlineBlock(ranges: SymbolRange[], max = 40): string {
	if (!ranges.length) return '';
	const lines = ranges.slice(0, max).map(s => {
		const pad = '  '.repeat(s.depth);
		return `${pad}${s.name} (${s.kind}) L${s.startLine}-${s.endLine}`;
	});
	const more =
		ranges.length > max ? `\n…[+${ranges.length - max} symbols; use symbols tool]` : '';
	return ['OUTLINE', ...lines].join('\n') + more;
}

export async function workspaceSymbols(query: string): Promise<string> {
	const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
		'vscode.executeWorkspaceSymbolProvider',
		query
	);
	if (!symbols?.length) {
		return `No workspace symbols for "${query}"`;
	}
	return symbols
		.slice(0, 40)
		.map(s => `${s.kind} ${s.name} — ${vscode.workspace.asRelativePath(s.location.uri)}:${s.location.range.start.line + 1}`)
		.join('\n');
}

export async function findReferences(filePath: string, line: number, character: number): Promise<string> {
	const uri = resolveUri(filePath);
	const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, character));
	const locs = await vscode.commands.executeCommand<vscode.Location[]>(
		'vscode.executeReferenceProvider',
		uri,
		position
	);
	if (!locs?.length) {
		return `No references at ${filePath}:${line}:${character}`;
	}
	return locs
		.slice(0, 50)
		.map(l => `${vscode.workspace.asRelativePath(l.uri)}:${l.range.start.line + 1}:${l.range.start.character}`)
		.join('\n');
}

export async function gotoDefinition(filePath: string, line: number, character: number): Promise<string> {
	const uri = resolveUri(filePath);
	const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, character));
	const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
		'vscode.executeDefinitionProvider',
		uri,
		position
	);
	if (!defs?.length) {
		return `No definition at ${filePath}:${line}:${character}`;
	}
	return defs
		.slice(0, 10)
		.map(d => {
			if ('targetUri' in d) {
				const link = d as vscode.LocationLink;
				return `${vscode.workspace.asRelativePath(link.targetUri)}:${(link.targetRange?.start.line ?? 0) + 1}`;
			}
			const loc = d as vscode.Location;
			return `${vscode.workspace.asRelativePath(loc.uri)}:${loc.range.start.line + 1}`;
		})
		.join('\n');
}

function resolveUri(filePath: string): vscode.Uri {
	if (path.isAbsolute(filePath)) {
		return vscode.Uri.file(filePath);
	}
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		throw new Error('No workspace folder open');
	}
	return vscode.Uri.file(path.join(root, filePath));
}

function collectSymbolRanges(symbols: vscode.DocumentSymbol[], depth: number): SymbolRange[] {
	const out: SymbolRange[] = [];
	for (const s of symbols) {
		out.push({
			name: s.name,
			kind: vscode.SymbolKind[s.kind] ?? String(s.kind),
			startLine: s.range.start.line + 1,
			endLine: s.range.end.line + 1,
			depth,
		});
		if (s.children?.length) {
			out.push(...collectSymbolRanges(s.children, depth + 1));
		}
	}
	return out;
}
