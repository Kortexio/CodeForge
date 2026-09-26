/**
 * Check GitHub releases/latest and offer a download link when a newer tag exists.
 * No silent installer — toast + openExternal only.
 */

import * as vscode from 'vscode';

const SKIPPED_VERSION_KEY = 'codeforge.update.skippedVersion';
const USER_AGENT = 'CodeForge';

export type Semver = { major: number; minor: number; patch: number };

/** Strip leading `v` / `V` and parse `major.minor.patch` (extra suffixes ignored). */
export function parseVersionTag(raw: string): Semver | null {
	const cleaned = String(raw || '')
		.trim()
		.replace(/^[vV]/, '')
		.split(/[-+_]/)[0];
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
	};
}

/** Positive if a > b, negative if a < b, 0 if equal. */
export function compareSemver(a: Semver, b: Semver): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

export function isNewerVersion(remoteTag: string, localVersion: string): boolean {
	const remote = parseVersionTag(remoteTag);
	const local = parseVersionTag(localVersion);
	if (!remote || !local) return false;
	return compareSemver(remote, local) > 0;
}

export type GithubReleaseLatest = {
	tag_name: string;
	html_url: string;
	assets?: Array<{ name: string; browser_download_url: string }>;
};

/** Prefer Windows .exe asset when present; otherwise release page. */
export function pickDownloadUrl(
	release: GithubReleaseLatest,
	overrideUrl?: string
): string {
	const override = String(overrideUrl || '').trim();
	if (override) return override;
	const exe = (release.assets || []).find(a => /\.exe$/i.test(a.name || ''));
	if (exe?.browser_download_url) return exe.browser_download_url;
	return release.html_url;
}

export function defaultGithubRepo(appName?: string): string {
	const name = (appName || '').toLowerCase().replace(/[\s_-]+/g, '');
	if (name.includes('codeforgez')) return 'Kortexio/CodeForgeZ';
	return 'Kortexio/CodeForge';
}

export type ReleaseCheckResult =
	| { status: 'up-to-date'; local: string; remote: string }
	| { status: 'update-available'; local: string; remote: string; downloadUrl: string; htmlUrl: string }
	| { status: 'skipped'; local: string; remote: string }
	| { status: 'error'; message: string };

export type ReleaseCheckOptions = {
	context: vscode.ExtensionContext;
	/** When true, show a message even if up-to-date / on network errors. */
	interactive: boolean;
	/** Optional fetch override for tests. */
	fetchImpl?: typeof fetch;
};

function readUpdateConfig() {
	const cfg = vscode.workspace.getConfiguration('codeforge.update');
	const ext = vscode.extensions.getExtension('kortexio.codeforge');
	const pkgVersion =
		(ext?.packageJSON?.version as string | undefined) ||
		cfg.get<string>('currentVersion') ||
		'0.0.0';
	const currentVersion = (cfg.get<string>('currentVersion') || '').trim() || pkgVersion;
	const githubRepo =
		(cfg.get<string>('githubRepo') || '').trim() ||
		defaultGithubRepo(vscode.env.appName);
	const apiBaseUrl = (cfg.get<string>('apiBaseUrl') || 'https://api.github.com').replace(
		/\/$/,
		''
	);
	const downloadUrl = (cfg.get<string>('downloadUrl') || '').trim();
	return { currentVersion, githubRepo, apiBaseUrl, downloadUrl };
}

export async function fetchLatestRelease(
	apiBaseUrl: string,
	githubRepo: string,
	fetchImpl: typeof fetch = fetch
): Promise<GithubReleaseLatest> {
	const url = `${apiBaseUrl}/repos/${githubRepo}/releases/latest`;
	const res = await fetchImpl(url, {
		headers: {
			Accept: 'application/vnd.github+json',
			'User-Agent': USER_AGENT,
		},
	});
	if (!res.ok) {
		throw new Error(`GitHub releases/latest HTTP ${res.status}`);
	}
	return (await res.json()) as GithubReleaseLatest;
}

export async function checkForAppUpdate(
	opts: ReleaseCheckOptions
): Promise<ReleaseCheckResult> {
	const { currentVersion, githubRepo, apiBaseUrl, downloadUrl } = readUpdateConfig();
	let release: GithubReleaseLatest;
	try {
		release = await fetchLatestRelease(apiBaseUrl, githubRepo, opts.fetchImpl);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (opts.interactive) {
			void vscode.window.showWarningMessage(`Could not check for updates: ${message}`);
		}
		return { status: 'error', message };
	}

	const remote = release.tag_name || '';
	if (!isNewerVersion(remote, currentVersion)) {
		if (opts.interactive) {
			void vscode.window.showInformationMessage(
				`CodeForge is up to date (${currentVersion}).`
			);
		}
		return { status: 'up-to-date', local: currentVersion, remote };
	}

	const skipped = opts.context.globalState.get<string>(SKIPPED_VERSION_KEY);
	const remoteParsed = parseVersionTag(remote);
	const skippedParsed = skipped ? parseVersionTag(skipped) : null;
	if (
		remoteParsed &&
		skippedParsed &&
		compareSemver(remoteParsed, skippedParsed) === 0 &&
		!opts.interactive
	) {
		return { status: 'skipped', local: currentVersion, remote };
	}

	const link = pickDownloadUrl(release, downloadUrl);
	const choice = await vscode.window.showInformationMessage(
		`CodeForge ${remote} is available (you have ${currentVersion}).`,
		'Download',
		'Later',
		'Skip this version'
	);
	if (choice === 'Download') {
		await vscode.env.openExternal(vscode.Uri.parse(link));
	} else if (choice === 'Skip this version') {
		await opts.context.globalState.update(SKIPPED_VERSION_KEY, remote);
	}
	return {
		status: 'update-available',
		local: currentVersion,
		remote,
		downloadUrl: link,
		htmlUrl: release.html_url,
	};
}

/** Delayed startup check when codeforge.update.checkOnStartup !== false. */
export function scheduleStartupUpdateCheck(context: vscode.ExtensionContext): void {
	const cfg = vscode.workspace.getConfiguration('codeforge.update');
	if (cfg.get<boolean>('checkOnStartup') === false) return;
	const timer = setTimeout(() => {
		void checkForAppUpdate({ context, interactive: false });
	}, 3000);
	context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
