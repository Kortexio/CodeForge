# Code-OSS Integration — OpenCodeIDE

## Goal

Run OpenCodeIDE as a **branded Code-OSS** with the embedded AI extension loaded.

## Architecture (current)

```
CodeForge/
├── vscode/                      # microsoft/vscode clone (gitignored)
│   └── product.json             # patched → OpenCodeIDE branding
├── extensions/opencodeide-ai/   # AI sidebar + VS Code bridge
├── src/ai/                      # Embedded AI Platform (shared logic)
└── scripts/
    ├── setup-vscode.mjs         # clone + brand + npm install
    ├── apply-branding.mjs       # product.json branding
    └── dev-vscode.mjs           # launch Code-OSS + extension
```

## One-time setup

```bash
npm run vscode:setup
```

This will:
1. Clone `microsoft/vscode` into `vscode/` (shallow)
2. Apply OpenCodeIDE branding to `product.json`
3. Run `npm install` inside `vscode/` (10–20+ minutes)

If Code-OSS is already cloned:

```bash
npm run vscode:brand
npm run vscode:install
```

## Develop / launch

```bash
# Compile AI extension
npm run build:extensions

# Compile Code-OSS (first time is slow)
npm run vscode:compile

# Launch branded IDE with AI extension in development mode
npm run vscode:dev
```

What you should see:
- Window title / product name: **OpenCodeIDE**
- Activity bar: **AI Agent** icon
- Chat sidebar can run:
  - `list files`
  - `read README.md`
  - `search TODO`
- Configure LLM: Command Palette → **OpenCodeIDE AI: Configure AI Provider**

## Branding fields applied

| Field | Value |
|-------|--------|
| nameShort | OpenCodeIDE |
| applicationName | opencodeide |
| dataFolderName | .opencodeide |
| urlProtocol | opencodeide |
| darwinBundleIdentifier | com.kortexio.opencodeide |

## Next hardening steps

1. Register `opencodeide-ai` as a **built-in** extension (add to `gulpfile.extensions.ts` compilations)
2. Replace Electron placeholder packaging with Code-OSS gulp packaging
3. Wire full Agent Runtime (`src/ai`) into the extension host (not only chat/LLM shortcuts)
4. Continuous rebase workflow against upstream `microsoft/vscode`

## Notes

- `vscode/` is **not committed** (too large). Use `npm run vscode:setup` on each machine.
- Upstream Code-OSS uses its own Node/npm toolchain; prefer Node 20 LTS if install fails on newer Node.
