import fs from 'fs';

const nlsPath = 'VSCode-win32-x64/resources/app/out/nls.messages.json';
const m = JSON.parse(fs.readFileSync(nlsPath, 'utf8'));

const replacements = {
	22520: 'Run commands without reaching for your mouse to accomplish any task in CodeForge.\n{0}',
	22522: 'Run commands without reaching for your mouse to accomplish any task in CodeForge.\n{0}',
	22531:
		"Extensions are CodeForge's power-ups. They range from handy productivity hacks, expanding out-of-the-box features, to adding completely new capabilities.\n{0}",
	22533: "Extensions are CodeForge's power-ups. A growing number are becoming available in the web.\n{0}",
	22571:
		'Customize every aspect of CodeForge and [sync](command:workbench.userDataSync.actions.turnOn) customizations across devices.\n{0}',
	22576:
		"You're all set to start coding. You can open a local project or a remote repository to get your files into CodeForge.\n{0}\n{1}",
	22577: 'Get started with CodeForge',
	22578: 'Setup CodeForge',
	22579:
		'Learn the tools and shortcuts that make CodeForge accessible. Note that some actions are not actionable from within the context of the walkthrough.',
	22581: 'Setup CodeForge Accessibility',
	22583: 'Get Started with CodeForge for the Web',
	22584: 'Setup CodeForge Web',
	22601: 'Connect your own models in CodeForge AI Settings, then start building with Agent.\n{0}',
	22602: 'Connect CodeForge AI',
	22672: ' to access all CodeForge commands.',
	22699: 'Welcome to CodeForge',
};

for (const [k, v] of Object.entries(replacements)) {
	m[Number(k)] = v;
}

fs.writeFileSync(nlsPath, JSON.stringify(m));
console.log('nls patched', Object.keys(replacements).length);
console.log('22577=', m[22577]);
console.log('22602=', m[22602]);
