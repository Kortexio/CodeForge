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
| **Inference** | [SuperLLaMA](https://github.com/vitorcastro78/superllama) — usable local llama.cpp on modest GPUs (OpenAI-compatible `/v1`, TurboQuant KV, Windows installer) |
| **Suite** | Headless T1–T4 × 3 reps each (`benchmarks/`) |

**Harness off** (empty learned harness — contract + finish gates only):

| Task | Mean (3 reps) | Stuck | badArgs |
|------|---------------:|------:|--------:|
| T1 — bug fix | **100** | 0 | 0 |
| T2 — feature (coupon) | **97** | 0 | 0 |
| T3 — multi-file | **100** | 0 | 0 |
| T4 — rename refactor | **100** | 0 | 0 |

**Harness on** (learned revision 1 for the same model):

| Task | Mean (3 reps) | Stuck | badArgs |
|------|---------------:|------:|--------:|
| T1 — bug fix | **100** | 0 | 0 |
| T2 — feature (coupon) | **94** | 0 | 0 |
| T3 — multi-file | **100** | 0 | 0 |
| T4 — rename refactor | **100** | 0 | 0 |

**Zero stuck runs. Zero bad tool-args.** A ~Q2 35B completing real agentic coding tasks end-to-end on a gaming GPU — served by SuperLLaMA, driven by CodeForge's tool contract.

That is the product bet: **the model is not the product — the contract around the model is.**

Frontier APIs still work. Local weak models stop being a demo and start being a workflow. Pair CodeForge with [SuperLLaMA](https://github.com/vitorcastro78/superllama) (or any OpenAI-compatible endpoint) and point Settings → AI at your local `/v1`.

---

## What we actually built

Not another chat sidebar. A **tool + system contract** that refuses to paper over failures with intent matchers.

| Capability | Why it matters |
|---|---|
| **Agentic loop that finishes** | Unlimited exploration within the turn budget (Cursor/Claude Code style). Continue button when the step budget ends. No soft “explore cap” that refuses new reads. |
| **Adaptive harness** | Per-model profiles (`~/.codeforge/ai/model-profiles/`) — sampling, write gates, finish limits, optional `toolTransport` for XML-leaky locals. Calibrate once; hysteresis adjusts online. |
| **Honest outcomes** | Stuck / truncated / oracle-red are **failed**, not “done”. Spec self-check and oracle before finish with writes. |
| **You own the freedoms** | Sandbox level, Allow all, outside-workspace writes, MCP, Full agent freedom — all user settings, revocable. The model cannot grant itself permissions. |
| **Measurable learning** | Harness revise proposes changes; keep only when paired bootstrap shows a real gain. No quiet contamination of `harness.json`. |
| **Same IDE for weak and strong** | Compensations are per model. A clean 32B does not pay the IQ2_S tax. |

---

## Where we’re going

**Near term**
- Ship releases that treat the adaptive harness + agent loop as the core product story
- Keep the calibrate suite (T2/T4/CS2/CS3) as the release gate for local models
- Harden permissions, sandbox, and secrets for daily use without babysitting

**Next**
- Broader task suites (navigation, long multi-card, review) with the same failure taxonomy: harness / protocol / semantic
- Profile knobs proven by A/B (thinking off on tool turns, one mutating call per step) — only when the bench says so
- Packaging and onboarding so “install → pick local model → agent works” is a five-minute path

**Not the roadmap**
- Hardcoded intent crutches (“the user said fix, so nudge edit”)
- One global “weak mode” that punishes strong models
- Claiming 100% on every task — residual failures stay visible as model limits, not hidden by prose

---

## Why CodeForge?

| | CodeForge |
|---|---|
| Models | OpenAI, Anthropic, Gemini, xAI, OpenRouter, Ollama, vLLM, LM Studio, [SuperLLaMA](https://github.com/vitorcastro78/superllama) / llama.cpp / any OpenAI-compatible API |
| Adaptive harness | Per-model profiles + calibrate + hysteresis |
| Agent | Multi-file loop with approvals; Ask / Plan / Agent + permission chip |
| Chat | Cursor-like sidebar: composer, context ring, tool rows, Undo/Review, Restore, Continue |
| Sandbox | User-configured shell sandbox + optional Full agent freedom |
| Memory | Session wiki, project wiki, stable facts |
| Governance | Skills, rules, policies, hard guardrails |
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
| **Server** | llama.cpp OpenAI-compatible API |
| **Primary local model** | `qwen3.6-35b` (Qwen3.6-35B-A3B **IQ2_S**) |
| **Stronger local** | `Qwen3-32B-exl3-4.0bpw` (calibrate A/B) |
| **Runner** | `benchmarks/bench.mjs` headless / packaged `resources/calibrate-bench/` |

### Agent suite — post harness fix (2026-10-22)

T1–T4 × 3 reps, learned harness off for isolation. Score 0–100.

| Model | T1 | T2 | T3 | T4 | Stuck |
|---|---:|---:|---:|---:|---:|
| `qwen3.6-35b` (IQ2_S) | **100** | **97** | **100** | **100** | **0** |

### Calibration suite — 2026-10-20

T2 · T4 · CS2 · CS3 × 3 reps × 2 models. Protocol quality decides weak vs strong profile knobs — not the model name. Details: [`benchmarks/results/CALIBRATE-2026-10-20.md`](benchmarks/results/CALIBRATE-2026-10-20.md).

Harness design notes: [`extensions/codeforge/HEURISTICS.md`](extensions/codeforge/HEURISTICS.md).

---

## Architecture

```
CodeForge/
├── extensions/codeforge/          # Shipped AI platform (source of truth)
│   ├── src/agent/                 # Loop, profiles, telemetry, revise, tools
│   ├── resources/calibrate-bench/ # Packaged calibrate suite
│   ├── src/views/                 # Chat host + Cursor-like UI
│   ├── src/memory/                # Session + project wiki
│   ├── src/sandbox/               # Shell isolation
│   ├── src/intelligence/          # Index, LSP, git, embeddings
│   ├── src/mcp/                   # Inbound + outbound MCP
│   └── src/governance/            # Skills, rules, guardrails
├── benchmarks/                    # Full harness suite + CLI
├── docs/
└── scripts/                       # Code-OSS setup / package / sync
```

## Configuration

Prefer **CodeForge Settings** in the app (Models / Permissions / MCP / Guardrails / Agent).

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
