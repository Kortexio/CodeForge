/**
 * Memory engine facade — session wiki + project wiki + temporal facts.
 */

export {
	SessionWikiStore,
	getSessionWikiStore,
	emptySessionWiki,
	type SessionWiki,
	type WikiPage,
	type WorkingMemory,
} from './sessionWiki';

export {
	ProjectWikiStore,
	getProjectWikiStore,
	initProjectWiki,
	ensureProjectWiki,
	type WikiDocument,
	type TemporalFact,
} from './projectWiki';
