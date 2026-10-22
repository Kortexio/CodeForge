/**
 * Terminate a spawned process and its children (Windows job tree via taskkill).
 */

import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';

export function killProcessTree(child: ChildProcess): void {
	if (!child.pid) {
		try {
			child.kill();
		} catch {
			/* ignore */
		}
		return;
	}
	if (process.platform === 'win32') {
		execFile(
			'taskkill',
			['/pid', String(child.pid), '/T', '/F'],
			{ windowsHide: true },
			() => {
				/* best-effort */
			}
		);
		return;
	}
	try {
		child.kill('SIGTERM');
	} catch {
		try {
			child.kill();
		} catch {
			/* ignore */
		}
	}
}
