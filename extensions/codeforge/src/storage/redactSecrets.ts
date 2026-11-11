/**
 * Redact common secret patterns from logs/traces before they hit disk or OutputChannel.
 */

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
	{ re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [REDACTED]' },
	{ re: /\bsk-[A-Za-z0-9]{8,}/g, replacement: 'sk-[REDACTED]' },
	{ re: /\bsk-ant-[A-Za-z0-9\-_]{8,}/g, replacement: 'sk-ant-[REDACTED]' },
	{ re: /\bxai-[A-Za-z0-9]{8,}/g, replacement: 'xai-[REDACTED]' },
	{ re: /\bghp_[A-Za-z0-9]{20,}/g, replacement: 'ghp_[REDACTED]' },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: 'github_pat_[REDACTED]' },
	{ re: /\bAIza[0-9A-Za-z\-_]{20,}/g, replacement: 'AIza[REDACTED]' },
	{
		re: /\b(api[_-]?key|token|password|secret|authorization)\s*[=:]\s*["']?[^\s"'&,;]+/gi,
		replacement: '$1=[REDACTED]',
	},
];

export function redactSecrets(text: string | undefined | null): string {
	if (!text) return '';
	let out = text;
	for (const { re, replacement } of PATTERNS) {
		out = out.replace(re, replacement);
	}
	return out;
}
