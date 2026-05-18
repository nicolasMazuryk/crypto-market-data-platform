# Checklist — gateio / strategy_4_1a

Exchange: **gateio**
Strategy: **strategy_4_1a** (Negative Funding Ladder LONG — Post-Funding Entry)
Spec: `docs-strategy/strategies/strategy_4_1.md`
Code: `src/execution/strategies/strategy_4_1a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

**GateIO-specific notes:**
- REST limit orders for all rungs (no WS for ladder entry)
- `futures.orders` WS channel for rung fill events; timestamps in **seconds** (adapter × 1000)
- `cancelIgnoreCode: 'TEXT_DUPLICATED'` for T_funding cancel of unfilled rungs
- Symbol normalization in `recovery.ts:302-305`
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_4_1a.gateio.ORDER_LIFECYCLE.ALL_RUNGS_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. All N ladder rungs placed in
    parallel via Promise.allSettled. Each rung: REST createOrder (limit, buy,
    reduceOnly=false). No clientOrderId transformation on GateIO. ladder.rung_placed
    logged for each successful rung.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (default -0.6%)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - N = ladderCount rungs configured
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → ladder_limit branch
    - Promise.allSettled: N REST createOrder calls
  expected_behavior:
    - intent.created logged (strategy=strategy_4_1a, exchange=gateio)
    - N × order.placed logged (kind=entry, orderType=limit, side=buy)
    - N × ladder.rung_placed logged (info, rungIdx 0..N-1)
    - N clientOrderIds registered in byEntryOrderId (no dash-strip)
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_4_1a", exchange: "gateio"}
    - log: 'ladder.rung_placed' {rungIdx: 0..N-1, limitPrice: ">0"}  # N times
    - log: 'order.placed' {kind: "entry", orderType: "limit", side: "buy"}  # N times
    - db:orders N rows {kind: "entry", orderType: "limit", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2395 (ladder_limit branch)
    - src/execution/execution/manager.ts:2450 (Promise.allSettled)
    - src/execution/execution/manager.ts:2476 (order.placed emit per rung)
    - src/execution/execution/manager.ts:2489 (ladder.rung_placed info log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Entry — ladder_limit)
  status: ⏳
  natural_occurrence: routine
  notes: >
    GateIO limit orders for rungs use no clientOrderId transformation. Rung fills
    arrive on 'futures.orders' WS channel with SECOND timestamps (adapter × 1000).

- id: strategy_4_1a.gateio.ORDER_LIFECYCLE.T_FUNDING_TIMER_RESOLVES
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    T_funding timer fires. Unfilled rungs cancelled via REST (GateIO TEXT_DUPLICATED
    on cancel = success). Aggregate filledQty and P_avg computed. order.filled emitted
    programmatically. handleEntryFilled places SL (sell stop_market) + TP (sell limit).
    monitor.armed.sl_tp_deadline logged.
  preconditions:
    - intent in working or partially_filled
    - at least one rung filled (filledQty > 0)
  trigger_sequence:
    - T_funding timer fires → cancel unfilled rungs (TEXT_DUPLICATED OK) → handleEntryFilled
  expected_behavior:
    - unfilled rungs cancelled (TEXT_DUPLICATED treated as success)
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
    - src/execution/execution/manager.ts:2510 (cancel unfilled rungs)
    - src/execution/execution/manager.ts:2525 (aggregate)
    - src/execution/execution/manager.ts:2540 (handleEntryFilled)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (T_funding resolves)
  status: ⏳
  natural_occurrence: routine
  notes: >
    GateIO cancelOrder for unfilled rungs: TEXT_DUPLICATED response means already cancelled/filled.
    cancelIgnoreCode='TEXT_DUPLICATED' ensures cancel proceeds silently.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_4_1a.gateio.TIMING.SL_TP_PLACED_AT_T_FUNDING
  category: TIMING
  severity: critical
  description: >
    SL and TP placed only when T_funding timer fires, not at rung fill time.
    During [entryAt, T_funding], position is unprotected if a rung fills early.
  preconditions:
    - at least one rung filled before T_funding (pre-funding fill scenario)
  trigger_sequence:
    - T_funding fires → SL + TP placed
  expected_behavior:
    - SL and TP placed only after T_funding
    - no SL/TP before T_funding timestamp in DB
  observability_contract:
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"} timestamps ≥ nextFundingTimestamp
  code_refs:
    - src/execution/execution/manager.ts:2540 (handleEntryFilled from T_funding)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: routine

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_4_1a.gateio.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL sell stop_market fills (long position). GateIO 'futures.orders' WS emits fill
    for SL (SECOND timestamps). Monitor settle('sl'). handleMonitorExit cancels TP
    (TEXT_DUPLICATED OK).
  preconditions:
    - intent in monitoring, SL and TP resting, price drops below SL stop price
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <slId>}
    - monitor.settle('sl') → handleMonitorExit
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP (TEXT_DUPLICATED = success)
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order SL fill listener)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_1a.gateio.OCO.DEADLINE_CANCELS_BOTH
  category: OCO
  severity: critical
  description: >
    Deadline fires. SL and TP cancelled (TEXT_DUPLICATED OK). Market close (sell,
    reduceOnly=true) placed for the long position.
  preconditions:
    - intent in monitoring at deadlineAt, neither SL nor TP filled
  trigger_sequence:
    - monitor.settle('deadline') → cancel [sl, tp] → market close
  expected_behavior:
    - oco.cancel.start x2 (TEXT_DUPLICATED OK)
    - order.placed {kind: "close", side: "sell", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'oco.cancel.start' x2
    - log: 'order.placed' {kind: "close", side: "sell"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:1578 (cancel refs)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: routine

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_4_1a.gateio.RECOVERY.RESTART_WHILE_RUNGS_RESTING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while rungs are resting in GateIO order book (status=working).
    Recovery sees resting rungs as orphans and cancels them (TEXT_DUPLICATED OK).
    Intent stays in error. No SL/TP placed.
  preconditions:
    - intent in DB status=working, rungs resting in GateIO book
  trigger_sequence:
    - process restart → runRecovery() → REST getOpenOrders: rungs found
    - 'recovery: orphan order found, cancelling' for each rung
  expected_behavior:
    - orphan rungs cancelled (TEXT_DUPLICATED OK)
    - no SL/TP placed
  observability_contract:
    - log: 'recovery: orphan order found, cancelling' x N
    - no 'position.opened' log
  code_refs:
    - src/execution/recovery/index.ts:271 (orphan cancel loop)
    - src/execution/recovery/index.ts:302 (GateIO symbol normalization)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: rare

- id: strategy_4_1a.gateio.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while in monitoring (T_funding resolved, SL and TP resting).
    Recovery rehydrates IntentState. manager.start() re-arms sl_tp_deadline monitor.
    GateIO symbol normalization applied.
  preconditions:
    - intent in DB with status=monitoring
    - exitOrderRefs.sl and .tp present
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.sl_tp_deadline logged (debug)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
  code_refs:
    - src/execution/recovery/index.ts:302 (GateIO symbol normalization)
    - src/execution/recovery/index.ts:245 (rehydrated states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_4_1a.gateio.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No GateIO REST calls (no rungs placed).
  preconditions:
    - kill switch mode != 'off', strategy_4_1a condition met for gateio
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

- id: strategy_4_1a.gateio.SPEC_DIVERGENCE.GATEIO_TIMESTAMP_SECONDS
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    GateIO 'futures.orders' WS events use SECOND timestamps. Adapter × 1000 required.
    Pre-funding fill warning uses clock.now() < nextFundingTimestamp — this comparison
    is in ms and must be correct.
  preconditions:
    - GateIO WS rung fill events processed
  trigger_sequence:
    - GateIO WS: futures.orders {create_time: <seconds>}
    - adapter × 1000
  expected_behavior:
    - clock.now() vs nextFundingTimestamp comparison valid (both ms)
    - db:fills createdAt in valid ms range
  observability_contract:
    - db:fills createdAt > 1700000000000
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (timestamp conversion)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: routine
```
