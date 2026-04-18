# Adapt karpathy/autoresearch for Crypto Strategy Backtesting

## Context

`karpathy/autoresearch` (https://github.com/karpathy/autoresearch) is an open-source loop where an AI coding agent autonomously edits a target file, runs an experiment, scores the result against a single metric, and either keeps the change (advances the git branch) or reverts it — repeating until interrupted. Although it ships configured for ML training (optimizing `val_bpb` in `train.py` over a fixed 5-minute time budget), the loop itself is metric-agnostic and the community is now using it to optimize anything that can be scored numerically.

I want to repurpose it to optimize my **crypto algorithmic trading strategies** by backtesting.

## Guiding Principle: Minimal Changes to Autoresearch

The thing that makes autoresearch powerful is its **autonomous improvement loop** — the propose → run → score → keep-or-revert ratchet on a git branch. **Do not touch that core logic.** Only change what is strictly necessary to point the loop at our domain:

- The target file the agent edits (YAML config instead of `train.py`)
- The command it runs (our backtester instead of `uv run train.py`)
- The metric it parses and the direction it optimizes (maximize `total net PnL` instead of minimize `val_bpb`)
- The instructions in `program.md`
- The schema of `results.tsv`
- The stopping condition (iteration cap instead of "loop forever")

Everything else — the branch model, the commit-on-improve / reset-on-regress ratchet, the autonomy of the agent, the "don't ask the human if you should continue" stance during a run — must be preserved as-is.

## Optimization Target

- **Metric to maximize:** `total net PnL` (higher is better — note this is the *inverse* direction of `val_bpb`, so the keep/discard comparison must be flipped)
- **Iteration cap per run:** configurable, default `50` (replacing autoresearch's open-ended loop)
- **What the agent is allowed to modify:** **only** the YAML configuration file(s) that belong to *its own* `(strategy, variation)`. It must not touch configs belonging to any other strategy or variation, and it must not touch any non-config files.

## Existing Infrastructure (Do Not Rebuild, Do Not Modify)

The following already exists, is tested, and must be treated as read-only by the autoresearch agent:

- Strategy config YAMLs at `config/strategies/*` (one or more files per strategy/variation)
- Backtesting runner that: reads a strategy config → queries/pulls market data from a remote ClickHouse DB → runs the backtest → produces a report including `total net PnL`
- All five trading strategies and their variations

## Execution Model: How This Will Actually Be Used

This system is being built so that **coding agents (e.g. Claude Code) can launch and supervise many autoresearch instances in parallel, autonomously, in bulk** — not for a human to babysit one run at a time. Concretely:

- An operator (human or agent) defines a run matrix in a config file.
- A coding agent reads the config and spawns N autoresearch instances concurrently.
- Each instance runs fully unattended until it hits its iteration cap.
- The system must be robust to many parallel instances editing different strategy configs at the same time without interfering with each other.

Design every interface (config schema, CLI, file layout, git model, logs) with that "agents driving in bulk" workflow as the primary consumer.

## Run Matrix

There are 5 strategies, some with variations (e.g. `strategy_3a`, `strategy_3b`), each runnable against multiple exchanges. Each `(strategy, variation, exchange)` triple is an **independent autoresearch run** with its own iteration budget. Example:

| # | Strategy    | Exchange |
|---|-------------|----------|
| 1 | strategy_1  | binance  |
| 2 | strategy_1  | okx      |
| 3 | strategy_1  | bitget   |
| 4 | strategy_2  | bybit    |
| 5 | strategy_2  | gateio   |
| 6 | strategy_2  | kucoin   |
| 7 | strategy_3a | okx      |
| 8 | strategy_3a | binance  |
| 9 | strategy_3b | bybit    |
| ... | ...       | ...      |

Requirements:

- The matrix is **manually specified via a config file** (no CLI flags for the matrix itself, no auto-discovery). Design a clean schema for this file.
- Each row carries its **own iteration limit** (defaults to 50, overridable per row).
- Runs must be **executable in parallel in bulk** — many `(strategy, variation, exchange)` rows running concurrently without trampling each other's configs, git state, or results.

## Resume Behavior (Critical)

When an autoresearch instance hits its iteration cap, it stops and leaves behind a populated `results.tsv` (and the corresponding git branch with all kept commits). If that **same** `(strategy, variation, exchange)` run is launched again later, it must:

1. Detect the existing `results.tsv` for that run.
2. Read the prior experiment history from it (count of iterations already done, last-kept commit, current best `total net PnL`).
3. **Resume from where it left off** — picking up the git branch at the last kept commit, treating the existing best PnL as the bar to beat, and continuing the iteration counter from the prior position rather than restarting at 0.
4. Only start fresh when no prior `results.tsv` exists for that run (or when the operator explicitly requests a reset).

This must work correctly whether the prior run ended cleanly at the iteration cap, was killed mid-experiment, or crashed.

## What I Want You To Build

1. **Analyze `karpathy/autoresearch`** end-to-end. Identify *only* the changes strictly needed to repurpose it. At minimum this covers:
   - The functions / scripts in the repo
   - `program.md` (the agent's instruction file — needs rewriting for our domain, metric direction, allowed-edit scope, iteration cap, and resume behavior)
   - `results.tsv` schema (PnL-relevant columns instead of `val_bpb` / `memory_gb`)
   - Setup steps (branch creation, baseline run, resume detection)
   - Anything else genuinely required

   Explicitly call out what you are **not** changing and why, to confirm the core loop is preserved.
2. **Build the orchestration scaffolding** that:
   - Reads the manually-specified matrix config file
   - Spawns one isolated autoresearch instance per `(strategy, variation, exchange)` row
   - Passes the per-run iteration cap and the per-run scoped config-file path(s)
   - Runs them in parallel, safely
   - Aggregates results across runs into a single dashboard / summary
   - Handles the resume case automatically when re-invoked
3. **Wire the agent loop to our existing backtester** — replace "edit `train.py`, run `uv run train.py`, grep `val_bpb`" with "edit only the YAML config(s) scoped to this run, invoke our backtest CLI for the specified exchange, parse `total net PnL` from the report".
4. **Configure everything for autopilot bulk execution by coding agents** — the end state is that a coding agent can read the matrix file, fan out N parallel autoresearch instances, and the whole fleet runs unattended to completion.

## Constraints (Hard)

- The agent must **never** modify anything outside the YAML config file(s) scoped to its own `(strategy, variation)`. Other strategies' configs are off-limits. Backtester code, data layer, orchestrator, and `program.md` itself are off-limits.
- Metric direction is **maximize** `total net PnL`. Invert the keep/discard logic accordingly.
- The iteration cap is a **hard stop**, not a suggestion. Override autoresearch's "NEVER STOP" instruction with cap-aware termination.
- Parallel runs must not corrupt each other's working tree, configs, branches, or `results.tsv` files.
- Re-invoking a run that already has a `results.tsv` must **resume**, not restart.

## Architectural Decision: Git Commit Isolation Strategy

Autoresearch's design relies on git: each instance commits its progress on a dedicated branch (`autoresearch/<tag>`), advances the branch when the metric improves, and resets when it regresses. With many parallel runs, there are three architectural options for managing those commits. **Your task is to analyze all three against our use case and select the best one.**

**(A)** Each autoresearch instance gets a **fully isolated git workspace** (separate worktree or clone per run) — completely independent commit trees.
**(B)** All runs share **one repo** but live on **separate branches** (`autoresearch/strategy_1-binance-<date>`, etc.) — isolated histories, shared object store, single working tree per branch via git worktrees.
**(C)** All runs commit into the **main repository** on a shared branch.

Evaluate each option against:

- Parallelism safety (concurrent writes to the working tree, the index, and `results.tsv`)
- The per-run scoping rule (an instance must only touch its own strategy's configs)
- How easy it is to inspect a single run's history afterwards
- How (and whether) winning configs get merged back to main
- How it interacts with the resume-from-`results.tsv` requirement and with parallel bulk launches by a coding agent

Pick the best option.