/**
 * Opt-in small-model harness. No auto-detection by model size/name —
 * the user chooses on or off in Settings.
 */

export type WeakModelMode = 'off' | 'on';

export interface WeakModelHints {
	modelId?: string | null;
	baseUrl?: string | null;
	numCtx?: number | null;
}

/**
 * Whether the weak-model harness is active for this run.
 * Hints are ignored; only `mode` matters (kept for call-site compatibility).
 */
export function isWeakModel(_hints: WeakModelHints = {}, mode: WeakModelMode = 'off'): boolean {
	return mode === 'on';
}

/**
 * Normalize setting / legacy values.
 * - `on` and legacy `force` → on
 * - everything else (including legacy `auto`) → off
 */
export function resolveWeakModelMode(raw: unknown): WeakModelMode {
	const v = String(raw ?? 'off').toLowerCase();
	if (v === 'on' || v === 'force') return 'on';
	return 'off';
}
