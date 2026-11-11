/**
 * Allowlisted environment for MCP stdio children — never inherit the full host env.
 */

const MCP_ENV_ALLOWLIST = new Set([
	'PATH',
	'Path',
	'PATHEXT',
	'SystemRoot',
	'SYSTEMROOT',
	'windir',
	'WINDIR',
	'USERPROFILE',
	'HOME',
	'HOMEDRIVE',
	'HOMEPATH',
	'USERNAME',
	'USER',
	'TEMP',
	'TMP',
	'TMPDIR',
	'LANG',
	'LC_ALL',
	'APPDATA',
	'LOCALAPPDATA',
	'ProgramFiles',
	'ProgramFiles(x86)',
	'ProgramData',
	'ComSpec',
	'COMSPEC',
	'NUMBER_OF_PROCESSORS',
	'PROCESSOR_ARCHITECTURE',
	'OS',
	'TERM',
	'HOMEBREW_PREFIX',
	'NVM_DIR',
	'NVM_BIN',
]);

/** True when an npx/npm package arg uses a floating @latest tag. */
export function mcpArgsUseLatest(args: string[] | undefined): boolean {
	return (args ?? []).some(a => /@latest\b/i.test(a) || /\/latest$/i.test(a));
}

/**
 * Build spawn env: allowlisted host vars + optional file/server overlays.
 * Explicit server.env / fileEnv always win (needed for MCP auth tokens).
 */
export function buildMcpSpawnEnv(
	fileEnv?: Record<string, string>,
	serverEnv?: Record<string, string>,
	hostEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const key of MCP_ENV_ALLOWLIST) {
		const v = hostEnv[key];
		if (v !== undefined) out[key] = v;
	}
	if (fileEnv) {
		for (const [k, v] of Object.entries(fileEnv)) {
			if (v !== undefined) out[k] = v;
		}
	}
	if (serverEnv) {
		for (const [k, v] of Object.entries(serverEnv)) {
			if (v !== undefined) out[k] = v;
		}
	}
	return out;
}
