import { attachmentFromBlob } from '../../extensions/codeforge/src/views/attachments';

const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('attachmentFromBlob image gating', () => {
	it('attaches an image when a vision-capable model is available', () => {
		const att = attachmentFromBlob({ name: 'shot.png', mime: 'image/png', base64: PNG_BASE64 }, true);
		expect(att?.kind).toBe('image');
		expect(att?.dataUrl).toContain('data:image/png;base64,');
	});

	it('refuses to attach an image when no vision-capable model is configured', () => {
		const att = attachmentFromBlob({ name: 'shot.png', mime: 'image/png', base64: PNG_BASE64 }, false);
		expect(att).toBeUndefined();
	});

	it('still attaches a non-image file even when image attach is disabled', () => {
		const base64 = Buffer.from('console.log(1);').toString('base64');
		const att = attachmentFromBlob({ name: 'script.js', mime: 'text/javascript', base64 }, false);
		expect(att?.kind).toBe('text');
		expect(att?.text).toBe('console.log(1);');
	});

	it('defaults to allowing images when the flag is omitted (back-compat)', () => {
		const att = attachmentFromBlob({ name: 'shot.png', mime: 'image/png', base64: PNG_BASE64 });
		expect(att?.kind).toBe('image');
	});
});
