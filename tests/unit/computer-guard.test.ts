/**
 * Computer-use guard: no auto-approve, input pauses while the approval dialog is open,
 * headless/non-Windows does not pretend success.
 */
jest.mock('vscode', () => require('../support/vscodeFsMock'));

import { ApprovalPolicy } from '../../extensions/codeforge/src/policy/approvalPolicy';
import {
	computerInputBlockedReason,
	computerUnavailableReason,
	isComputerTool,
} from '../../extensions/codeforge/src/computer/guard';
import { setApprovalDialogOpenForTests } from '../../extensions/codeforge/src/ui/approvalDialog';
import { webFetchBlockedReason } from '../../extensions/codeforge/src/agent/webTools';

describe('computer grant and web fetch guards', () => {
	const policy = new ApprovalPolicy({
		globalState: { get: () => undefined, update: async () => undefined },
	} as never);

	afterEach(() => {
		setApprovalDialogOpenForTests(false);
	});

	it('does not auto-approve computer tools when allow-all is on', () => {
		jest.spyOn(policy, 'globalAllowAllEnabled').mockReturnValue(true);
		expect(policy.isAutoApproved('computer_click')).toBe(false);
		expect(policy.isAutoApproved('computer_session')).toBe(false);
		expect(policy.isAutoApproved('shell')).toBe(true);
	});

	it('refuses computer input while an approval dialog is open', () => {
		expect(isComputerTool('computer_click')).toBe(true);
		setApprovalDialogOpenForTests(true);
		expect(computerInputBlockedReason('computer_click')).toMatch(/Not run:/);
		expect(computerInputBlockedReason('computer_screenshot')).toBeNull();
	});

	it('reports Not run when the desktop channel is closed', () => {
		const reason = computerUnavailableReason();
		if (process.platform !== 'win32' || process.env.CI === 'true') {
			expect(reason).toMatch(/Not run:/);
		}
	});

	it('blocks file and metadata URLs and allows localhost', () => {
		expect(webFetchBlockedReason('file:///c:/secret')).toMatch(/Error:/);
		expect(webFetchBlockedReason('http://169.254.169.254/latest')).toMatch(/Error:/);
		expect(webFetchBlockedReason('http://127.0.0.1:3000/')).toBeNull();
	});
});
