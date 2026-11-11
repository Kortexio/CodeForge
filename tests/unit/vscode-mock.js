/** Minimal vscode stub for unit tests that import extension modules. */
module.exports = {
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: () => ({
			get: () => undefined,
			update: async () => undefined,
		}),
		asRelativePath: (u) => String(u),
		findFiles: async () => [],
		fs: {
			readFile: async () => new Uint8Array(),
			stat: async () => ({ size: 0, mtime: 0 }),
		},
		onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
		/** Watchers created by the code under test. Tests fire `change`/`create`/`delete`. */
		__fileWatchers: [],
		createFileSystemWatcher(pattern) {
			const listeners = { change: [], create: [], delete: [] };
			const subscribe = (kind) => (cb) => {
				listeners[kind].push(cb);
				return { dispose() { listeners[kind] = listeners[kind].filter(fn => fn !== cb); } };
			};
			const watcher = {
				pattern,
				onDidChange: subscribe('change'),
				onDidCreate: subscribe('create'),
				onDidDelete: subscribe('delete'),
				fire(kind, uri) {
					for (const cb of listeners[kind] || []) cb(uri);
				},
				dispose() {},
			};
			this.__fileWatchers.push(watcher);
			return watcher;
		},
	},
	RelativePattern: class {
		constructor(base, pattern) {
			this.base = base;
			this.pattern = pattern;
		}
	},
	window: {
		activeTextEditor: undefined,
		createOutputChannel: () => ({
			appendLine: () => {},
			show: () => {},
		}),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showSaveDialog: async () => undefined,
		showOpenDialog: async () => undefined,
		showInputBox: async () => undefined,
		createTerminal: () => ({
			show: () => {},
			sendText: () => {},
			dispose: () => {},
		}),
	},
	languages: {
		getDiagnostics: () => [],
		registerInlineCompletionItemProvider: () => ({ dispose() {} }),
	},
	FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
	Uri: {
		file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file:///${p}` }),
		joinPath: (base, ...parts) => ({
			fsPath: [base.fsPath || base, ...parts].join('/'),
		}),
	},
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	EventEmitter: class {
		constructor() {
			this.listeners = new Set();
			this.event = (listener) => {
				this.listeners.add(listener);
				return { dispose: () => this.listeners.delete(listener) };
			};
		}
		fire(value) {
			for (const listener of [...this.listeners]) listener(value);
		}
		dispose() {
			this.listeners.clear();
		}
	},
	ConfigurationTarget: { Global: 1 },
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
	LanguageModelChatToolMode: { Auto: 1, Required: 2 },
	LanguageModelTextPart: class {
		constructor(value) {
			this.value = value;
		}
	},
	LanguageModelToolCallPart: class {
		constructor(callId, name, input) {
			this.callId = callId;
			this.name = name;
			this.input = input;
		}
	},
	LanguageModelToolResultPart: class {
		constructor(callId, content) {
			this.callId = callId;
			this.content = content;
		}
	},
	commands: {
		registerCommand: () => ({ dispose() {} }),
		executeCommand: async () => undefined,
	},
};
