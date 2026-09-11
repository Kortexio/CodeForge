/**
 * Canonical CodeForge on-disk layout.
 *
 * ~/.CodeForge/
 *   ai/sessions/{id}/
 *   ai/memory/{wsHash}/
 *   ai/artifacts/
 *   ai/traces/
 *   ai/policies/
 *   ai/settings.json   # shared servers/models/MCP (install + vscode:dev)
 *   skills/
 *   rules/
 *   hooks.json + hooks/
 *   code-index/{wsHash}/
 *   model-cache/
 * {workspace}/.CodeForge/
 *   memory/
 *   skills/ rules/ hooks.json
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export function homeRoot(): string {
	return path.join(os.homedir(), '.CodeForge');
}

export function workspaceRoot(workspaceFolder?: string): string | undefined {
	if (!workspaceFolder) return undefined;
	return path.join(workspaceFolder, '.CodeForge');
}

export function workspaceHash(workspaceFolder: string): string {
	return crypto.createHash('sha256').update(workspaceFolder.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16);
}

export function sessionsDir(): string {
	return path.join(homeRoot(), 'ai', 'sessions');
}

export function sessionDir(sessionId: string): string {
	return path.join(sessionsDir(), sessionId);
}

export function artifactsDir(): string {
	return path.join(homeRoot(), 'ai', 'artifacts');
}

export function tracesDir(): string {
	return path.join(homeRoot(), 'ai', 'traces');
}

export function policiesDir(): string {
	return path.join(homeRoot(), 'ai', 'policies');
}

export function skillsDir(): string {
	return path.join(homeRoot(), 'skills');
}

export function rulesDir(): string {
	return path.join(homeRoot(), 'rules');
}

export function hooksDir(): string {
	return path.join(homeRoot(), 'hooks');
}

/** Shared AI servers/models/MCP across install + vscode:dev profiles. */
export function aiSettingsFile(): string {
	return path.join(homeRoot(), 'ai', 'settings.json');
}

export function codeIndexDir(workspaceFolder: string): string {
	return path.join(homeRoot(), 'code-index', workspaceHash(workspaceFolder));
}

export function modelCacheDir(): string {
	return path.join(homeRoot(), 'model-cache');
}

/** Project memory lives in the workspace when available; falls back to ~/.CodeForge/ai/memory/{hash}. */
export function projectMemoryDir(workspaceFolder?: string): string {
	if (workspaceFolder) {
		return path.join(workspaceFolder, '.CodeForge', 'memory');
	}
	return path.join(homeRoot(), 'ai', 'memory', 'default');
}

export function sessionWikiDir(sessionId: string): string {
	return path.join(sessionDir(sessionId), 'wiki');
}

export async function ensureDir(dir: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

/** Create the top-level home layout (idempotent). */
export async function ensureHomeLayout(): Promise<void> {
	await Promise.all([
		ensureDir(sessionsDir()),
		ensureDir(artifactsDir()),
		ensureDir(tracesDir()),
		ensureDir(policiesDir()),
		ensureDir(skillsDir()),
		ensureDir(rulesDir()),
		ensureDir(hooksDir()),
		ensureDir(path.join(homeRoot(), 'ai')),
		ensureDir(modelCacheDir()),
		ensureDir(path.join(homeRoot(), 'ai', 'memory')),
		ensureDir(path.join(homeRoot(), 'code-index')),
	]);
}
