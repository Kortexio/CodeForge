/**
 * Re-export disk-backed TraceService (kept for stable import paths).
 */
export {
	TraceService,
	initTrace,
	getTrace,
	type TraceEvent,
	type TraceLevel,
} from '../storage/traceService';
