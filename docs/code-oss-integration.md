# Code-OSS Integration — OpenCodeIDE

## Goal

Run OpenCodeIDE as a **branded Code-OSS** with the embedded AI extension loaded.

## Architecture

```
CodeForge/
├── vscode/                      # microsoft/vscode clone (gitignored)
│   └── product.json             # patched → OpenCodeIDE branding
├── extensions/opencodeide-ai/   # AI sidebar + VS Code bridge
├── src/ai/                      # Embedded AI Platform (shared logic)
└── scripts/
    ├── setup-vscode.mjs         # clone + brand + patches + npm install
    ├── apply-branding.mjs       # product.json branding
    ├── apply-vscode-patches.mjs # VS 2026 toolchain recognition, etc.
    └── dev-vscode.mjs           # launch Code-OSS + extension
```

## Prerequisites (Windows)

| Requirement | Details |
|-------------|---------|
| **Node.js** | Exact major from `vscode/.nvmrc` (currently **24.x ≥ 24.18.0**). Use [Node.js LTS](https://nodejs.org/) / `winget install OpenJS.NodeJS.LTS` |
| **npm** | &lt; 13 (comes with Node 24 LTS) |
| **Python 3** | For node-gyp |
| **Visual Studio** | C++ desktop workload + **MSVC Spectre-mitigated libs** (x64/x86) |

### Install Spectre libs (required)

Visual Studio Installer → Modify → Individual components → search **Spectre**:

- MSVC v14x - VS 202x C++ x64/x86 Spectre-mitigated libs
- C++ ATL / MFC Spectre-mitigated libs (if prompted)

Or via elevated installer:

```powershell
$setup = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe"
$vs = "C:\Program Files\Microsoft Visual Studio\18\Community"  # adjust path
Start-Process $setup -Verb RunAs -Wait -ArgumentList @(
  "modify","--installPath",$vs,
  "--add","Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre",
  "--add","Microsoft.VisualStudio.Component.VC.ATL.Spectre",
  "--add","Microsoft.VisualStudio.Component.VC.ATLMFC.Spectre",
  "--passive","--norestart"
)
```

> OpenCodeIDE patches Code-OSS `preinstall.ts` to accept **Visual Studio 2026** (`18`), which upstream does not list yet.

## One-time setup

```bash
npm run vscode:setup
```

This will:

1. Clone `microsoft/vscode` into `vscode/` (shallow)
2. Apply OpenCodeIDE branding
3. Apply toolchain patches (VS 2026)
4. Run full `npm install` (native modules included)

If Code-OSS is already cloned:

```bash
npm run vscode:brand
node scripts/apply-vscode-patches.mjs
npm run vscode:install
```

## Develop / launch

```bash
npm run build:extensions   # compile AI extension
npm run vscode:compile     # compile editor (first time is slow)
npm run vscode:dev         # launch OpenCodeIDE with AI sidebar
```

What you should see:

- Product name: **OpenCodeIDE**
- Activity bar: **AI Agent**
- Chat: `list files` · `read README.md` · `search TODO`
- Command Palette → **OpenCodeIDE AI: Configure AI Provider**

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run vscode:setup` | Clone + brand + patch + install |
| `npm run vscode:brand` | Re-apply product.json branding |
| `npm run vscode:install` | `npm install` inside `vscode/` |
| `npm run vscode:compile` | `compile-client` |
| `npm run vscode:dev` | Launch with `--extensionDevelopmentPath` |

## Next hardening steps

1. Register `opencodeide-ai` in `gulpfile.extensions.ts` as built-in
2. Package via Code-OSS gulp (replace Electron placeholder)
3. Wire full `src/ai` Agent Runtime into the extension host
4. Continuous rebase against upstream `microsoft/vscode`

## Notes

- `vscode/` is **not committed** (too large). Use `npm run vscode:setup` on each machine.
- Do **not** use `--ignore-scripts` for vscode install — native modules must build.
