# Licensing Notes — CodeForge

## Decision

**CodeForge uses the MIT License.**

ContextMemory (used only as architectural reference) is licensed under **AGPL-3.0**.

## Approach

| Topic | Decision |
|-------|----------|
| Reuse ContextMemory source? | **No** — reimplement concepts from scratch |
| Language | TypeScript (native IDE integration) |
| CodeForge license | MIT |
| AGPL inheritance risk | Avoided by not porting AGPL code |

## Rationale

Copying or translating ContextMemory code into CodeForge would likely require CodeForge to also be AGPL-3.0. To maximize adoption and keep distribution simple, the team reimplements the same ideas (agent loop, wiki memory, compaction, harness modes, etc.) as original TypeScript.

## Guidance

- Treat ContextMemory as design/reference material only
- Do not paste ContextMemory C# into this repository
- If AGPL code is ever incorporated, stop distribution and seek legal review first

## Files

- Project license: [`LICENSE`](../LICENSE)
- Product metadata: [`product.json`](../product.json) (`licenseName`: MIT)
