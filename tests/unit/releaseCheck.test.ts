/**
 * Unit tests for release version parsing / comparison (no network).
 */

import {
	compareSemver,
	defaultGithubRepo,
	isNewerVersion,
	parseVersionTag,
	pickDownloadUrl,
} from '../../extensions/codeforge/src/platform/releaseCheck';

describe('releaseCheck semver', () => {
	it('parses tags with optional v prefix', () => {
		expect(parseVersionTag('v0.1.2')).toEqual({ major: 0, minor: 1, patch: 2 });
		expect(parseVersionTag('0.1.2')).toEqual({ major: 0, minor: 1, patch: 2 });
		expect(parseVersionTag('V1.0.0-beta.1')).toEqual({ major: 1, minor: 0, patch: 0 });
		expect(parseVersionTag('not-a-version')).toBeNull();
	});

	it('compares semver correctly', () => {
		expect(compareSemver({ major: 0, minor: 1, patch: 3 }, { major: 0, minor: 1, patch: 2 })).toBeGreaterThan(0);
		expect(compareSemver({ major: 0, minor: 1, patch: 2 }, { major: 0, minor: 2, patch: 0 })).toBeLessThan(0);
		expect(compareSemver({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 })).toBe(0);
	});

	it('detects newer remote tags', () => {
		expect(isNewerVersion('v0.1.3', '0.1.2')).toBe(true);
		expect(isNewerVersion('0.1.2', '0.1.2')).toBe(false);
		expect(isNewerVersion('0.1.1', '0.1.2')).toBe(false);
		expect(isNewerVersion('bad', '0.1.2')).toBe(false);
	});
});

describe('releaseCheck download url', () => {
	it('prefers override, then exe asset, then html_url', () => {
		const release = {
			tag_name: 'v0.2.0',
			html_url: 'https://github.com/Kortexio/CodeForge/releases/tag/v0.2.0',
			assets: [
				{ name: 'notes.txt', browser_download_url: 'https://example.com/notes.txt' },
				{
					name: 'CodeForgeSetup.exe',
					browser_download_url: 'https://example.com/CodeForgeSetup.exe',
				},
			],
		};
		expect(pickDownloadUrl(release, 'https://cdn.example/app')).toBe('https://cdn.example/app');
		expect(pickDownloadUrl(release)).toBe('https://example.com/CodeForgeSetup.exe');
		expect(pickDownloadUrl({ ...release, assets: [] })).toBe(release.html_url);
	});
});

describe('releaseCheck default repo', () => {
	it('maps app name to GitHub repo', () => {
		expect(defaultGithubRepo('CodeForge')).toBe('Kortexio/CodeForge');
		expect(defaultGithubRepo('CodeForgeZ')).toBe('Kortexio/CodeForgeZ');
		expect(defaultGithubRepo('CodeForge Z')).toBe('Kortexio/CodeForgeZ');
	});
});
