# Autoresearch

Autonomous strategy parameter tuning. A Claude agent proposes YAML edits one parameter at a time; the harness runs a backtest, commits improvements, reverts regressions, and repeats. Each strategy/exchange combination runs in its own git worktree so multiple tuning runs execute in parallel without interfering.

## Architecture

- **Orchestrator** (`src/autoresearch/orchestrate.ts`) — entry point; loads matrix, manages two semaphores (run-level + ClickHouse-level), spawns per-tag controllers.
- **Matrix** (`autoresearch/matrix.yaml`) — declares which `(strategy, exchange)` pairs to tune and global settings.
- **Git worktrees** — one isolated worktree per tag under `.autoresearch/worktrees/<tag>/`; shares `.git` object store with the main repo.
- **Agent loop** (`src/autoresearch/loop/`) — per iteration: build prompt → spawn agent (`claude -p` or `codex exec`) → enforce scope → run backtest → keep/revert.
- **Agent backends** (`src/autoresearch/agent/`) — `invoke.ts` dispatches to `claude.ts` or `codex.ts` based on `RunSpec.agent`; both produce the same `InvokeAgentResult` shape.
- **Diff-gate** (`src/autoresearch/git/diff-gate.ts`) — reverts any file the agent touched outside `config/strategies/<strategy>.yaml`; extra check for `strategy_5` pins.
- **Backtest runner** (`src/autoresearch/backtest/runner.ts`) — spawns `npx tsx src/scripts/run-backtest.ts --strategy <name>` in the worktree directory.
- **Results TSV** (`.autoresearch/results/<tag>/results.tsv`) — append-only authoritative history; used to reconstruct state on resume.
- **Git ratchet** — on improvement: `git add -A && git commit`; on regression: `git reset --hard <last_keep_commit>`.

## End-to-End Flow

1. **Configure** `autoresearch/matrix.yaml` — add strategy/exchange rows, set iterations and parallelism.
2. **Run baselines** — `npm run autoresearch -- --baseline-only` runs iter 0 (no agent, just backtest) for all rows. Establishes baseline PnL.
3. **Run full tuning** — `npm run autoresearch` starts the agent loop for all matrix rows up to `default_iterations`.
4. **Per iteration** (internal):
   1. Build prompt: program.md + current YAML + last 100 TSV rows (with rationales) + baseline/best PnL + iter counter.
   2. Spawn agent (`claude -p` or `codex exec`, per row `agent:` field). Agent edits `config/strategies/<strategy>.yaml` and writes `.autoresearch/results/<tag>/proposal.json`.
   3. Diff-gate reverts any out-of-scope edits.
   4. If YAML unchanged → noop, skip backtest.
   5. Run backtest, parse `total_net_pnl`.
   6. If `pnl > best_pnl` → commit (keep). Else → `git reset --hard` (discard).
   7. Append row to `results.tsv`.
5. **Monitor** — `npm run autoresearch:dashboard` regenerates `.autoresearch/dashboard.json` with aggregated stats across all runs.
6. **Resume** — re-running any command picks up from the TSV automatically. Worktrees and state survive restarts.

## Commands

```bash
npm run autoresearch -- --baseline-only     # Iter 0 only (no agent), all rows
npm run autoresearch                        # Run all matrix rows
npm run autoresearch -- --run <tag>         # Run a single tag
npm run autoresearch -- --reset             # Wipe all tags (worktrees + branches + state + dashboard)
npm run autoresearch -- --reset --run strategy_1-binance  # Wipe a single tag only
npm run autoresearch:list                   # Print all tags and iteration counts
npm run autoresearch:dashboard              # Rebuild dashboard.json and exit
```

If an agent needs direct remote access to the remote server which hosts ClickHouse database:

```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10
```

`REMOTE_SERVER_HOST` is the single configured host/IP source for remote access.

## CLI Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--matrix <path>` | `autoresearch/matrix.yaml` | Path to matrix YAML |
| `--program <path>` | `autoresearch/program.md` | Path to agent instructions |
| `--run <tag>` | (all) | Run only this tag; repeatable for multiple tags |
| `--baseline-only` | false | Run iter 0 only (backtest, no agent) |
| `--reset` | false | Delete worktree + autoresearch branch + results + reports + logs for selected tags, then exit. Combine with `--run` to reset a single tag. Removes dashboard.json when resetting all tags. |
| `--list` | false | List matrix tags and exit |
| `--dashboard` | false | Rebuild dashboard.json and exit |

## matrix.yaml

```yaml
default_iterations: 50        # iterations per run (overridable per row)
max_parallel: 4               # concurrent runs
max_parallel_backtests: 4     # concurrent ClickHouse-hitting backtests (≤ max_parallel)
iteration_timeout_ms: 600000  # wall-clock timeout for agent invocation
backtest_timeout_ms: 600000   # wall-clock timeout for backtest
per_iteration_budget_usd: 0.50

runs:
  - strategy: strategy_1      # matches config/strategies/strategy_1.yaml
    exchange: binance          # tag: strategy_1-binance
    agent: claude              # 'claude' (default) or 'codex'
  - strategy: strategy_5
    exchange_a: binance        # tag: strategy_5-binance_bybit
    exchange_b: bybit
    iterations: 30             # optional per-row override
    agent: codex
```

**Tag naming:** `<strategy>-<exchange>` for single-exchange; `strategy_5-<exchange_a>_<exchange_b>` for cross-exchange.

## Runtime State

All runtime state is gitignored under `.autoresearch/`:

```
.autoresearch/
├── worktrees/<tag>/                  # git worktree; base_config.yaml overridden per-tag
├── results/<tag>/
│   ├── results.tsv                   # authoritative history (iter, pnl, status, description…)
│   ├── state.json                    # current iter_count, best_pnl, best_commit
│   ├── proposal.json                 # agent output for current iteration
│   └── proposals/
│       └── iter_<N>.json             # archived proposal (rationale + summary) per iteration
├── reports/<tag>/
│   └── iter_<N>.json                 # copy of backtest JSON report per iteration
├── logs/<tag>.log                    # Pino structured log per tag
└── dashboard.json                    # aggregated stats across all tags
```

**results.tsv columns:** `iter  timestamp  commit_hash  total_net_pnl  sharpe  win_rate  trades  status  description  report_path  duration_s  error_message`

**status values:** `keep` (improved, committed) · `discard` (regressed, reverted) · `noop` (YAML unchanged) · `error` (agent or backtest failure)

**5 consecutive errors** → controller stops that tag, marks status as `error`.

## Agent Instructions

`autoresearch/program.md` is the stable prefix of every agent prompt. It tells the agent to:
- Edit only `config/strategies/<strategy>.yaml` (numeric parameters only).
- Write `proposal.json` with `{rationale, summary}`.
- Run only read-only shell commands from the allowlist in program.md; never touch git.

The harness appends a variable suffix each iteration: recent TSV rows + current YAML content + baseline/best PnL + `iter N of M`.

## Key Source Files

| File | Responsibility |
|------|---------------|
| `src/autoresearch/orchestrate.ts` | CLI entry, semaphore setup, SIGINT handling |
| `src/autoresearch/matrix/loader.ts` | Parse + validate matrix.yaml |
| `src/autoresearch/loop/controller.ts` | Per-tag state machine (worktree → baseline → loop) |
| `src/autoresearch/loop/iteration.ts` | Single iteration: agent → diff-gate → backtest → keep/discard |
| `src/autoresearch/loop/pool.ts` | Semaphore for run + CH parallelism |
| `src/autoresearch/agent/invoke.ts` | Dispatcher: routes to `claude.ts` or `codex.ts` based on `RunSpec.agent` |
| `src/autoresearch/agent/claude.ts` | Spawn `claude -p` with timeout + tool allowlist |
| `src/autoresearch/agent/codex.ts` | Spawn `codex exec` with workspace-write sandbox + timeout |
| `src/autoresearch/agent/prompt-builder.ts` | Assemble stable prefix + variable suffix |
| `src/autoresearch/git/diff-gate.ts` | Revert out-of-scope edits post-agent |
| `src/autoresearch/git/ratchet.ts` | commit / reset-hard helpers |
| `src/autoresearch/backtest/runner.ts` | Spawn backtest, detect new JSON report |
| `src/autoresearch/backtest/parser.ts` | Extract metrics from report JSON |
| `src/autoresearch/results/tsv.ts` | Append-only TSV read/write |
| `src/autoresearch/results/state.ts` | state.json read/write |
| `src/autoresearch/results/resume.ts` | Reconstruct state from TSV on restart |
| `src/autoresearch/worktree/manager.ts` | Create/remove git worktrees |
| `src/autoresearch/dashboard.ts` | Aggregate all tags into dashboard.json |
| `autoresearch/matrix.yaml` | Run matrix configuration |
| `autoresearch/program.md` | Agent instructions (stable prompt prefix) |
