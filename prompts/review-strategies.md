# Code Review: Strategy Execution & Backtesting Engine

## Objective

Perform a thorough, line-by-line code review of the codebase responsible for **live execution** and **backtesting** of all trading strategies listed below. Your goal is to verify behavioral correctness, internal consistency, and parity between the live and backtest engines — and to surface any bugs, false positives, race conditions, or logical inconsistencies.

## Scope of Review

For **every** strategy listed in the strategy specifications section, verify the following dimensions across **both** the live execution engine and the backtesting engine:

### 1. Order Lifecycle
- **Order placement** — correct side, type, quantity, price, timing, and parameters; correct handling of API responses; proper retry/error semantics.
- **Order execution** — fills are detected, attributed, and accounted for correctly (partial fills, full fills, rejected fills, fee accounting).
- **Order cancellation** — cancellations are issued at the right moments, acknowledged correctly, and state is updated atomically; no orphaned or "zombie" orders.
- **End-to-end order flow** — from signal → placement → ack → fill/cancel/expire → position update → exit → reconciliation.

### 2. Strategy Correctness
- **Accuracy** — the implemented logic matches the strategy specification exactly. No silent deviations, no missing branches.
- **Timing** — all time-relative offsets (entry, exit, deadline) are computed against the correct reference clock (funding event time, exchange time, local time) and applied consistently between live and backtest.
- **Execution timing & edge cases** — behavior at boundary conditions: simultaneous events, clock drift, latency, websocket disconnects, missed funding events, late fills, fills crossing the deadline, partial fills near the deadline, etc.
- **All possible scenarios & use cases** — happy path, all OCO branches, deadline branch, no-fill branch, partial-fill branches, exchange errors, network errors, restart/recovery.

### 3. Consistency Checks
- **Live vs Backtest parity** — same inputs must produce the same decisions and the same resulting positions, P&L, and order log (modulo unavoidable real-world noise like slippage).
- **No false positives** — no strategy should generate phantom entries, phantom exits, or duplicate orders under any sequence of events.
- **No inconsistencies** — state machines must be deterministic; no path can leave the system with stale orders, mismatched positions, or untracked exposure.

## OCO Semantics (Applies to strategy_2, strategy_3a/b, strategy_4.1a/b, strategy_4.2a/b, strategy_6)

Verify these invariants hold under **every** event interleaving:

- If **SL** triggers → TP and deadline exits must be canceled and must never fire.
- If **TP** triggers → SL and deadline exits must be canceled and must never fire.
- If **deadline** triggers → SL and TP must be canceled and must never fire.
- Cancellations must be confirmed; the system must handle the race where an exit triggers between the decision to cancel and the cancel ack.

## Strategy Specifications

### `strategy_1`
- No SL, no TP.
- Pure time-based:
  - Entry order placed at `entry_offset_seconds` relative to the funding event.
  - Exit order placed at `exit_offset_seconds` relative to the funding event.

### `strategy_1-ws`
- No SL, no TP.
- Time-based entry, websocket-driven exit:
  - Entry order placed at `entry_offset_seconds` relative to the funding event.
  - Exit order placed **immediately** when the funding fee accrual event is received via the user data websocket.

### `strategy_2`
- **SL** placed immediately after the Entry MARKET order.
- **TP** placed immediately when the funding fee accrual event arrives via the user data websocket.
- **TP is dynamic**: must be recalculated from `retracement_pct` and `lowest_price`, and replaced on the exchange each time `lowest_price` makes a new low.
- Full OCO semantics apply (SL / TP / deadline).

### `strategy_3a/b`
- **SL** placed immediately after the Entry MARKET order.
- **TP** placed immediately after the Entry MARKET order.
- Full OCO semantics apply (SL / TP / deadline).

### `strategy_4.1a/b`
- A **ladder of Entry LIMIT orders** placed at `entry_offset_seconds`.
- **SL** placed immediately after the Entry LIMIT ladder is placed.
- **TP** placed immediately when the first (or any) Entry LIMIT order is triggered and filled.
- **TP is dynamic**: must be recalculated from the average entry price and replaced on the exchange every time a new (lower) LIMIT entry fills and changes the average entry price.
- Full OCO semantics apply (SL / TP / deadline), plus:
  - If the position is exited by **any** means (TP, SL, or deadline) → cancel **all** remaining unfilled Entry LIMIT orders.
  - If **no** Entry LIMIT order fills and the deadline is reached → cancel all open Entry LIMIT orders, the SL, and the TP.

### `strategy_4.2a/b`
- Identical to `strategy_4.1a/b`, except there is a **single** Entry LIMIT order instead of a ladder.

### `strategy_6`
- **PRE_FUNDING_ORDER** placed at `entryOffsetSeconds` before the funding event.
- **MAIN MARKET Entry order** placed **immediately** when the funding fee accrual event (originating from the `PRE_FUNDING_ORDER` position) is received via the user data websocket.
- **SL and TP** orders placed **immediately** when the MAIN Entry order is filled/executed.
- **Funding fee timeout guard**: if, by `F_time + fundingFeeTimeoutSeconds`, the funding fee accrual event (from `PRE_FUNDING_ORDER`) has **NOT** been received via the user data websocket, then the MAIN MARKET Entry order **must not** be triggered/executed, **AND**:
  - If `PRE_FUNDING_ORDER` **was** executed and there is an open position → the open position must be automatically closed by a MARKET order.
  - If `PRE_FUNDING_ORDER` was **not** executed and there is no open position → do nothing.
- Full OCO semantics apply (SL / TP / deadline) once the MAIN Entry is filled.
- Additional verification required:
  - Correct attribution of the funding fee accrual event to the `PRE_FUNDING_ORDER`-derived position (not to an unrelated position on the same symbol).
  - Correct reference clock for `F_time + fundingFeeTimeoutSeconds` (exchange time vs local time) and consistent application across live and backtest.
  - Race between the timeout firing and the funding fee event arriving (event arrives during the cleanup path, or cleanup begins just as the event lands).
  - Race between the auto-close MARKET order and a late MAIN Entry being submitted; the MAIN Entry must be hard-gated by the timeout flag, not merely "not yet sent".
  - If `PRE_FUNDING_ORDER` partially filled at the time of the timeout, the auto-close MARKET order must close exactly the filled quantity and any resting portion of `PRE_FUNDING_ORDER` must be canceled.

## Deliverable

Produce a structured report with the following sections:

1. **Summary** — overall health of the codebase, headline findings.
2. **Per-strategy findings** — one subsection per strategy, covering live engine, backtest engine, and live/backtest parity. Note correct behaviors as well as defects.
3. **Cross-cutting issues** — bugs or design flaws affecting multiple strategies (order state machine, OCO handler, websocket reconnect, time source, etc.).
4. **Race conditions & edge cases** — every interleaving you considered and whether the code handles it.
5. **False positives / inconsistencies** — any path that produces incorrect signals, duplicate orders, untracked positions, or live/backtest divergence.
6. **Severity-ranked bug list** — Critical / High / Medium / Low, each with: file & line reference, reproduction scenario, expected vs actual behavior, and a recommended fix.
7. **Recommended tests** — concrete unit, integration, and replay tests that would have caught each Critical/High issue.

**Cite specific files, functions, and line numbers for every claim.** Do not generalize. If you are uncertain about a behavior, say so explicitly and describe the experiment or test that would resolve it.