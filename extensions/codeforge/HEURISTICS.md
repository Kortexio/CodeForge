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
| Re-read refusal ("already read") | replace | done — `read`/`list` always hit disk; identical window prefixed `(unchanged since earlier read)`; `readThisTurn` set on every successful read |
| Retrieve-repeat refusal | remove | done |
| `list` quota / anti-explore / exploreBudget | remove | done — Agent build profile is CORE (+ optional `codeforge.ai.toolGroups`); status questions still limited to `update_status` |
| VERIFY / CONTINUE nudges, `evaluateProgress`, replan | replace | done — the oracle decides when it is done (`oracle.ts`), `blocked:` is a legitimate exit |
| "N writes without build" (text) | replace | done — the oracle runs automatically after the batch |
| "mass rewrite" (text) | replace | done — gate: partial write on a file > 60 lines → `edit` (when small-model harness is **on**) |
| BUILD-FIX MODE / red-build read cap | remove | done — no read cap while build is red; oracle still runs after write batches |
| Command circuit breaker | replace | done — only refuses the same failed command when no files changed |
| EXTENDED MEMORY in every packet | replace | done — a lesson is recorded from the failure text (no fixed tag list) and attached to that command; later turns include it only when the task matches |
| Shell `### ADVICE` | remove | done — neutral line with cwd/command |
| "Green" claim without verification | keep | `nudges.ts` + oracle; the bench measures `falseDone` |
| Stable facts cleared by any `exit 0` | remove | done — only build/test clear `openErrors` |
| TDD tips / @page stack warning | keep | off by default; can be enabled by guardrail |
| Step budget | keep | silent extension when progress changes |
| Checkpoints every N steps / `progressReview.ts` / REPLAN | replace | done — orchestrator (`orchestrator.ts`): one item per card, ~25 steps, 2 attempts, then `blocked`; auto when task mentions cards and ≥2 exist (slash `/cards` forces); headless uses `runOrchestrated` |
| Spec self-check "confirm each rule" — model confirms boundaries by reading and is wrong | replace | done — `specSelfCheckNote` requires executing the code at each boundary value (inclusive bounds, date-only = midnight, caps, rounding); one-off commands, temporary files deleted, existing tests untouched |
| Reply that only echoes the `/no_think` soft switch accepted as the final answer | replace | done — `splitThinkContent` drops lines that are only `/think` or `/no_think`, so the empty-turn retry applies |
| Windows shell mangles inner `"` (`node -e "…"` exits 0 without running) | replace | done — `cmdExeSpawn`: outer quotes + `windowsVerbatimArguments` in bridge, sandbox runtime and `bgShell` |
| Multi-card single-loop hits length before later cards | replace | done — isolated sub-runs + `selectCards` range for `` docs/C01.md to docs/C05.md ``; prose length retries (3) under short `max_tokens` (1024) |
| Plan requested from the model (task-plan in the wiki) | replace | done — `plan.json` is harness state; planning with a JSON schema only when there are no cards |
| Tool history across cards | remove | done — `isolated` sub-runs (no history, no prior transcript) |
| Previous-session read memory after writes | remove | done — preload invalidates paths written later; the hot set skips stale reads |
| Phase inferred from text in sub-runs | replace | done — `basePhase` set by the orchestrator/review |
| Tools outside Plan mode sent to the model | remove | done — in Plan mode only the allowed tools are sent |
| One-shot review in a single loop | replace | done — `reviewPipeline.ts`: signals → sub-run per file → evidence check → `BUGS.md` |
| Review pipeline only behind `/review`; a plain "find the bugs" ran one loop | replace | done — `taskRouter.ts` (`runRouted`) used by chat and headless: `asksForBugHunt` on the user request (not with fix/corrige, not in ask/plan mode); scope = existing paths named in the task; per-file progress |
| Review sub-run never opened the data the code binds (`config/coupons.json`) | replace | done — `referencedDataFiles`: data files named by path/file name in the source, or sharing its base name, inlined in the per-file prompt |
| Review findings repeated at call sites / rules not in the spec | replace | done — per-file contract: defects of this file only; each finding names the written rule or a concrete wrong output |
| Review sub-runs had no shell (plan mode), so threshold bugs stayed unread | replace | done — `reviewMode` profile: read/search + shell/dotnet, no write/edit; `boundaryCheckHint` requires `node -e` / `python -c` for JS/TS/Py and forbids inventing a console host for class libraries (C#/Java/…) |
| Extended memory lessons in every packet | remove | done (see above) |
| Index embeddings as fixed 800-char prefixes (manual command only) | replace | done — symbol/blank-line chunker, incremental hash, vectors.f32, auto watcher (`semanticIndex`) |
| Retrieve without rerank / mid-text context truncation | replace | done — LLM rerank + `ContextSource.items` (drop whole hits/lessons); status `noTruncate` |
| Compact erases what was already read | replace | done — `FILES ALREADY READ` ledger in mid/hard compact |
| Explore via many serial list/read steps | replace | done — packet retrieve + optional explore subagent (`exploreSubagent`) |
| Full tool surface thrash in Agent code turns | remove | done — stage machine and plan path gate removed; Agent defaults to CORE tools (groups via `toolGroups`); `delegate_task` explore uses `exploreOnly` profile |
| Periodic context-packet rewrite of `messages[0]` | remove | done — system string frozen for the run; packet only in hard-compact user summary; plan advances as user message |
| Floor-model tool protocol (aliases, bad JSON, XML) | replace | done — `toolCallNormalizer` + stronger content parsers; `AiServer.sampling` overrides; diagnostics appended after edit/write/apply_patch |
| Brittle exact `edit` / truncated tool JSON | replace | done — tolerant `edit` (Unicode + LF view + indent-tolerant single match + `closestWindow` on miss); `apply_patch` only for gpt-* non-OSS |
| Soft edit-miss nudges | remove | done — hard `readThisTurn` gate before edit/overwrite; refuse delivers numbered excerpt and marks path as read |
| Identical failed `edit`/`write`/`apply_patch` retries burn step budget then prose wrap-up | replace | done — block same fingerprint after first fail (incl. duplicates in one step); keep `readThisTurn`; include closest window in refusal |
| Model retries `edit` whose `new_string` is already on disk (fake "missing brace") | replace | done — `applyEdit` returns `alreadyApplied` success so the 35B moves on |
| Intent/continue enrich, thin-final/stuck soft nudges, write-count continue | remove | done — model works from system+tool contract; harness keeps protocol (length/JSON/budget) + tool gates only |
| Stuck wrap used MAX_STEPS_PROMPT (wrong situation) / PT status labels | replace | done — `stuckWrapPrompt(cause)` vs `MAX_STEPS_PROMPT` vs `LENGTH_EXHAUSTED_PROMPT`; `loopExit` is `budget`/`stuck`/`length`; status/activity strings English |
| Soft cache / noop-step stuck heuristics | replace | done — `loopDetector.ts` (identical call+result for 3 steps, explore-only ≥20, UI unchanged ≥3) |
| Stale internal plan injection | replace | done — `internalPlans.ts` scoped to session/taskHash; archive on done/unrelated task |
| Mechanical mid-compact digest | replace | done — structured LLM checkpoint (Objective / Work State / Next Move) with mechanical fallback |
| Final round sends `tools: []` (breaks prefix cache) | replace | done — budget/stuck/length wraps use `postAgentRound` with tools + `tool_choice: none` |
| Clipped tool output with no path to full body | replace | done — spill to `.CodeForge/tool-output/` with marker |
| Diagnose-only finish (bug list, no mutate) burns trust on weak models | replace | done — `TOOL_SYSTEM_CONTRACT` finish rule + `shouldRefuseDiagFinish` / `DIAG_ONLY_FINISH_NOTE` (tool counts only) |
| Checkpoint extends budget on reads alone | replace | done — `progressMarker` uses writes + `uiChangeCount` + build, not `readPathsSeen` |
| Browser click success with UI UNCHANGED loops to hard cap | replace | done — After-state in tool result + `unchangedStreak >= 3` → stuck wrap |

## Modules

| Module | Contents |
|---|---|
| `clip.ts` | data clipping with markers |
| `toolOutputSpill.ts` | full clipped output under `.CodeForge/tool-output/` |
| `readMemory.ts` | path canonicalization, read ledger helpers, invalidate on write |
| `nudges.ts` | claims (green / blocked) and every text the loop injects |
| `loopDetector.ts` | identical call+result streak and related stop causes |
| `editTool.ts` | tolerant `edit` with useful errors |
| `applyPatch.ts` | `apply_patch` parser/applier (gpt-* only) |
| `internalPlans.ts` | model-only scaffold slices under `.CodeForge/plans/` |
| `structuredCompaction.ts` | Objective / Work State / Next Move checkpoint template |
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
