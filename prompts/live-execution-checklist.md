# Generate Live-Execution Verification Checklists for All Strategies

## Role

You are a senior trading-systems verification engineer. Your job is to produce, for each strategy on each exchange, a **practical, machine-checkable checklist of the realistic scenarios and use cases that must be observed in live execution** before the system can be trusted with larger capital.

## Context & Goal

We are deploying 7 strategies live on 6 exchanges, with small real-money positions, to verify behavioral correctness in production conditions. Every 4 hours, after each funding event, a downstream agent will:

1. Ingest collected execution data (orders, fills, websocket events, internal state transitions, logs).
2. Match what was observed against the checklist you produce.
3. Mark each scenario as **verified ✅ / not yet observed ⏳ / failed ❌**, per exchange.

We will only scale capital once the checklist is verified across all 6 exchanges. Therefore your checklist must be:

- **Realistic** — only scenarios that are likely to happen in normal live operation. **Not exhaustive.**
- **Pragmatic** — aim for **~80% coverage of the most important, most realistic cases**. Skip exotic edge cases and rare race conditions unless the strategy logic depends on them.
- **Unambiguous** — each item describes one concrete event sequence with one expected outcome.
- **Verifiable from execution data alone** — no human judgment required; if it can't be checked from logs / order data / websocket records, the item must instead become a telemetry gap.

## Inputs

- `@docs-strategy/**` — strategy specifications (source of truth for intended behavior).
- `@src/execution/**` — live execution engine (source of truth for actual implementation).
- The attached code-review prompt — a **starting point only**. Use it for guidance on what kinds of behaviors matter, but do not treat its scenario list as a target to expand on. Focus on realistic cases.

## Strategies in Scope

`strategy_1`, `strategy_1_ws`, `strategy_2`, `strategy_3a`, `strategy_4_1a`, `strategy_4_2a`, `strategy_6`.

## Exchanges in Scope

`binance`, `bybit`, `bitget`, `okx`, `gateio`, `kucoin`.

## Methodology — do this for each strategy, in order

### Step 1 — Understand the strategy

Read the full spec in `@docs-strategy/**`. Internally summarize:

- Entry mechanics (order type, timing reference, offset, ladder vs single, pre-funding leg).
- Exit mechanics (SL / TP / deadline / funding-event-driven / websocket-driven / time-based).
- State machine — the main states and transitions.
- The time references used (funding event time, exchange time, local time, websocket timestamps).
- OCO scope (which exits are mutually exclusive).

### Step 2 — Trace the implementation in `@src/execution/**`

Open the live execution engine and trace the strategy's main code paths:

- Locate the file(s) implementing this strategy.
- Identify the state machine, order manager, OCO handler, websocket handlers, and exchange-API call sites.
- Note the **main branches** the code takes — happy path, common error paths, common cancellation paths.
- Identify recovery paths that are realistic in production (restart with an open position, websocket reconnect).
- Note any behaviors in code that are NOT in the spec, and any spec behaviors that have NO corresponding code.

You do not need to enumerate every `if` and `try/except`. Focus on the paths that real funding events will actually exercise.

### Step 3 — Enumerate realistic scenarios

From the union of spec + code, enumerate the realistic scenarios. **Aim for ~15–30 items per strategy.** Cover the following dimensions, but only with scenarios that are plausible in normal live operation:

**A. Order lifecycle (happy path + common failures)**
Placement success; common placement rejections (insufficient margin, rate-limited); full fill; partial fill resolving to full fill; standard cancel acked; cancel rejected because order already filled.

**B. Timing (the main cases)**
Entry placed at the configured offset; exit at the configured offset or trigger; deadline reached with no fill; deadline reached with a partial fill.

**C. OCO (where applicable, main branches only)**
SL fires → TP and deadline canceled correctly. TP fires → SL and deadline canceled correctly. Deadline fires → SL and TP canceled correctly. Skip exotic race conditions unless they're likely under realistic conditions.

**D. Websocket & connectivity (realistic only)**
Funding-fee event received and handled. Short WS disconnect with normal reconnect. Skip exotic event-ordering edge cases unless the strategy specifically depends on them.

**E. Strategy-specific (the behaviors that define the strategy)**

- `strategy_2`: TP gets recalculated and replaced when `lowest_price` makes a new low. TP-replace succeeds in normal conditions. SL fires after one or more TP replacements.
- `strategy_4_1a` (ladder): first rung fills and TP is placed. Additional rungs fill and TP is recomputed against the new average. Position exits via TP, SL, or deadline → all remaining unfilled ladder rungs are canceled. Deadline reached with zero fills → all rungs, SL, TP canceled.
- `strategy_4_2a` (single LIMIT): LIMIT fills and TP is placed. Standard exit branches. Deadline reached with no fill → entry, SL, TP canceled.
- `strategy_6`: PRE_FUNDING fills, funding-fee event received, MAIN entry triggered, SL/TP placed. Funding-fee timeout fires with PRE_FUNDING filled → auto-close MARKET sent and MAIN entry hard-gated. Funding-fee timeout fires with PRE_FUNDING not filled → nothing happens.

**F. Recovery (the common case)**
Process restart with an open position and exits resting → state reconstructs correctly.

**G. Spec ↔ code divergence**
Anything in code but not in spec → flag as **undocumented**. Anything in spec but not in code → flag as **missing implementation**.

### Step 4 — Make each scenario verifiable from data

For every scenario, define an **observability contract** — the log lines, websocket messages, state transitions, and order-log fields that must appear (and in what order) for the item to be checked off. If current telemetry is insufficient to verify the scenario from data alone, **flag it as a telemetry gap**.

## Output format — folder structure & files

Structure the output as: `checklists/<exchange>/<strategy>/checklist.md`

That means **one checklist file per (exchange, strategy) pair** — 6 exchanges × 7 strategies = **42 checklist files**.

Why per-exchange-per-strategy: exchange APIs differ in error codes, fill semantics, websocket event shapes, and timing. The observability contract (exact log/event matchers) is exchange-specific, so each pair gets its own file with its own status tracking.

Each `checklist.md` contains a YAML list of items following this schema:

```yaml
- id: strategy_2.OCO.SL_FIRES_AFTER_TP_REPLACED
  category: OCO                  # ORDER_LIFECYCLE | TIMING | OCO | WEBSOCKET | RECOVERY | STRATEGY_SPECIFIC | SPEC_DIVERGENCE
  severity: high                 # critical | high | medium | low
  description: >
    Position is open with SL resting and TP that has been replaced at least once
    due to a new lowest_price. SL then triggers and fills.
  preconditions:
    - position open
    - SL resting on exchange
    - TP has been replaced ≥1 time
  trigger_sequence:
    - exchange: SL fill event
  expected_behavior:
    - SL fill detected and attributed to position close
    - resting TP canceled on the exchange
    - deadline timer canceled
    - position transitions to CLOSED exactly once
  observability_contract:
    - log:       "SL_FILL state=POSITION_OPEN"
    - log:       "TP_CANCELED reason=SL_FIRED"
    - order_log: no resting TP for this symbol after close
    - state_log: POSITION_OPEN -> POSITION_CLOSED (exactly one transition)
  code_refs:
    - src/execution/strategy_2/oco_handler.py:handle_sl_fill
  spec_refs:
    - docs-strategy/strategy_2.md (OCO section)
  status: ⏳                     # ✅ | ⏳ | ❌
  natural_occurrence: occasional # routine | occasional | rare
  notes: >
    Free-form notes on this exchange's specifics, e.g. how Bybit reports SL fills
    differently from Binance.
```

Also produce at the top level:

- `checklists/_cross_cutting.md` — realistic cross-strategy scenarios (WS reconnect, restart recovery, rate-limit handling). Keep it short — only what's likely to happen.
- `checklists/_index.md` — summary table: per (exchange, strategy) — total items, counts by severity, counts by status.
- `checklists/_gaps.md` — items flagged as **missing implementation**, **undocumented behavior**, or **insufficient telemetry**. These are blockers to relying on the checklist for go-live.

## Hard requirements

1. **Cite file + function** in `@src/execution/**` for every item. If no code handles the scenario, set `code_refs: NONE` and place the item in `_gaps.md`.
2. **No vague items.** "Handles partial fills" is unverifiable. "Entry partial fill followed by deadline → MARKET close of filled qty, resting portion canceled, exactly one CLOSED transition" is verifiable.
3. **Stay pragmatic.** If you find yourself enumerating rare race conditions or exotic interleavings, stop. Aim for the 80% of cases that are realistic in normal live operation.
4. **One checklist per (exchange, strategy).** The 42 files share the same scenario set per strategy, but each has its own status field and exchange-specific notes / observability details where they differ.
5. **Be deterministic about what counts as verified.** The `observability_contract` is the single source of truth for the downstream verifier agent; it must be matchable against structured data.

## Execution order

Process strategies in this order strategy-by-strategy:

`strategy_1` → `strategy_1_ws` → `strategy_2` → `strategy_3a` → `strategy_4_1a` → `strategy_4_2a` → `strategy_6`.

For each strategy, first emit a short trace-summary (5–10 lines describing what you found in code and spec, including any divergences). Then emit the checklist for that strategy across all 6 exchanges — i.e. produce 6 files for that strategy before moving to the next.

After all strategies are done (42 files total), emit `_cross_cutting.md`, then `_index.md`, then `_gaps.md`.

Begin with `strategy_1` on `binance`.