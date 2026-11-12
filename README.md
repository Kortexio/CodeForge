# CodeForge

[![GitHub release](https://img.shields.io/github/v/release/Kortexio/CodeForge?include_prereleases&sort=semver)](https://github.com/Kortexio/CodeForge/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Kortexio/CodeForge/ci.yml?branch=master&label=CI)](https://github.com/Kortexio/CodeForge/actions)

**The open-source AI coding IDE that makes a consumer GPU feel like a coding agent — not a chatbot with tools bolted on.**

Built on [Code-OSS](https://github.com/microsoft/vscode). Your models. Your machine. No Docker. No vendor lock-in.

> **Download:** [Latest Windows installer](https://github.com/Kortexio/CodeForge/releases/latest) · **Source:** [`extensions/codeforge/`](extensions/codeforge/)

---

## The AHA moment

Most “local AI IDEs” stall when the model is small: they over-read, under-edit, or declare victory without verifying. **CodeForge fixes the agent loop itself** — read → edit → test → finish — and then adapts the harness to each model.

### Measured on our local stack

| | |
|---|---|
| **GPU** | NVIDIA RTX 3060 12GB |
| **Model** | Qwen3.6-35B (IQ2_S / ~Q2 GGUF) |
| **Inference** | llama.cpp OpenAI-compatible `/v1` (1 slot, `n_ctx` 65536) |
| **Suite** | Headless T1–T4 + CS1–CS6, empty learned harness (`benchmarks/`) |

**Full suite** (2026-11-12, 1 rep, `master` — mean **99.3**):

| Task | Score | Notes |
|------|------:|-------|
| T1 — bug fix | **100** | |
| T2 — feature (coupon) | **100** | |
| T3 — navigation | **100** | |
| T4 — rename refactor | **100** | |
| CS1 — C# bug fix | **100** | |
| CS2 — C# coupon | **100** | |
| CS3 — C# VIP rate | **100** | |
| CS4 — scaffold | **100** | |
| CS5 — review | **93** | F1 0.91; still a pass |
| CS6 — five cards | **100** | all five cards green |

**v0.2.0 calibrate** (2026-10-22, T1–T4 × 3 reps, harness off): T1 **100** · T2 **97** · T3 **100** · T4 **100**. Stuck **0**. badArgs **0**.

A ~Q2 35B completing real agentic coding tasks — including a C# five-card run — on a gaming GPU, served by llama.cpp, driven by CodeForge's tool contract.

That is the product bet: **the model is not the product — the contract around the model is.**

Frontier APIs still work. Local weak models stop being a demo and start being a workflow. Pair CodeForge with llama.cpp (or any OpenAI-compatible endpoint) and point Settings → AI at your local `/v1`.

---

## What we actually built

Not another chat sidebar. A **tool + system contract** that refuses to paper over failures with intent matchers.

| Capability | Why it matters |
|---|---|
| **Agentic loop that finishes** | Unlimited exploration within the turn budget (Cursor/Claude Code style). Parallel reads, mid-turn steering, Continue when the step budget ends. No soft “explore cap” that refuses new reads. |
| **Adaptive harness** | Per-model profiles (`~/.CodeForge/ai/model-profiles/`) — sampling, write gates, finish limits, optional `toolTransport` for XML-leaky locals. Calibrate once; hysteresis adjusts online. Keep a learned revision only when paired scores improve. |
| **Universal tool recovery** | Family-aware repair for Qwen, DeepSeek, Llama, Gemma, Mistral, Harmony, and friends — schema repair, phantom tool-use retry, thinking-field handling — so weak locals stay in the loop instead of dying on bad JSON/XML. |
| **Language-agnostic oracle** | The agent records build/test via `set_verify_command` (or `none` + reason). The IDE re-runs those commands after writes; green is exit 0, not a guessed `dotnet`/`npm` recipe. |
| **Honest outcomes** | Stuck / truncated / oracle-red are **failed**, not “done”. Spec self-check, effect gates, and finish gates refuse prose victory without verification. |
| **Vision in chat** | Paste or drag images into the panel; CodeForge auto-routes the turn to a reachable vision-capable model (or drops the image, not the turn, when none is up). |
| **Agents window** | The Code-OSS Agents / sessions UI runs the same harness: models, Ask/Plan/Agent, permissions, slash commands, and discovery — not a second, thinner agent. |
| **You own the freedoms** | Sandbox level, Allow all, outside-workspace writes, MCP, Full agent freedom — all user settings, revocable. The model cannot grant itself permissions. |
| **Measurable learning** | Harness revise proposes changes; keep only when stratified bootstrap shows a real gain. No quiet contamination of `harness.json`. |
| **Same IDE for weak and strong** | Compensations are per model. A clean 32B does not pay the IQ2_S tax. |

---

## Since v0.2.0 (on `master`)

Shipped as **0.3.0**. Not 1.0. Notes: [`docs/releases/v0.3.0.md`](docs/releases/v0.3.0.md).

| Shipped | Why it is a minor, not a patch |
|---|---|
| Agents window | Code-OSS sessions UI runs the same harness, settings, slash commands, and discovery |
| Vision in chat | Paste / drag images; auto-route to a vision model; drop the image, not the turn, if none is up |
| Universal tool recovery | Family-aware repair (Qwen, DeepSeek, Llama, Gemma, Mistral, Harmony, …) + schema repair |
| Language-agnostic oracle | `set_verify_command` — green is exit 0, not a guessed `dotnet`/`npm` recipe |
| Loop hardening | Finish gates after `update_status`, structural gates on CS2/CS3/CS4/CS6, parallel reads, steering, hooks |
| Broader bench | Same IQ2_S stack now reports CS1–CS6, plus optional Aider / OpenHands baselines |

**Not in 0.3.0** (still open): Authenticode, macOS/Linux packages, five-minute onboarding, Agent CORE expansion (glob / wiki / media / notebook as defaults — lives on `feat/core-tool-surface`).

## Where we’re going

**Near term**
- Packaging and onboarding so “install → pick local model → agent works” is a five-minute path
- Authenticode for Windows releases when a code-signing certificate is available
- Keep T2/T4/CS2/CS3 as the calibrate gate; CS5/CS6 as honesty checks (not a 100 bar)

**Next**
- Expand Agent CORE (glob + remaining built-in groups) without intent crutches
- Profile knobs proven by A/B — only when the bench says so
- macOS / Linux official packages + notarization

**Not the roadmap**
- Hardcoded intent crutches (“the user said fix, so nudge edit”)
- One global “weak mode” that punishes strong models
- Claiming 100% on every task — residual failures stay visible as model limits, not hidden by prose

---

## Why CodeForge?

| | CodeForge |
|---|---|
| Models | OpenAI, Anthropic, Gemini, xAI, OpenRouter, Ollama, vLLM, LM Studio, llama.cpp / any OpenAI-compatible API |
| Adaptive harness | Per-model profiles + calibrate + hysteresis + scored revise |
| Tool protocol | Universal family recovery + schema repair across local/cloud formats |
| Agent | Multi-file loop with approvals; Ask / Plan / Agent + permission chip; steering mid-turn |
| Surfaces | Side chat **and** Agents window — same harness, settings, slash commands |
| Chat | Cursor-like sidebar: composer, context ring, tool rows, image paste/DnD, Undo/Review, Restore, Continue |
| Vision | Auto-route image turns to a vision-capable model when configured |
| Verify | Project build/test via `set_verify_command` — stack-agnostic oracle |
| Sandbox | User-configured shell sandbox + optional Full agent freedom |
| Memory | Session wiki, project wiki, stable facts |
| Governance | Skills, rules, policies, hard guardrails |
| Bench | Headless suite + optional external baselines (Aider, OpenHands) on the same tasks |
| MCP | Inbound tools + outbound wiki + Plugins catalog |

Also discoverable as: *open source Cursor alternative*, *Ollama coding agent*, *llama.cpp coding IDE*, *local LLM agent IDE*.

---

## Install (Windows)

1. Open **[Releases](https://github.com/Kortexio/CodeForge/releases/latest)**
2. Download `CodeForge-Setup-*-win32-x64.exe`
3. Run the installer (per-user under `%LOCALAPPDATA%\Programs\CodeForge`)

Or build from source (below).

## Quick start (development)

```bash
git clone https://github.com/Kortexio/CodeForge.git
cd CodeForge
npm install
npm run vscode:setup      # clone Code-OSS, brand, install deps
npm run build:extensions # sync calibrate suite + compile AI extension
npm run vscode:compile   # compile editor (first time is slow)
npm run vscode:dev       # launch CodeForge with AI sidebar
```

Calibrate from the app: **CodeForge Settings → Benchmark**, or:

```bash
node benchmarks/bench.mjs calibrate --model qwen3.6-35b --reps 3
node benchmarks/bench.mjs run T2 --label smoke --model qwen3.6-35b
```

See [docs/code-oss-integration.md](docs/code-oss-integration.md) and [benchmarks/README.md](benchmarks/README.md).

---

## Benchmarks (llama.cpp, RTX 3060 12GB)

| | |
|---|---|
| **GPU** | NVIDIA GeForce RTX 3060 **12GB** |
| **Server** | llama.cpp OpenAI-compatible `/v1` |
| **Primary local model** | `qwen3.6-35b` (Qwen3.6-35B-A3B **IQ2_S**) |
| **Slot** | 1 × `n_ctx` 65536 |
| **Stronger local** | `Qwen3-32B-exl3-4.0bpw` (calibrate A/B) |
| **Runner** | `benchmarks/bench.mjs` headless / packaged `resources/calibrate-bench/` |

### Full suite — `master` 2026-11-12 (1 rep, empty learned harness)

Score 0–100. Mean **99.3**. Stuck **0**. notRun **0**.

| Model | T1 | T2 | T3 | T4 | CS1 | CS2 | CS3 | CS4 | CS5 | CS6 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `qwen3.6-35b` (IQ2_S) | **100** | **100** | **100** | **100** | **100** | **100** | **100** | **100** | **93** | **100** |

CS5 is a review task (pass at F1 ≥ 0.8; this run F1 0.91). CS6 is five isolated cards — all green.

### Agent suite — v0.2.0 (2026-10-22)

T1–T4 × 3 reps, learned harness off. Score 0–100.

| Model | T1 | T2 | T3 | T4 | Stuck |
|---|---:|---:|---:|---:|---:|
| `qwen3.6-35b` (IQ2_S) | **100** | **97** | **100** | **100** | **0** |

### Calibration suite — 2026-10-20

T2 · T4 · CS2 · CS3 × 3 reps × 2 models. Protocol quality decides weak vs strong profile knobs — not the model name. Details: [`benchmarks/results/CALIBRATE-2026-10-20.md`](benchmarks/results/CALIBRATE-2026-10-20.md).

### External baselines

Same tasks, model, and server can be driven by Aider or OpenHands instead of CodeForge (`benchmarks/externalAgents.mjs`). Scoring stays in `bench.mjs` so the comparison is the agent loop, not a different grader.

Harness design notes: [`extensions/codeforge/HEURISTICS.md`](extensions/codeforge/HEURISTICS.md).

---

## Architecture

```
CodeForge/
├── extensions/codeforge/          # Shipped AI platform (source of truth)
│   ├── src/agent/                 # Loop, profiles, oracle (`set_verify_command`), revise, tools
│   │   └── universal/             # Multi-family tool recovery + schema repair
│   ├── src/agents/                # Agents-window bridge + LM provider (same harness as side chat)
│   ├── resources/calibrate-bench/ # Packaged calibrate suite
│   ├── src/views/                 # Chat host + Cursor-like UI + attachments
│   ├── src/memory/                # Session + project wiki
│   ├── src/sandbox/               # Shell isolation
│   ├── src/intelligence/          # Index, LSP, git, embeddings
│   ├── src/mcp/                   # Inbound + outbound MCP
│   └── src/governance/            # Skills, rules, guardrails
├── benchmarks/                    # Full harness suite + CLI + external baselines
├── docs/
└── scripts/                       # Code-OSS setup / package / sync
```

## Configuration

Prefer **CodeForge Settings** in the app (Models / Permissions / MCP / Guardrails / Agent / Benchmark). Image turns need at least one vision-capable model in Settings (Refresh from API fills `visionModels` when the server exposes multimodal capabilities).

```json
{
  "codeforge.ai.mode": "agent",
  "codeforge.ai.shellSandbox": "restricted",
  "codeforge.ai.allowAll": false,
  "codeforge.ai.outsideWorkspaceWrites": "ask",
  "codeforge.ai.fullAgentFreedom": false
}
```

Profiles live per machine under `~/.CodeForge/ai/model-profiles/` — calibrate once per model.

## Development

**Prerequisites:** Node matching `vscode/.nvmrc`, npm, Git. On Windows: VS C++ workload + Spectre-mitigated libs.

```bash
npm run build:extensions
npm test
npm run vscode:package:win   # needs Inno Setup
```

## License

MIT — see [LICENSE](LICENSE).

## Contributing

See [Contributing Guide](CONTRIBUTING.md).

## Acknowledgments

- Built on [Code-OSS](https://github.com/microsoft/vscode)
- Validated on consumer GPUs (RTX 3060 12GB + llama.cpp) and cloud APIs
- The agent loop is measured, not marketed — failure classes stay visible
