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

	describe('leaked Qwen XML parameter markers', () => {
		const VIP_OLD = '\tprivate const decimal VipRate = 0.1m;';
		const VIP_NEW = '\tprivate const decimal VipRate = 0.15m;';

		it('splits </old_string><parameter=new_string> into separate args when new_string is missing', () => {
			const r = normalizeToolCall({
				name: 'edit',
				args: {
					path: 'src/Acme.Billing/PricingRules.cs',
					old_string: `${VIP_OLD}\n</old_string>\n<parameter=new_string>\n${VIP_NEW}\n</parameter>`,
				},
				activeToolNames: CORE,
				toolSchemas: SCHEMAS,
			});
			expect(r.error).toBeUndefined();
			expect(r.args.old_string).toBe(VIP_OLD);
			expect(r.args.new_string).toBe(VIP_NEW);
			expect(r.leakedArgs).toEqual(['old_string']);
			expect(r.notes.join(' ')).toMatch(/close every value with <\/parameter>/);
		});

		it('keeps the separate value when it matches the leaked one', () => {
			const r = normalizeToolCall({
				name: 'edit',
				args: {
					path: 'a.cs',
					old_string: `${VIP_OLD}\n</old_string>\n<parameter=new_string>\n${VIP_NEW}`,
					new_string: VIP_NEW,
				},
				activeToolNames: CORE,
				toolSchemas: SCHEMAS,
			});
			expect(r.error).toBeUndefined();
			expect(r.args.old_string).toBe(VIP_OLD);
			expect(r.args.new_string).toBe(VIP_NEW);
		});

		it('treats a separate new_string equal to the old text as an echo (T2 sample)', () => {
			const oldBody = "\tif (now > new Date(coupon.expires)) {\n\t\tthrow new Error('EXPIRED_COUPON');\n\t}";
			const newBody =
				"\tconst expiresDate = new Date(coupon.expires);\n\texpiresDate.setHours(23, 59, 59, 999);\n\tif (now > expiresDate) {\n\t\tthrow new Error('EXPIRED_COUPON');\n\t}";
			const r = normalizeToolCall({
				name: 'edit',
				args: {
					old_string: `${oldBody}\n</old_string>\n<parameter=new_string>\n${newBody}`,
					path: 'src/pricing/coupons.js',
					new_string: oldBody,
				},
				activeToolNames: CORE,
				toolSchemas: SCHEMAS,
			});
			expect(r.error).toBeUndefined();
			expect(r.args.old_string).toBe(oldBody);
			expect(r.args.new_string).toBe(newBody);
		});

		it('accepts a parameter that leaks into itself with the same value (CS3 sample)', () => {
			const r = normalizeToolCall({
				name: 'edit',
				args: {
					new_string: '| vip      | 15%      |\n</old_string>\n<parameter=new_string>\n| vip      | 15%      |',
					old_string: '| vip      | 10%      |',
					path: 'docs/pricing.md',
				},
				activeToolNames: CORE,
				toolSchemas: SCHEMAS,
			});
			expect(r.error).toBeUndefined();
			expect(r.args.old_string).toBe('| vip      | 10%      |');
			expect(r.args.new_string).toBe('| vip      | 15%      |');
			expect(r.leakedArgs).toEqual(['new_string']);
		});

		it('refuses a self-leak whose repeated value differs', () => {
			const r = normalizeToolCall({
				name: 'edit',
				args: {
					new_string: 'a = 2\n</new_string>\n<parameter=new_string>\na = 3',
					old_string: 'a = 1',
					path: 'x.py',
				},
				activeToolNames: CORE,
				toolSchemas: SCHEMAS,
			});
			expect(r.error).toMatch(/the repeated new_string inside it has a different value/);
		});

		it('refuses instead of guessing when the separate value differs', () => {
			const r = normalizeToolCall({
				name: 'edit',
				args: {
					path: 'a.cs',
					old_string: `${VIP_OLD}\n</old_string>\n<parameter=new_string>\n${VIP_NEW}`,
					new_string: '\tprivate const decimal VipRate = 0.2m;',
				},
				activeToolNames: CORE,
				toolSchemas: SCHEMAS,
			});
			expect(r.error).toMatch(/argument old_string contains the start of another parameter/);
			expect(r.error).toMatch(/Close every parameter value with <\/parameter>/);
			expect(r.leakedArgs).toEqual(['old_string']);
		});

		it('recovers several leaked parameters in a row', () => {
			const r = normalizeToolCall({
				name: 'edit',
				args: {
					path: `a.cs\n</path>\n<parameter=old_string>\n${VIP_OLD}\n</parameter>\n<parameter=new_string>\n${VIP_NEW}\n</parameter>\n</function>`,
				},
				activeToolNames: CORE,
				toolSchemas: SCHEMAS,
			});
			expect(r.error).toBeUndefined();
			expect(r.args.path).toBe('a.cs');
			expect(r.args.old_string).toBe(VIP_OLD);
			expect(r.args.new_string).toBe(VIP_NEW);
		});

		it('leaves file content alone when the names are not parameters of the tool', () => {
			const html = '<div>\n</div>\n<parameter=color>\nred\n</parameter>';
			const r = normalizeToolCall({
				name: 'write',
				args: { path: 'a.html', content: html },
				activeToolNames: CORE,
				toolSchemas: SCHEMAS,
			});
			expect(r.error).toBeUndefined();
			expect(r.args.content).toBe(html);
			expect(r.leakedArgs).toBeUndefined();
		});
	});
});
