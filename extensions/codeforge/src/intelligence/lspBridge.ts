/**
 * LSP / code-intelligence helpers via VS Code language APIs.
 */

import * as vscode from 'vscode';
import * as path from 'path';

export async function documentSymbols(filePath: string): Promise<string> {
	const uri = resolveUri(filePath);
	const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
		'vscode.executeDocumentSymbolProvider',
		uri
	);
	if (!symbols?.length) {
		return `No symbols found in ${filePath}`;
	}
	return flattenSymbols(symbols).join('\n');
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

function flattenSymbols(symbols: vscode.DocumentSymbol[], indent = 0): string[] {
	const lines: string[] = [];
	for (const s of symbols) {
		const pad = '  '.repeat(indent);
		lines.push(`${pad}${vscode.SymbolKind[s.kind]} ${s.name} @${s.range.start.line + 1}`);
		if (s.children?.length) {
			lines.push(...flattenSymbols(s.children, indent + 1));
		}
	}
	return lines;
}
