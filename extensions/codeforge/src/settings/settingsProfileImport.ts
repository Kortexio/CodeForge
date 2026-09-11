/**
 * Read codeforge.ai.settings.v1 from sibling VS Code profile state.vscdb files
 * (installed CodeForge vs vscode:dev) so servers can be unified on disk.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AiSettingsState } from './aiSettingsStore';

const STATE_FIELD = 'codeforge.ai.settings.v1';
const EXT_KEYS = ['kortexio.codeforge', 'kortexio.opencodeide-ai'];

export async function readSettingsFromProfileDbs(
	log?: (line: string) => void
): Promise<AiSettingsState[]> {
	const home = os.homedir();
	const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
	const candidates = [
		path.join(appdata, 'CodeForge', 'User', 'globalStorage', 'state.vscdb'),
		path.join(appdata, 'code-oss-dev', 'User', 'globalStorage', 'state.vscdb'),
		path.join(home, '.codeforge-shared', 'sharedStorage', 'state.vscdb'),
	];

	const out: AiSettingsState[] = [];
	for (const db of candidates) {
		if (!fs.existsSync(db)) continue;
		const state = readSettingsFromVscdb(db, log);
		if (state?.servers?.length) {
			log?.(`[settings-import] ${db}: ${state.servers.length} server(s)`);
			out.push(state);
		}
	}
	return out;
}

function readSettingsFromVscdb(
	dbPath: string,
	log?: (line: string) => void
): AiSettingsState | undefined {
	// Prefer Node's experimental node:sqlite when available (Electron/Node 22+).
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const sqlite = require('node:sqlite') as {
			DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
				prepare: (sql: string) => { get: (...args: unknown[]) => { value?: string } | undefined };
				close: () => void;
			};
		};
		const tmp = path.join(os.tmpdir(), `cf-settings-${Date.now()}.db`);
		fs.copyFileSync(dbPath, tmp);
		try {
			const db = new sqlite.DatabaseSync(tmp, { readOnly: true });
			for (const ext of EXT_KEYS) {
				const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(ext) as
					| { value?: string }
					| undefined;
				const state = parseExtensionBlob(row?.value);
				if (state?.servers?.length) {
					db.close();
					return state;
				}
			}
			db.close();
		} finally {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* ignore */
			}
		}
	} catch (err) {
		log?.(
			`[settings-import] node:sqlite unavailable (${err instanceof Error ? err.message : String(err)}); trying python`
		);
	}

	return readSettingsViaPython(dbPath, log);
}

function parseExtensionBlob(raw?: string): AiSettingsState | undefined {
	if (!raw) return undefined;
	try {
		const data = JSON.parse(raw) as Record<string, unknown>;
		const field = data[STATE_FIELD];
		const inner =
			typeof field === 'string'
				? (JSON.parse(field) as AiSettingsState)
				: (field as AiSettingsState);
		if (inner && Array.isArray(inner.servers)) {
			return inner;
		}
	} catch {
		/* ignore */
	}
	return undefined;
}

function readSettingsViaPython(
	dbPath: string,
	log?: (line: string) => void
): AiSettingsState | undefined {
	const script = `
import json, shutil, sqlite3, sys, tempfile, os
db=sys.argv[1]
tmp=os.path.join(tempfile.gettempdir(), "cf-imp-"+str(os.getpid())+".db")
shutil.copy2(db, tmp)
con=sqlite3.connect(tmp)
cur=con.cursor()
for ext in ${JSON.stringify(EXT_KEYS)}:
    row=cur.execute("SELECT value FROM ItemTable WHERE key=?", (ext,)).fetchone()
    if not row: continue
    data=json.loads(row[0])
    field=data.get(${JSON.stringify(STATE_FIELD)})
    if isinstance(field, str):
        field=json.loads(field)
    if isinstance(field, dict) and isinstance(field.get("servers"), list):
        print(json.dumps(field))
        break
con.close()
os.unlink(tmp)
`;
	try {
		const r = spawnSync('python', ['-c', script, dbPath], {
			encoding: 'utf8',
			windowsHide: true,
			timeout: 15_000,
		});
		if (r.status !== 0) {
			log?.(`[settings-import] python exit ${r.status}: ${(r.stderr || '').slice(0, 160)}`);
			return undefined;
		}
		const text = (r.stdout || '').trim();
		if (!text) return undefined;
		const parsed = JSON.parse(text) as AiSettingsState;
		return Array.isArray(parsed.servers) ? parsed : undefined;
	} catch (err) {
		log?.(
			`[settings-import] python failed: ${err instanceof Error ? err.message : String(err)}`
		);
		return undefined;
	}
}
