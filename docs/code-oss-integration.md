# Code-OSS Integration — CodeForge

## Goal

Run CodeForge as a **branded Code-OSS** with the embedded AI extension loaded.

## Architecture

```
CodeForge/
├── vscode/                      # microsoft/vscode clone (gitignored)
│   └── product.json             # patched → CodeForge branding
├── extensions/codeforge/   # AI sidebar + full AI platform (source of truth)
└── scripts/
    ├── setup-vscode.mjs         # clone + brand + patches + npm install
    ├── apply-branding.mjs       # product.json branding
    ├── apply-vscode-patches.mjs # VS 2026 toolchain recognition, etc.
    └── dev-vscode.mjs           # launch Code-OSS + extension
```

> All AI runtime code lives in `extensions/codeforge/`. There is no separate `src/ai` package in the shipped product.
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

> CodeForge patches Code-OSS `preinstall.ts` to accept **Visual Studio 2026** (`18`), which upstream does not list yet.

## One-time setup

```bash
npm run vscode:setup
```

This will:

1. Clone `microsoft/vscode` into `vscode/` (shallow)
2. Apply CodeForge branding
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
npm run vscode:dev         # launch CodeForge with AI sidebar
```

What you should see:

- Product name: **CodeForge**
- Layout: **Explorer left · Editor center · AI Agent right** (Secondary Side Bar)
- Chat modes: **Agent** / **Ask**, model chip, `Ctrl+L` to focus
- Command Palette → **CodeForge AI: Configure AI Provider**

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run vscode:setup` | Clone + brand + patch + install |
| `npm run vscode:brand` | Re-apply product.json branding |
| `npm run vscode:install` | `npm install` inside `vscode/` |
| `npm run vscode:compile` | `compile-client` |
| `npm run vscode:dev` | Launch with `--extensionDevelopmentPath` |
| `npm run vscode:sync-ext` | Copy AI extension into `vscode/extensions/` as built-in |
| `npm run vscode:package:win` | Build portable app + user installer (Windows x64) |
| `npm run vscode:package:win:portable` | Portable folder only (no Inno Setup) |

## Installable product (Windows)

Distribution artifact is an **Inno Setup installer**:

```bash
# Full pipeline (portable + zip + Setup.exe) — 30–90+ min first time
npm run vscode:package:win

# If portable folder already exists:
npm run installer:win
```

Requires [Inno Setup 6+](https://jrsoftware.org/isdl.php) (`winget install JRSoftware.InnoSetup`).

Outputs:

| Artifact | Location |
|----------|----------|
| **Installer (primary)** | `dist/codeforge-win32-x64/CodeForge-Setup-<ver>-win32-x64.exe` |
| Portable app | `VSCode-win32-x64/CodeForge.exe` |
| ZIP | `dist/codeforge-win32-x64/CodeForge-<ver>-win32-x64.zip` |

Installer features: per-user install (no admin by default), Start Menu, optional desktop icon + PATH (`codeforge`), `codeforge://` protocol, uninstaller.

The AI sidebar ships **built-in** (no `--extensionDevelopmentPath`).

Script reference: [`build/windows/codeforge.iss`](../build/windows/codeforge.iss), [`scripts/build-installer-windows.mjs`](../scripts/build-installer-windows.mjs).

## Notes

- `vscode/` is **not committed** (too large). Use `npm run vscode:setup` on each machine.
- Do **not** use `--ignore-scripts` for vscode install — native modules must build.
- First Windows package can take **30–90+ minutes** (Electron download, minify, extensions).
