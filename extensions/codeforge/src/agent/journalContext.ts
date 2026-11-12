/**
 * Per-async-stack journal identity so two concurrent sessions do not clobber setContext.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface JournalAls {
	sessionId: string;
	turn: number;
}

const als = new AsyncLocalStorage<JournalAls>();

export function runWithJournalContext<T>(ctx: JournalAls, fn: () => T): T {
	return als.run(ctx, fn);
}

export function journalContext(): JournalAls | undefined {
	return als.getStore();
}
