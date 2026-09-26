# Harness heuristics

Inventory of the agent loop heuristics and what was done with each one. Principle: the model gets
**whole, coherent instructions**, **data that is clipped always carries a marker**, and behavior is
enforced by **mechanism** (oracle, toolsets, gates) instead of repeated warning text.

Classes:

- **keep** — deterministic mechanism, useful, with no contradictory text.
- **replace** — the intent stays, but it becomes a mechanism (tool, oracle, gate) instead of text.
- **remove** — noise or contradiction.

## Instructions (skills, rules, policies, guardrails)

| Item | Class | Status |
|---|---|---|
| `truncateAtSection` (skills cut mid-section) | remove | done — `buildDiskPromptSection`/`buildGovernancePrompt`: whole block, description + pointer only, or omitted |
| "Hard guardrails" section in the prompt | remove | done — guardrails are mechanism, not text |
| Hardcoded `system-default` rule | remove | done |
| Duplicates on disk (`safety.mdc`, `build-loop.mdc`, `dotnet.md`) | remove | done — builtins are the single source |
| Global `rule.one-stack` | replace | done — `resources/rules/one-stack.mdc` with Razor/MVC globs only |
| "write = stub then patch" | remove | done — `edit` tool |
| Contradictory dotnet cwd | remove | done — "from the root with an explicit path" everywhere |
| Plan-first in the weak skill / `require-plan-before-writes` | remove | done — the card criteria are the plan |
| "Do NOT / REQUIRED / NEVER / STOP" tone | remove | done — a unit test keeps builtins neutral |
| Skill matching on any word of the description | remove | done — `matchSkills`: explicit title/triggers only, whole word/phrase |
| Generic `.NET build-fix` skill (builtin) | replace | done — `resources/skills/dotnet-error-cookbook.md`; the oracle attaches only the line for each error code present |
| Generic .NET skills | replace | done — concrete examples in `resources/skills/` (setup, value object, xUnit/architecture) |
| Weak skill tells the model to use `wiki_fact` (tool outside the toolset) | remove | done |
| System prompt "dotnet via shell with path" vs the `dotnet` tool | replace | done — prompt points to the `dotnet` tool |
| Portuguese text in prompts, markers and fixtures | remove | done — everything the model reads is English; Portuguese only remains in matchers for user input |

## Data

| Item | Class | Status |
|---|---|---|
| Silent `slice()` on tool output / history / digest | replace | done — `clip.ts` (`clipData`, `clipBuildOutput`, `clipToolOutput`) always with a marker |
| Build output clipped from the start | replace | done — error / failed test / summary lines are always kept |
| `readFile` cut mid-line | replace | done — whole lines + `(lines a-b of N; more: startLine=X)` |
| Artifact spill | keep | excerpt via `clipToolOutput` + pointer to the file |
| Stable facts / packet (keyPaths, outline, top-level) | keep | with a `…[+N]` marker |

## Behavior

| Item | Class | Status |
|---|---|---|
| Re-read refusal ("already read") | replace | done — `readMemory.ts`: returns the remembered content with a marker |
| Retrieve-repeat refusal | remove | done |
| `list` quota / anti-explore / exploreBudget | remove | done — full tool surface for all models (`toolsets.ts`); status questions still limited to `update_status` |
| VERIFY / CONTINUE nudges, `evaluateProgress`, replan | replace | done — the oracle decides when it is done (`oracle.ts`), `blocked:` is a legitimate exit |
| "N writes without build" (text) | replace | done — the oracle runs automatically after the batch |
| "mass rewrite" (text) | replace | done — gate: partial write on a file > 60 lines → `edit` (when small-model harness is **on**) |
| BUILD-FIX MODE (text) | replace | done — gate on reads outside the files with errors (when harness is **on**) |
| Command circuit breaker | replace | done — only refuses the same failed command when no files changed |
| EXTENDED MEMORY in every packet | replace | done — a lesson is recorded from the failure text (no fixed tag list) and attached to that command; later turns include it only when the task matches |
| Shell `### ADVICE` | remove | done — neutral line with cwd/command |
| "Green" claim without verification | keep | `nudges.ts` + oracle; the bench measures `falseDone` |
| Stable facts cleared by any `exit 0` | remove | done — only build/test clear `openErrors` |
| TDD tips / @page stack warning | keep | off by default; can be enabled by guardrail |
| Step budget | keep | silent extension when progress changes |
| Checkpoints every N steps / `progressReview.ts` / REPLAN | replace | done — orchestrator (`orchestrator.ts`): one item per card, ~25 steps, 2 attempts, then `blocked` |
| Plan requested from the model (task-plan in the wiki) | replace | done — `plan.json` is harness state; planning with a JSON schema only when there are no cards |
| Tool history across cards | remove | done — `isolated` sub-runs (no history, no prior transcript) |
| Previous-session read memory after writes | remove | done — preload invalidates paths written later; the hot set skips stale reads |
| Phase inferred from text in sub-runs | replace | done — `basePhase` set by the orchestrator/review |
| Tools outside Plan mode sent to the model | remove | done — in Plan mode only the allowed tools are sent |
| One-shot review in a single loop | replace | done — `reviewPipeline.ts`: signals → sub-run per file → evidence check → `BUGS.md` |
| Extended memory lessons in every packet | remove | done (see above) |
| Index embeddings as fixed 800-char prefixes (manual command only) | replace | done — symbol/blank-line chunker, incremental hash, vectors.f32, auto watcher (`semanticIndex`) |
| Retrieve without rerank / mid-text context truncation | replace | done — LLM rerank + `ContextSource.items` (drop whole hits/lessons); status `noTruncate` |
| Compact erases what was already read | replace | done — `FILES ALREADY READ` ledger in mid/hard compact |
| Explore via many serial list/read steps | replace | done — packet retrieve + optional explore subagent (`exploreSubagent`) |

## Modules

| Module | Contents |
|---|---|
| `clip.ts` | data clipping with markers |
| `readMemory.ts` | read cache, canonicalization, soft reads |
| `nudges.ts` | claims (green / blocked) and every text the loop injects |
| `editTool.ts` | `edit` with useful errors |
| `oracle.ts` | build/test detection and parsing |
| `toolsets.ts` | phase labels (telemetry), `dotnet` tool, status-question tool filter |
| `orchestrator.ts` / `orchestratorRun.ts` | card plan and per-item execution |
| `reviewCore.ts` / `reviewPipeline.ts` | bug-hunting pipeline |
| `chunker.ts` / `workspaceIndex.ts` / `rerank.ts` / `indexWatcher.ts` | hybrid retrieve index |
| `toolHistory.ts` | soft/mid compact + read ledger |
| `exploreMode.ts` | optional read-only explore subagent |

## Pending

No pending "replace" items. Model validation (bench CS1–CS6, T1–T4) runs in the IDE.

## Baseline (traces, `--since 2026-09-20`)

Captured by `scripts/traceStats.mjs` before this work:

- tools/step ≈ 1.29; explore share ≈ 0.66; read+list/run ≈ 17.1; retrieve/run ≈ 0.39
- median steps before first write ≈ 9

Success target after shipping: read+list/run −30%, median steps-to-write ≤ 4, retrieve share up.
