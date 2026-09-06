# Native Dependencies Bundle

OpenCodeIDE bundles platform-specific native binaries under `resources/binaries/{platform}/`.

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
    win/
    mac/
    linux/
```

## Build notes

- Prefer prebuilt binaries per platform in CI
- ONNX Runtime (~100MB) should be optional / lazy-downloaded
- `electron-builder` maps `resources/binaries/${os}` → `binaries` in the app package

## Script (future)

```bash
# Placeholder for downloading native deps in CI
npm run download:native-deps
```
