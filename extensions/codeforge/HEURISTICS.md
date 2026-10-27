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
| Spec self-check "confirm each rule" — model confirms boundaries by reading and is wrong | replace | done — `specSelfCheckNote` requires executing the code at each boundary value (inclusive bounds, date-only = midnight, caps, rounding); one-off commands; no files created/edited under test directories (scratch goes to the OS temp dir); no scaffolded project when the code is compiled — the existing suite is the executable check |
| Done on build/test green without launching the app (opens but feature/runtime still broken) | replace | done — one-shot `shouldRequestRuntimeVerify` / `runtimeVerifyNote`: after source writes + green (or no oracle), require browser observe or non-oracle shell/dotnet launch before prose finish; `npm test` / `dotnet test` do not count |
| Qwen XML parameter closed with `</old_string>` instead of `</parameter>`, next parameter leaks into the value | replace | done — `toolCallNormalizer` splits known-parameter markers (missing, echo and self-leak cases), refuses real conflicts with a fix hint; counted as `badArgs` with a raw sample |
| `presence_penalty: 1.0` on tool rounds | remove | done — A/B 10/14 vs 13/14 with 0; tool calls must repeat tokens |
| Unix/PowerShell habits on `cmd.exe` (`rm`, `/tmp`, heredoc, `Set-Content`) | replace | done — `shell` description maps them to `del`, `type`, `findstr`, `%TEMP%`, `write` |
| Spec-check scratch files inside the workspace, and edits that change an existing test assertion | replace | done — `mutationGuard`: during the spec check, no test-dir changes, no new workspace files, no deletes; a pre-existing test file keeps every assertion line |
| A background `dotnet test` kept the headless process alive after the agent had already stopped | replace | done — `bgShell` calls `child.unref()`, so the bench records the result instead of waiting out the timeout |
| Same weak-model compensations for every model | replace | done — `ModelProfile` per server/model (`~/.CodeForge/ai/model-profiles/…`); protocol telemetry rollup; `bench calibrate` (weak keeps defaults; strong drops write-cap / mass-rewrite / forced-weak-skill when `badArgs/native < 0.05`); online hysteresis at run start (write cap on at trunc≥5%, off only after 50-run clean window; tool temp −0.1 if leak≥8%, floor 0.3). Suite packaged at `resources/calibrate-bench/` (`sync:calibrate-bench`); Settings → **Benchmark** |
| Rename finished on green tests with the old name still exported (`oldName: x.newName`) | replace | done — system contract: a rename/removal is done only when a search for the old name returns no hits, export keys included; `rename` tool is file-only |
| Reply that only echoes the `/no_think` soft switch accepted as the final answer | replace | done — `splitThinkContent` drops lines that are only `/think` or `/no_think`, so the empty-turn retry applies |
| Windows shell mangles inner `"` (`node -e "…"` exits 0 without running) | replace | done — `cmdExeSpawn`: outer quotes + `windowsVerbatimArguments` in bridge, sandbox runtime and `bgShell` |
| Multi-card single-loop hits length before later cards | replace | done — isolated sub-runs + `selectCards` range for `` docs/C01.md to docs/C05.md ``; prose length retries (3) under short `max_tokens` (1024) |
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
| Full tool surface thrash in Agent code turns | remove | done — stage machine and plan path gate removed; Agent defaults to CORE tools (groups via `toolGroups`); `delegate_task` explore uses `exploreOnly` profile |
| Periodic context-packet rewrite of `messages[0]` | remove | done — system string frozen for the run; packet only in hard-compact user summary; plan advances as user message |
| Floor-model tool protocol (aliases, bad JSON, XML) | replace | done — `toolCallNormalizer` + stronger content parsers; `AiServer.sampling` overrides; diagnostics appended after edit/write/apply_patch |
| Brittle exact `edit` / truncated tool JSON | replace | done — tolerant `edit` (Unicode + LF view + indent-tolerant single match + `closestWindow` on miss); `apply_patch` only for gpt-* non-OSS |
| Soft edit-miss nudges | remove | done — hard `readThisTurn` gate before edit/overwrite; refuse delivers numbered excerpt and marks path as read |
| Identical failed `edit`/`write`/`apply_patch` retries burn step budget then prose wrap-up | replace | done — block same fingerprint after first fail (incl. duplicates in one step); keep `readThisTurn`; include closest window in refusal |
| Model retries `edit` whose `new_string` is already on disk (fake "missing brace") | replace | done — `applyEdit` returns `alreadyApplied` success so the 35B moves on |
| Intent/continue enrich, thin-final/stuck soft nudges, write-count continue | remove | done — model works from system+tool contract; harness keeps protocol (length/JSON/budget) + tool gates only |
| Stuck wrap used MAX_STEPS_PROMPT (wrong situation) / PT status labels | replace | done — `stuckWrapPrompt(cause)` vs `MAX_STEPS_PROMPT` vs `LENGTH_EXHAUSTED_PROMPT`; `loopExit` is `budget`/`stuck`/`length`; status/activity strings English |
| Soft cache / noop-step stuck heuristics | replace | done — `loopDetector.ts` (identical call+result for 3 steps, UI unchanged ≥3); no explore-step soft/hard caps (Cursor/Claude Code style: unlimited reads within turn step budget) |
| Soft explore-cap refused new reads and stalled T2 | remove | done — removed `EXPLORE_SOFT_CAP` / `EXPLORE_HARD_CAP`; budget exhaustion shows Continue button (`continueTurn`) instead of refusing reads |
| Concrete tip after stuck still only re-reads | replace | done — stuck wrap says next turn must use edit/write/shell/browser; identical-repeat detector still stops loops |
| Stale internal plan injection | replace | done — `internalPlans.ts` scoped to session/taskHash; archive on done/unrelated task |
| Mechanical mid-compact digest | replace | done — structured LLM checkpoint (Objective / Work State / Next Move) with mechanical fallback |
| Final round sends `tools: []` (breaks prefix cache) | replace | done — budget/stuck/length wraps use `postAgentRound` with tools + `tool_choice: none` |
| Clipped tool output with no path to full body | replace | done — spill to `.CodeForge/tool-output/` with marker |
| Diagnose-only finish (bug list, no mutate) burns trust on weak models | replace | done — `TOOL_SYSTEM_CONTRACT` finish rule + `shouldRefuseDiagFinish` / `DIAG_ONLY_FINISH_NOTE` (tool counts only) |
| Checkpoint extends budget on reads alone | replace | done — `progressMarker` uses writes + `uiChangeCount` + build, not `readPathsSeen` |
| Browser click success with UI UNCHANGED loops to hard cap | replace | done — After-state in tool result + `unchangedStreak >= 3` → stuck wrap |
| Thinking hard-off on every Agent tool round (`enable_thinking: false` + `/no_think`); model takes the first plausible action instead of the most relevant one | replace | done — hybrid escalate: default tool rounds stay `/no_think`; after a structural stumble (`guardrail_refusal`, `edit_miss`, `oracle_red`, `loop_note`, `finish_refused`) the next round enables thinking (cap `maxEscalationsPerTurn`); optional `think` tool (no side effects). Calibrate compares **off** vs **hybrid** with `decideCandidate`; hybrid arm counts only when `escalatedRounds` or `thinkToolCalls` > 0. Always-on `toolRounds` remains available but is not the calibrate default |
| Calibrate switched `toolTransport` from one leaky cell at reps=1 | replace | done — transport candidate needs reps ≥ 3 and the same `decideCandidate` gate (stratified unpaired bootstrap + no-task regression + run ledger); `candidateArmWins` kept only as deprecated alias |
| Learned harness text naming bench fixtures / grader verdicts ("cola") | remove | done — quarantine contaminated `harness.json`; `fixtureIdentifiers` screen on load; proposer blind to scores/hidden names with tripwire + evidence citations; one retry |
| Online hysteresis lowered temperature using bench runs and repaired leaks | replace | done — chat-only window per `configHash`; unrepaired `leaked_param_conflict` only; active slice (`toolReasoning` when `toolRounds`, else `toolThinking`); revert + freeze when the new config does not improve |
| Calibration/harness without a contract stamp reused after prompt/knob changes | replace | done — `contractFingerprint` + `profileConfigHash` stamped on runs; divergent harness contract yields no prompt; stale calibration marked in reports |
| Lessons never expired; success did not clear; one-word matches; new lesson evicted at cap | replace | done — decay score `hits * 0.5^(ageDays/14)`, inject ≥ 0.5; `learnFromShellSuccess` removes by command signature; match needs ≥ 2 distinctive words; eviction by decay with the just-written lesson protected; match cue against the command about to run |
| Experiment coach freely rewrote SKILL.md with no measurement | replace | done — coach returns JSON habit or `NO_ENTRY`; `habits.json` probation (3 features); forbidden snippets; SKILL.md rendered from at most 5 active habits; once per feature key |
| Revise proposed one edit without probing dimensions | replace | done — Propose–Probe–Compose: INV (workflow/toolContract) + DOM (writePolicy), one probe each, compose or `KEEP_BASE`, then F4 gate + holdout |
| `bench run/calibrate/revise` could request a `numCtx` above the live llama.cpp slot and 503 the server | replace | done — `verifyServerConfig` reads `/health`, `/props`, `/slots` before the first rep, dies on an unhealthy server or missing `n_ctx`, and clamps to `min(profile numCtx, slot n_ctx)` via `CODEFORGE_BENCH_NUM_CTX`; headless `resolveNumCtx` applies the same clamp |
| Headless compaction crashed on `vscode.window.tabGroups` (bench mock has no tab API) → `loopExit: error`, the run's score silently dropped from the revise/calibrate ledger | replace | done — `gatherIdeState` guards `tabGroups?.all` and `workspace.textDocuments` with safe defaults; `vscodeFsMock.js` now also stubs both |
| Revise wrote candidate and probe harnesses without a `screen` stamp; `loadHarnessArtifact` quarantines unscreened content, so every candidate was scored as the empty harness (the first F8 PPC revert compared the parent with itself) | replace | done — `screenForScoring` stamps a candidate after a fixture-token check (or refuses it) before any scored run; a selftest reloads the written file and requires the section text in the prompt |
| One PPC step might be too small a budget; a harness learned on one task set might still help the other | replace | measured, not kept — sequential k=3 on qwen3.6-35b (T2+T4 and CS2+CS3, 3 reps, empty parent) kept no step. Candidates were worse or tied. The only higher candidate mean (CS suite step 3, 100 vs 95) was one empty-harness CS3 score of 70 against 100s; stratified bootstrap 90% lower bound was 0. Both transfers are NotRun: the artifact stayed empty |

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
| `modelProfile.ts` | per-model knobs (sampling, write cap, prompt extras, finish/orchestrator); disk under `~/.CodeForge/ai/model-profiles/` |
| `protocolTelemetry.ts` | protocol aggregator + `runs.jsonl` / `rollup.json` per model |
| `profileHysteresis.ts` | online flips at run start from rollup (write cap, tool temperature); quality knobs stay calibrate-only |

## Pending

No pending "replace" items. Model validation (bench CS1–CS6, T1–T4) runs in the IDE.

## Baseline (traces, `--since 2026-09-20`)

Captured by `scripts/traceStats.mjs` before this work:

- tools/step ≈ 1.29; explore share ≈ 0.66; read+list/run ≈ 17.1; retrieve/run ≈ 0.39
- median steps before first write ≈ 9

Success target after shipping: read+list/run −30%, median steps-to-write ≤ 4, retrieve share up.
