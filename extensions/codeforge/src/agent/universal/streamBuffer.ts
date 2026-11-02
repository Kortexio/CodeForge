/**
 * Buffers a tail of streamed assistant text so a grammar marker split across SSE chunks (e.g.
 * `<tool_c` in one chunk, `all>` in the next — one of the root causes in the grammar-leakage
 * survey) is never scanned, or shown to the user, half-formed. Holds back up to `prefixSize`
 * characters (default 1 KB — comfortably larger than any single family marker) behind the
 * emitted text; `maxSize` (default 8 KB) is a hard cap so ordinary prose that merely starts with
 * marker-like characters cannot stall output forever.
 */

export interface StreamBufferOptions {
	/** Tail size held back from emission, in characters. Default 1024 (1 KB). */
	prefixSize?: number;
	/** Hard cap on how large the held-back tail may grow before it is force-flushed. Default 8192 (8 KB). */
	maxSize?: number;
}

export class StreamBuffer {
	private held = '';
	private readonly prefixSize: number;
	private readonly maxSize: number;

	constructor(opts: StreamBufferOptions = {}) {
		this.prefixSize = opts.prefixSize ?? 1024;
		this.maxSize = opts.maxSize ?? 8192;
	}

	/** Text currently held back (for marker detection against the full pending tail). */
	pending(): string {
		return this.held;
	}

	/**
	 * Feed a new chunk. Returns the text now safe to emit (process for family-grammar markers,
	 * then show to the user); up to `prefixSize` characters stay held for the next chunk.
	 */
	push(chunk: string): string {
		const combined = this.held + chunk;
		if (combined.length <= this.prefixSize) {
			this.held = combined;
			return '';
		}
		const emit = combined.slice(0, combined.length - this.prefixSize);
		this.held = combined.slice(combined.length - this.prefixSize);
		return emit;
	}

	/** True once the held tail has hit `maxSize` — the caller should flush to avoid starving output. */
	isOverCap(): boolean {
		return this.held.length >= this.maxSize;
	}

	/** Emit everything held (stream end, or `isOverCap()` forcing a flush). Resets the buffer. */
	flush(): string {
		const rest = this.held;
		this.held = '';
		return rest;
	}
}
