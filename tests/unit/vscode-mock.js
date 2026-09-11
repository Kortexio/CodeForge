/** Minimal vscode stub for unit tests that import extension modules. */
module.exports = {
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: () => ({ get: () => undefined }),
		asRelativePath: (u) => String(u),
		findFiles: async () => [],
		fs: {
			readFile: async () => new Uint8Array(),
			stat: async () => ({ size: 0, mtime: 0 }),
		},
		onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
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
	Uri: {
		file: (p) => ({ fsPath: p, toString: () => p }),
		joinPath: (base, ...parts) => ({
			fsPath: [base.fsPath || base, ...parts].join('/'),
		}),
	},
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	EventEmitter: class {
		event = () => ({ dispose() {} });
		fire() {}
	},
	ConfigurationTarget: { Global: 1 },
	commands: {
		registerCommand: () => ({ dispose() {} }),
		executeCommand: async () => undefined,
	},
};
