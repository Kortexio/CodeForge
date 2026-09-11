# CodeForge AI — Architecture Decision

## Decision: Option A — Consolidate in the extension

**Date:** 2026-09-06  
**Completed:** 2026-09-10

The runtime AI surface lives entirely in `extensions/codeforge/`.

- Sessions, memory/wiki, MCP (in+out), tab, git, LSP, sandbox, browser, subagents, artifacts, traces, and context budget all ship inside this extension.
- Legacy `src/ai/` reference spike has been **removed**.
- Code-OSS packaging only syncs `extensions/codeforge`.

### Rationale
1. Extension already powers the shipped Windows product.
2. No wiring gap between library and UI.
3. Single built-in extension keeps packaging simple.
