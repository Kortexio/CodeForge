# Native Dependencies Bundle

CodeForge bundles platform-specific native binaries under `resources/binaries/{platform}/`.

## Required binaries

| Dependency | Purpose | Status |
|------------|---------|--------|
| **ripgrep** | Lexical search (already in VS Code/Code-OSS) | Bundled with Code-OSS base |
| **Tree-sitter** | Structural AST parsing | npm `tree-sitter` + grammars |
| **ONNX Runtime** | Local embeddings (optional download) | Download on demand to keep installer small |

## Layout

```
resources/
  binaries/
    win32/
    linux/
    darwin/
  icons/
    src/          # master PNG + SVG
    win/          # code.ico + size PNGs
    mac/
    linux/
    codeforge.png # 256px convenience copy
```

## App icon

Primary mark: teal anvil + code chevrons + amber spark on charcoal tile.

- Source: `resources/icons/src/codeforge-icon-1024.png`
- Windows: `resources/icons/win/code.ico` (also copied to Code-OSS `resources/win32/code.ico` at package time)
- Alt concept kept at `resources/icons/src/codeforge-icon-alt-1024.png`
## Build notes

- Prefer prebuilt binaries per platform in CI
- ONNX Runtime (~100MB) should be optional / lazy-downloaded
- `electron-builder` maps `resources/binaries/${os}` → `binaries` in the app package

## Script (future)

```bash
# Placeholder for downloading native deps in CI
npm run download:native-deps
```
