import * as vscode from 'vscode';
import { attachmentsFromChatRequest } from '../../extensions/codeforge/src/views/attachments';

describe('attachmentsFromChatRequest', () => {
	it('turns ChatReferenceBinaryData into an image attachment', async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		const request = {
			references: [
				{
					name: 'shot.png',
					value: {
						mimeType: 'image/png',
						data: async () => new Uint8Array(png),
					},
				},
			],
		};
		const out = await attachmentsFromChatRequest(request, true);
		expect(out).toHaveLength(1);
		expect(out[0].kind).toBe('image');
		expect(out[0].mime).toBe('image/png');
		expect(out[0].dataUrl).toMatch(/^data:image\/png;base64,/);
		expect(out[0].dataUrl).not.toMatch(/coming soon|placeholder/i);
	});

	it('skips images when vision is off', async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const out = await attachmentsFromChatRequest(
			{
				references: [
					{
						name: 'shot.png',
						value: { mimeType: 'image/png', data: async () => new Uint8Array(png) },
					},
				],
			},
			false
		);
		expect(out).toHaveLength(0);
	});

	it('collects file URIs from Location-shaped references', async () => {
		const uri = vscode.Uri.file('C:/tmp/note.md');
		const out = await attachmentsFromChatRequest({
			references: [{ name: 'note.md', value: { uri } }],
		});
		expect(out.length).toBeGreaterThan(0);
		expect(out[0].kind).toMatch(/text|uri/);
	});
});
