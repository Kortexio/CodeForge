/**
 * Context-window accounting against the server's real token counts (pure, unit-testable).
 */

const OVERFLOW_PATTERN =
	/exceed[s_ ]*(the[_ ])?(available[_ ])?context|context[_ ]?(length|size|window)[_ ]?(exceeded|error)?|maximum context|too many tokens|prompt is too long|input is too long|n_ctx/i;

export function isContextOverflowError(status: number, text: string): boolean {
	if (status !== 400 && status !== 413 && status !== 500) return false;
	return OVERFLOW_PATTERN.test(text);
}

/** llama.cpp: `{"n_prompt_tokens":32789,"n_ctx":32768}`; OpenAI-style: "... 40000 tokens ... maximum context length is 32768". */
export function parseOverflowTokens(text: string): { prompt?: number; ctx?: number } {
	const num = (re: RegExp) => {
		const m = re.exec(text);
		return m ? Number(m[1]) : undefined;
	};
	const prompt =
		num(/n_prompt_tokens"?\s*[:=]\s*(\d+)/i) ??
		num(/(\d+)\s*>\s*\d+/) ??
		num(/resulted in\s+(\d+)\s+tokens/i) ??
		num(/prompt is too long:\s*(\d+)/i);
	const ctx =
		num(/n_ctx"?\s*[:=]\s*(\d+)/i) ??
		num(/\d+\s*>\s*(\d+)/) ??
		num(/maximum context length is\s+(\d+)/i);
	return { prompt, ctx };
}

const MIN_RATIO = 0.8;
const MAX_RATIO = 2.5;

/** Ratio of real prompt tokens to the chars/4 estimate, smoothed across rounds; only ever rises quickly. */
export function updateTokenCalibration(
	prev: number,
	estimatedTokens: number,
	actualPromptTokens?: number
): number {
	if (!actualPromptTokens || !estimatedTokens || actualPromptTokens <= 0) return prev;
	const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, actualPromptTokens / estimatedTokens));
	return ratio > prev ? ratio : prev * 0.7 + ratio * 0.3;
}

export function calibratedTokens(estimatedTokens: number, calibration: number): number {
	return Math.ceil(estimatedTokens * calibration);
}
