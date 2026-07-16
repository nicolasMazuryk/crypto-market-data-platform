# Checklist — bybit / strategy_4_1a

Exchange: **bybit**
Strategy: **strategy_4_1a** (Negative Funding Ladder LONG — Post-Funding Entry)
Spec: `docs-strategy/strategies/strategy_4_1.md`
Code: `src/execution/strategies/strategy_4_1a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/bybit.ts`

---

**Bybit-specific notes (CRITICAL):**
- REST limit orders for all rungs (no WS adapter for ladder entry)
- Bybit WS event timestamps in **microseconds (μs)** → adapter divides by 1000 for ms
- Bybit echoes `clientOrderId` for limit fills → WS routing works for rung fills
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_4_1a.bybit.ORDER_LIFECYCLE.ALL_RUNGS_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. All N ladder rungs placed in
    parallel via Promise.allSettled. Each rung: REST createOrder (limit, buy).
    No clientOrderId transformation on Bybit. Bybit WS routing works for rung fills
    (clientOrderId echoed for limit fills). ladder.rung_placed logged for each rung.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → ladder_limit branch
    - Promise.allSettled: N REST createOrder calls
  expected_behavior:
    - intent.created logged (strategy=strategy_4_1a, exchange=bybit)
    - N × order.placed logged (kind=entry, orderType=limit, side=buy)
    - N × ladder.rung_placed logged (rungIdx 0..N-1)
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_4_1a", exchange: "bybit"}
    - log: 'ladder.rung_placed' {rungIdx: 0..N-1, limitPrice: ">0"}  # N times
    - log: 'order.placed' {kind: "entry", orderType: "limit", side: "buy"}  # N times
    - db:orders N rows {kind: "entry", orderType: "limit", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2395 (ladder_limit branch)
    - src/execution/execution/manager.ts:2450 (Promise.allSettled)
    - src/execution/execution/manager.ts:2489 (ladder.rung_placed info log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: routine


- id: strategy_4_1a.bybit.ORDER_LIFECYCLE.T_FUNDING_TIMER_RESOLVES
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    T_funding timer fires. Unfilled rungs cancelled via REST. Aggregate filledQty
    and P_avg computed. order.filled emitted programmatically. handleEntryFilled
    places SL (sell stop_market) + TP (sell limit). monitor.armed.sl_tp_deadline logged.
  preconditions:
    - intent in working or partially_filled, at least one rung filled
  trigger_sequence:
    - T_funding timer fires → cancel unfilled rungs → handleEntryFilled
  expected_behavior:
    - unfilled rungs cancelled
    - order.filled logged (aggregate)
    - position.opened logged (side=long)
    - SL + TP placed
    - monitor.armed.sl_tp_deadline logged
  observability_contract:
    - log: 'order.filled' {filledQty: "sum", avgFillPrice: "P_avg"}
    - log: 'position.opened' {side: "long"}
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - db:intentLifecycleEvents (partially_)filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:2500 (T_funding timer callback)
    - src/execution/execution/manager.ts:2540 (handleEntryFilled)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: routine


# ── TIMING ──────────────────────────────────────────────────────────────────

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_4_1a.bybit.OCO.DEADLINE_CANCELS_BOTH
  category: OCO
  severity: critical
  description: >
    Deadline fires. SL and TP cancelled. Market close (sell, reduceOnly) placed.
  preconditions:
    - intent in monitoring at deadlineAt, neither SL nor TP filled
  trigger_sequence:
    - monitor.settle('deadline') → cancel [sl, tp] → market close
  expected_behavior:
    - oco.cancel.start x2
    - order.placed {kind: "close", side: "sell", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'oco.cancel.start' x2
    - log: 'order.placed' {kind: "close"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:1578 (cancel refs)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: routine

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_4_1a.bybit.RECOVERY.RESTART_WHILE_RUNGS_RESTING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while rungs are resting in Bybit order book (status=working).
    Recovery sees resting rungs as orphans and cancels them. Intent stays in error.
  preconditions:
    - intent in DB status=working, rungs resting in Bybit book
  trigger_sequence:
    - process restart → runRecovery() → REST getOpenOrders: rungs found
    - 'recovery: orphan order found, cancelling' for each rung
  expected_behavior:
    - orphan rungs cancelled
    - no SL/TP placed
  observability_contract:
    - log: 'recovery: orphan order found, cancelling' x N
    - no 'position.opened' log
  code_refs:
    - src/execution/recovery/index.ts:271 (orphan cancel loop)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: rare

- id: strategy_4_1a.bybit.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while in monitoring. Recovery rehydrates IntentState.
    manager.start() re-arms sl_tp_deadline monitor.
  preconditions:
    - intent in DB with status=monitoring, SL and TP resting
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.sl_tp_deadline logged (debug)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_4_1a.bybit.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No Bybit REST calls (no rungs placed).
  preconditions:
    - kill switch mode != 'off', strategy_4_1a condition met for bybit
  trigger_sequence:
    - manager.submit() → preflight → kill_switch
  expected_behavior:
    - intent.error {code: "kill_switch"}, no rungs placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:orders no rows for this intentId
  code_refs:
    - src/execution/execution/preflight.ts:32
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional
```
