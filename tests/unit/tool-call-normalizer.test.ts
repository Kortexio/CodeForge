import {
	foldToolToken,
	normalizeToolCall,
	normalizeWorkspacePath,
	resolveToolName,
} from '../../extensions/codeforge/src/agent/toolCallNormalizer';

const CORE = [
	'read',
	'edit',
	'write',
	'shell',
	'search',
	'list',
	'retrieve',
	'apply_patch',
	'dotnet',
	'diagnostics',
	'todo_write',
	'delegate_task',
	'update_status',
	'skill',
	'await_shell',
];

const SCHEMAS = {
	read: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			startLine: { type: 'number' },
			limit: { type: 'number' },
		},
		required: ['path'],
	},
	edit: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			old_string: { type: 'string' },
			new_string: { type: 'string' },
			replace_all: { type: 'boolean' },
		},
		required: ['path', 'old_string', 'new_string'],
	},
	write: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			content: { type: 'string' },
		},
		required: ['path', 'content'],
	},
	shell: {
		type: 'object',
		properties: { command: { type: 'string' } },
		required: ['command'],
	},
	search: {
		type: 'object',
		properties: {
			pattern: { type: 'string' },
			path: { type: 'string' },
		},
		required: ['pattern'],
	},
	list: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			recursive: { type: 'boolean' },
		},
		required: ['path'],
	},
};

describe('toolCallNormalizer', () => {
	it('folds tool tokens case/underscore/hyphen insensitive', () => {
		expect(foldToolToken('Read_File')).toBe('readfile');
		expect(foldToolToken('str-replace')).toBe('strreplace');
	});

	it.each([
		['read_file', 'read'],
		['VIEW', 'read'],
		['cat', 'read'],
		['str_replace', 'edit'],
		['str_replace_editor', 'edit'],
		['edit_file', 'edit'],
		['replace_in_file', 'edit'],
		['write_file', 'write'],
		['create_file', 'write'],
		['bash', 'shell'],
		['run_terminal_cmd', 'shell'],
		['execute_command', 'shell'],
		['terminal', 'shell'],
		['grep', 'search'],
		['grep_search', 'search'],
		['search_files', 'search'],
		['ls', 'list'],
		['list_dir', 'list'],
		['list_files', 'list'],
	] as const)('aliases %s → %s when active', (alias, canonical) => {
		const r = resolveToolName(alias, CORE);
		expect(r.name).toBe(canonical);
		expect(r.aliasedFrom).toBe(alias);
	});

	it('does not alias when target is inactive', () => {
		const r = resolveToolName('bash', ['read', 'edit']);
		expect(r.name).toBe('bash');
		expect(r.aliasedFrom).toBeUndefined();
	});

	it('maps argument aliases only when canonical missing', () => {
		const r = normalizeToolCall({
			name: 'read_file',
			args: { file_path: 'src/a.ts', path: 'keep.ts' },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(r.name).toBe('read');
		expect(r.args.path).toBe('keep.ts');
		expect(r.notes.some(n => /called as read_file/i.test(n))).toBe(true);
	});

	it.each([
		['file_path', 'path', 'src/x.ts'],
		['filepath', 'path', 'src/x.ts'],
		['file', 'path', 'src/x.ts'],
		['filename', 'path', 'src/x.ts'],
		['target_file', 'path', 'src/x.ts'],
	] as const)('arg %s → path', (alias, _canon, value) => {
		const r = normalizeToolCall({
			name: 'read',
			args: { [alias]: value },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(r.args.path).toBe(value);
		expect(r.error).toBeUndefined();
	});

	it('maps edit old_str/new_str and write contents', () => {
		const edit = normalizeToolCall({
			name: 'str_replace',
			args: { path: 'a.ts', old_str: 'a', new_str: 'b' },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(edit.name).toBe('edit');
		expect(edit.args.old_string).toBe('a');
		expect(edit.args.new_string).toBe('b');

		const write = normalizeToolCall({
			name: 'write_file',
			args: { path: 'a.ts', contents: 'hi' },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(write.name).toBe('write');
		expect(write.args.content).toBe('hi');
	});

	it('maps shell cmd and search regex/query', () => {
		const sh = normalizeToolCall({
			name: 'bash',
			args: { cmd: 'dir' },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(sh.args.command).toBe('dir');

		const s1 = normalizeToolCall({
			name: 'grep',
			args: { regex: 'foo' },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(s1.args.pattern).toBe('foo');

		const s2 = normalizeToolCall({
			name: 'search',
			args: { query: 'bar' },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(s2.args.pattern).toBe('bar');
	});

	it('coerces number and boolean from schema', () => {
		const r = normalizeToolCall({
			name: 'read',
			args: { path: 'a.ts', start_line: '10', limit: '20' },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(r.args.startLine).toBe(10);
		expect(r.args.limit).toBe(20);

		const list = normalizeToolCall({
			name: 'list',
			args: { path: '.', recursive: 'true' },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(list.args.recursive).toBe(true);
	});

	it('normalizes paths: backslash, quotes, ./, absolute→relative', () => {
		expect(normalizeWorkspacePath('"src\\a.ts"')).toBe('src/a.ts');
		expect(normalizeWorkspacePath('./src/a.ts')).toBe('src/a.ts');
		expect(normalizeWorkspacePath('C:/ws/src/a.ts', 'C:/ws')).toBe('src/a.ts');

		const r = normalizeToolCall({
			name: 'read',
			args: { path: 'C:\\proj\\src\\a.ts' },
			activeToolNames: CORE,
			workspaceRoot: 'C:\\proj',
			toolSchemas: SCHEMAS,
		});
		expect(r.args.path).toBe('src/a.ts');
	});

	it('errors on unknown tool listing available names', () => {
		const r = normalizeToolCall({
			name: 'fly_to_moon',
			args: {},
			activeToolNames: ['read', 'edit'],
		});
		expect(r.error).toMatch(/no tool named fly_to_moon/i);
		expect(r.error).toMatch(/Available tools: edit, read/);
	});

	it('errors on missing required with expected signature', () => {
		const r = normalizeToolCall({
			name: 'edit',
			args: { path: 'a.ts' },
			activeToolNames: CORE,
			toolSchemas: SCHEMAS,
		});
		expect(r.error).toMatch(/edit requires old_string/);
		expect(r.error).toMatch(/Expected:/);
		expect(r.error).toMatch(/Received arguments: path/);
	});
});
