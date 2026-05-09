# Live Strategy Execution System — Design & Build

## Context

We currently run an automated backtesting pipeline where auto-research experiments iterate (~40 iterations per run) to find the best configuration for each strategy-exchange combination. The winning configs are committed to `autoresearch/best-configs/`.

We have ~40 strategy-exchange combinations in total. One of them — `strategy_3a` — is already running live on a remote server, with observability, logging, strategy lifecycle data capture (intents, orders, fills, etc.), and alerting fully wired up. **This existing setup is the reference implementation and should be reused/extended, not rebuilt.**

**Note on live execution implementations:** Currently, only `strategy_3a` has a working live execution implementation. Live execution implementations for `strategy_1`, `strategy_2`, `strategy_3b`, and `strategy_4a` are **out of scope of this task** and will be delivered in a later task. However, the system designed here must already expect and accommodate these strategies — the platform, config schema, provisioning, deployment, and reconciliation layers must all be ready for them to plug in without redesign.

## Goal

Design, architect, and build the end-to-end system and pipeline that takes a backtested strategy from live config to live execution at scale. The system must be:

- **Easy to use** for operators (GitOps-driven, declarative)
- **Configurable** (which strategies run where, with what capital, on which sub-accounts)
- **Extendable** (adding a new strategy or exchange must be a config-and-plug-in operation, not a platform rewrite — see below)
- **Robust and isolated** (per-strategy-exchange failure must not cascade)
- **Continuous** (supports ongoing redeployment of code/config changes across all live combinations)

### Extensibility as a first-class requirement

The system must be designed so that adding any future strategy — known today or not — is a uniform operation: provide its configuration, assign it a sub-account (with API keys and capital), and deploy it through the same pipeline with the same monitoring, alerting, lifecycle handling, and operator controls as every other strategy. There must be no strategy-specific branching in the platform layer; strategies are pluggable units consumed by a generic runtime.

## Scope

**In scope (live):** All variants of `strategy_1`, `strategy_2`, `strategy_3`, `strategy_4` across their target exchanges.

**Out of scope (live):** `strategy_5`, `strategy_spot_futures` — these remain backtest-only for now, but the system must not preclude adding them later.

**Out of scope of this task (but expected by the system):** Live execution implementations for `strategy_1`, `strategy_2`, `strategy_3b`, `strategy_4a`. Only `strategy_3a` has a working implementation today; the others will be added in follow-up tasks and must drop into this system without changes to the platform.

## Architectural Requirements

### 1. Sub-account provisioning & registry

Every strategy-exchange combination runs on its own dedicated exchange sub-account. No two strategies ever share an account — balances, orders, positions, and API keys are fully isolated per combination.

Build a provisioning subsystem that:

- **Creates sub-accounts programmatically** where the exchange API supports it
- **Falls back to a "manual creation + register existing" path** for exchanges that require UI steps. First action: audit each target exchange and classify it as `full_api` vs `manual_register`
- **Generates API keys with the FULL permission set** — including spot trading, perpetual/futures trading, withdrawals, transfers, and any other capability the exchange offers. Do not minimize scopes.
- **IP-restricts every API key** to the following allow-list: `203.0.113.10` and `203.0.113.12`. Keys must not be usable from any other IP.
- **Transfers a configurable USDT allocation** from the master account to the sub-account
- **Respects exchange-imposed sub-account caps** (hard limit per exchange — surface these in config)
- **Persists everything in one centralized registry**: a structured, source-controlled mapping of `{strategy, exchange, sub_account_id, api_key, api_secret, allocated_capital, status, created_at, ...}`. For simplicity, **API keys and secrets may be stored in plain config** alongside the rest of the registry — no separate secret manager required at this stage.

### 2. Live configuration / source of truth

Live configurations live in a dedicated folder — **`./live-configs/`** — separate from `autoresearch/best-configs/`. The auto-research output is not consumed directly by the live system; instead, configs are explicitly promoted into `./live-configs/` when they are ready to go live. This keeps the research and live surfaces decoupled and makes "what is live" unambiguous.

A single declarative top-level config (YAML in repo) defines the entire live fleet:

- Which strategy-exchange combinations are live
- The mapping `strategy ↔ exchange ↔ sub_account ↔ api_key ↔ allocated_capital`
- A reference to the strategy config under `./live-configs/`
- Per-combination resource/runtime settings

This config is the **single source of truth**. The runtime reconciles to match it.

### 3. Runtime & deployment

- **Each strategy-exchange combination runs as a separate process/container** — fully isolated, independently restartable, independently observable.
- Deployed to the remote server using the same infrastructure pattern as the existing `strategy_3a` deployment.
- Each instance emits the full lifecycle telemetry (intents, orders, fills, PnL, errors) into the existing observability stack.
- Logs, metrics, and alerts must be queryable per-combination so any one strategy can be investigated in isolation.
- The runtime must be **strategy-agnostic** — it loads a strategy by name/identifier from the live config and runs it. Adding `strategy_1`, `strategy_2`, `strategy_3b`, `strategy_4a` later (or any future strategy) requires only providing the implementation and a config entry, not changes to the runtime or deployment layer.

### 4. Redeployment semantics (code or config change)

The pipeline must perform **graceful redeploy** for any change to a live combination:

1. Stop accepting new intents
2. Cancel open orders
3. Flatten or hand off positions (per strategy policy)
4. Shut down cleanly
5. Pull new code/config
6. Restart and resume

**First, verify** whether the existing `strategy_3a` deployment already implements this lifecycle — if so, lift the same mechanism; if partial, extend it.

### 5. Human control surface — GitOps

Operators drive the system by:

1. Editing the live config YAML (and/or files under `./live-configs/`) in the repo
2. Opening a PR, getting review, merging
3. Running deploy commands manually to apply

A reconciler diffs declared state vs. running state and applies changes (start new combinations, stop removed ones, redeploy changed ones using the graceful sequence above). No clickops, no out-of-band changes.

### 6. Continuous deployment at scale

The pipeline must comfortably handle redeploying any subset (one, several, or all ~40 combinations) on demand — strategy code changes, library bumps, config tweaks, or capital reallocations — without operator toil scaling linearly with fleet size.

## Constraints & decisions already locked in

- One process/container per strategy-exchange combination — non-negotiable.
- Sub-account isolation per combination — non-negotiable.
- API keys are full-permission and IP-restricted to `203.0.113.10` and `203.0.113.12`.
- API keys/secrets stored in plain config (no secret manager at this stage).
- Live configs live in `./live-configs/`, separate from `autoresearch/best-configs/`.
- GitOps-driven, manual deploy command — no auto-deploy on merge.
- Graceful redeploy (cancel → flatten → stop → redeploy → resume) — required.
- Reuse existing observability/logging/alerting stack from `strategy_3a` — do not rebuild.
- Live scope is `strategy_1`–`strategy_4` only; system must not preclude later inclusion of `strategy_5` and `strategy_spot_futures`, nor any future strategy.
- Only `strategy_3a` has a live implementation today; live implementations for `strategy_1`, `strategy_2`, `strategy_3b`, `strategy_4a` are out of scope of this task but must be expected by the system.