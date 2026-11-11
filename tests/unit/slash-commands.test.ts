import {
	getSlashCommand,
	listSlashCommands,
	parseSlashInput,
} from '../../extensions/codeforge/src/views/slashCommands';

describe('slash commands', () => {
	it('registers review, bugbot and restore', () => {
		const names = listSlashCommands().map(c => c.name);
		expect(names).toEqual(expect.arrayContaining(['review', 'bugbot', 'restore']));
		expect(getSlashCommand('bugbot')?.description).toMatch(/review/i);
		expect(parseSlashInput('/bugbot src/Cart.cs')).toEqual({
			command: 'bugbot',
			args: 'src/Cart.cs',
		});
		expect(parseSlashInput('/restore')).toEqual({ command: 'restore', args: '' });
	});
});
