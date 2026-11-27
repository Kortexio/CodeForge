/** One pending screenshot data-URL for the next model message. Not written to the wiki. */

let pending: string | undefined;

export function setPendingVision(dataUrl: string | undefined): void {
	pending = dataUrl;
}

export function consumePendingVision(): string | undefined {
	const shot = pending;
	pending = undefined;
	return shot;
}
