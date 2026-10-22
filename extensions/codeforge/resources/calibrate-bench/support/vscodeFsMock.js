/**
 * Disk-backed vscode mock for headless agent-loop tests.
 * Implements the subset used by VSCodeAIBridge + agentLoop.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { minimatch } = require('minimatch');

let workspaceRoot = process.cwd();
let configMap = {};
/** @type {Map<string, Array<{ message: string, severity: number, range: { start: { line: number, character: number } } }>>} */
let diagnosticsMap = new Map();

function makeUri(fsPath) {
	const normalized = path.resolve(String(fsPath));
	return {
		fsPath: normalized,
		scheme: 'file',
		path: normalized.replace(/\\/g, '/'),
		toString: () => `file:///${normalized.replace(/\\/g, '/')}`,
	};
}

function toFsPath(uriOrPath) {
	if (!uriOrPath) return workspaceRoot;
	if (typeof uriOrPath === 'string') return path.resolve(uriOrPath);
	return path.resolve(uriOrPath.fsPath || String(uriOrPath));
}

async function ensureParent(filePath) {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

function walkFiles(dir, out, max) {
	if (out.length >= max) return;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		if (out.length >= max) return;
		const full = path.join(dir, ent.name);
		if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'bin' || ent.name === 'obj') {
			continue;
		}
		if (ent.isDirectory()) walkFiles(full, out, max);
		else if (ent.isFile()) out.push(full);
	}
}

class RelativePattern {
	constructor(base, pattern) {
		const baseUri = typeof base === 'string' ? makeUri(base) : base && base.uri ? base.uri : base;
		this.baseUri = baseUri;
		this.base = toFsPath(baseUri);
		this.pattern = String(pattern);
	}
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

const vscode = {
	RelativePattern,
	FileType,
	DiagnosticSeverity,
	ConfigurationTarget,
	Uri: {
		file: p => makeUri(p),
		joinPath: (base, ...parts) => {
			const basePath = toFsPath(base);
			return makeUri(path.join(basePath, ...parts.map(String)));
		},
		parse: s => makeUri(String(s).replace(/^file:\/\//, '')),
	},
	workspace: {
		get workspaceFolders() {
			return [
				{
					uri: makeUri(workspaceRoot),
					name: path.basename(workspaceRoot),
					index: 0,
				},
			];
		},
		getConfiguration: section => ({
			get: (key, defaultValue) => {
				const full = section ? `${section}.${key}` : key;
				if (Object.prototype.hasOwnProperty.call(configMap, full)) return configMap[full];
				if (section && Object.prototype.hasOwnProperty.call(configMap, `${section}.${key}`)) {
					return configMap[`${section}.${key}`];
				}
				const bag = configMap[section || ''];
				if (bag && typeof bag === 'object' && Object.prototype.hasOwnProperty.call(bag, key)) {
					return bag[key];
				}
				return defaultValue;
			},
			update: async () => undefined,
		}),
		asRelativePath: u => {
			const p = toFsPath(u);
			const rel = path.relative(workspaceRoot, p);
			return rel.startsWith('..') ? p : rel.replace(/\\/g, '/');
		},
		findFiles: async (include, _exclude, maxResults = 400) => {
			const pattern = typeof include === 'string' ? include : include?.pattern || '**/*';
			const base = include instanceof RelativePattern ? include.base : workspaceRoot;
			const all = [];
			walkFiles(base, all, maxResults * 4);
			const matched = [];
			for (const file of all) {
				const rel = path.relative(base, file).replace(/\\/g, '/');
				if (minimatch(rel, pattern, { dot: true }) || minimatch(file.replace(/\\/g, '/'), pattern, { dot: true })) {
					matched.push(makeUri(file));
					if (matched.length >= maxResults) break;
				}
			}
			return matched;
		},
		fs: {
			readFile: async uri => {
				const buf = await fsp.readFile(toFsPath(uri));
				return new Uint8Array(buf);
			},
			writeFile: async (uri, content) => {
				const p = toFsPath(uri);
				await ensureParent(p);
				const buf = Buffer.isBuffer(content)
					? content
					: Buffer.from(content instanceof Uint8Array ? content : String(content));
				await fsp.writeFile(p, buf);
			},
			stat: async uri => {
				const st = await fsp.stat(toFsPath(uri));
				return {
					type: st.isDirectory() ? FileType.Directory : FileType.File,
					ctime: st.ctimeMs,
					mtime: st.mtimeMs,
					size: st.size,
				};
			},
			readDirectory: async uri => {
				const dir = toFsPath(uri);
				const names = await fsp.readdir(dir, { withFileTypes: true });
				return names.map(ent => [
					ent.name,
					ent.isDirectory() ? FileType.Directory : FileType.File,
				]);
			},
			createDirectory: async uri => {
				await fsp.mkdir(toFsPath(uri), { recursive: true });
			},
			delete: async (uri, _opts) => {
				const p = toFsPath(uri);
				const st = await fsp.stat(p);
				if (st.isDirectory()) await fsp.rm(p, { recursive: true, force: true });
				else await fsp.unlink(p);
			},
			rename: async (from, to, _opts) => {
				await ensureParent(toFsPath(to));
				await fsp.rename(toFsPath(from), toFsPath(to));
			},
		},
		openTextDocument: async uri => ({
			uri: typeof uri === 'string' ? makeUri(uri) : uri,
			getText: () => fs.readFileSync(toFsPath(uri), 'utf8'),
			fileName: toFsPath(uri),
			lineCount: fs.readFileSync(toFsPath(uri), 'utf8').split(/\r?\n/).length,
		}),
		onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
		onDidChangeTextDocument: () => ({ dispose() {} }),
		onDidSaveTextDocument: () => ({ dispose() {} }),
	},
	window: {
		activeTextEditor: undefined,
		visibleTextEditors: [],
		createOutputChannel: () => ({
			appendLine: () => {},
			append: () => {},
			show: () => {},
			clear: () => {},
			dispose: () => {},
		}),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showSaveDialog: async () => undefined,
		showOpenDialog: async () => undefined,
		showInputBox: async () => undefined,
		showTextDocument: async () => undefined,
		createTerminal: () => ({
			show: () => {},
			sendText: () => {},
			dispose: () => {},
			name: 'agent',
		}),
		withProgress: async (_opts, task) => task({ report: () => {} }),
	},
	languages: {
		getDiagnostics: uri => {
			if (uri) {
				const key = toFsPath(uri).replace(/\\/g, '/').toLowerCase();
				const base = path.basename(key).toLowerCase();
				for (const [k, v] of diagnosticsMap) {
					const kk = k.replace(/\\/g, '/').toLowerCase();
					if (kk === key || kk.endsWith('/' + base) || kk.endsWith(base)) {
						return v;
					}
				}
				return [];
			}
			return [...diagnosticsMap.entries()].map(([p, diags]) => [makeUri(p), diags]);
		},
		registerInlineCompletionItemProvider: () => ({ dispose() {} }),
	},
	commands: {
		registerCommand: () => ({ dispose() {} }),
		executeCommand: async () => undefined,
	},
	EventEmitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	ProgressLocation: { Notification: 15 },
	ViewColumn: { One: 1, Beside: -2 },
};

module.exports = vscode;
module.exports.__setWorkspace = root => {
	workspaceRoot = path.resolve(root);
};
module.exports.__setConfig = obj => {
	configMap = { ...(obj || {}) };
};
module.exports.__setDiagnostics = map => {
	diagnosticsMap = new Map();
	if (!map) return;
	for (const [k, v] of map instanceof Map ? map : Object.entries(map)) {
		const raw = String(k);
		const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
		diagnosticsMap.set(abs, v);
	}
};
module.exports.__getWorkspace = () => workspaceRoot;
