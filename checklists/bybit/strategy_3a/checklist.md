# Checklist — bybit / strategy_3a

Exchange: **bybit**
Strategy: **strategy_3a** (Negative Funding SHORT — sl_tp_deadline)
Spec: `docs-strategy/strategies/strategy_3a.md`
Code: `src/execution/strategies/strategy_3a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/bybit.ts`

---

**Bybit-specific notes (CRITICAL):**
- REST entry (no WS adapter for strategy_3a)
- Bybit WS event timestamps in **microseconds (μs)** → adapter divides by 1000 for ms
- Bybit echoes `clientOrderId` for market fills → WS routing is primary for entry fill
- SHORT position: entry=SELL market, SL=buy stop_market, TP=buy limit
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_3a.bybit.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_REST
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. Market SELL placed via REST
    createOrder. Bybit echoes clientOrderId in WS fills → WS routing is primary.
    pollForEntryFill started as backup.
  preconditions:
    - fundingRatePercent > positiveFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → REST createOrder (sell, market)
    - pollForEntryFill started (backup)
    - timeoutHandle set at timeoutAt
  expected_behavior:
    - intent.created logged (strategy=strategy_3a, exchange=bybit)
    - order.placed (kind=entry, side=sell, orderType=market) logged
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_3a", exchange: "bybit"}
    - log: 'order.placed' {kind: "entry", side: "sell", orderType: "market"}
    - db:orders {kind: "entry", side: "sell", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2755 (order.placed log)
    - src/execution/execution/manager.ts:2787 (pollForEntryFill start)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_3a.bybit.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Bybit WS order fill event for the market SELL (μs timestamp, adapter ÷1000).
    clientOrderId echoed → byEntryOrderId lookup succeeds. handleEntryFilled →
    position.opened (short). SL (buy stop_market) + TP (buy limit) placed.
    monitor.armed.sl_tp_deadline logged. TERMINAL guard prevents double-processing.
  preconditions:
    - entry sell order placed (working), Bybit WS connected
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <id>, orderStatus: "Filled", updatedTime: <μs>}
    - adapter: updatedTime / 1000 → ms
    - byEntryOrderId lookup → handleEntryFilled
  expected_behavior:
    - order.filled logged (ms timestamps)
    - position.opened logged (side=short)
    - order.placed {kind: "sl", side: "buy", orderType: "stop_market"} logged
    - order.placed {kind: "tp", side: "buy", orderType: "limit"} logged
    - monitor.armed.sl_tp_deadline logged (debug)
    - status working → filled → monitoring
  observability_contract:
    - log: 'order.filled' {exchange: "bybit", filledQty: ">0"}
    - log: 'position.opened' {side: "short"}
    - log: 'order.placed' {kind: "sl", side: "buy"}
    - log: 'order.placed' {kind: "tp", side: "buy"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
    - db:fills createdAt in valid ms range
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/manager.ts:1140 (handleEntryOrderEvent)
    - src/execution/execution/manager.ts:406 (handleEntryFilled SL+TP)
    - src/execution/execution/monitor.ts:80 (sl_tp_deadline arm)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    Bybit timestamps in μs. adapter ÷ 1000 converts to ms. Verify db:fills.createdAt
    is in ms range (1700000000000-2000000000000), not μs range.

- id: strategy_3a.bybit.ORDER_LIFECYCLE.SL_FILLS_TP_CANCELED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    SL buy stop_market fills (short covered at loss). Bybit WS order fill for SL
    (μs timestamp, adapter ÷1000, clientOrderId echoed). monitor.settle('sl').
    handleMonitorExit cancels TP.
  preconditions:
    - intent in monitoring, SL and TP resting, price rises to SL stop
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <slId>, orderStatus: "Filled", updatedTime: <μs>}
    - adapter ÷1000; monitor.settle('sl') → cancel TP
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:fills SL fill createdAt in ms range
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.bybit.ORDER_LIFECYCLE.TP_FILLS_SL_CANCELED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    TP buy limit fills (short covered at profit). Bybit WS fill for TP (μs, ÷1000,
    clientOrderId echoed). monitor.settle('tp'). handleMonitorExit cancels SL.
  preconditions:
    - intent in monitoring, TP resting, price drops to TP level (for short)
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <tpId>, orderStatus: "Filled", updatedTime: <μs>}
    - monitor.settle('tp') → cancel SL
  expected_behavior:
    - monitor.settle {reason: "tp"} logged
    - oco.cancel.start for SL
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:fills TP fill createdAt in ms range
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/monitor.ts:131 (ws.order TP listener)
    - src/execution/execution/manager.ts:1504 (cancel sl on tp)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_3a.bybit.TIMING.DEADLINE_FIRES_CANCEL_BOTH
  category: TIMING
  severity: critical
  description: >
    Neither SL nor TP fills before deadlineAt. Deadline fires. SL and TP cancelled.
    Market close buy (reduceOnly) placed to cover short.
  preconditions:
    - intent in monitoring at deadlineAt, neither SL nor TP filled
  trigger_sequence:
    - monitor.settle('deadline') → cancel [sl, tp] → market buy close
  expected_behavior:
    - oco.cancel.start x2
    - order.placed {kind: "close", side: "buy", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'oco.cancel.start' x2
    - log: 'order.placed' {kind: "close", side: "buy"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:115 (deadline timer)
    - src/execution/execution/manager.ts:1578 (cancel refs)
    - src/execution/execution/manager.ts:1660 (market buy close)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_3a.bybit.OCO.SIMULTANEOUS_FILL_RACE
  category: OCO
  severity: high
  description: >
    Price gap causes both SL and TP to fill within the same WS batch. Two ws.order
    events arrive. monitor.settle fires for the first; TERMINAL guard blocks the second.
    cancelSiblingExit on the already-filled order — Bybit returns order-not-found
    (exchange-specific code); cancel treated as success.
  preconditions:
    - extreme price gap fills both SL and TP simultaneously
  trigger_sequence:
    - Bybit WS: two fill events for SL and TP
    - monitor.settle fires for first; second blocked by TERMINAL guard
    - cancelSiblingExit on other leg → order-not-found → treated as success
  expected_behavior:
    - intent exits once (TERMINAL guard prevents double-exit)
    - oco.cancel.start for sibling (order-not-found = success)
    - intent.exited.complete {exitReason: "sl" or "tp"}
  observability_contract:
    - log: 'intent.exited.complete' exactly once
    - log: 'oco.cancel.start' (no error despite order-not-found)
  code_refs:
    - src/execution/execution/monitor.ts (TERMINAL guard)
    - src/execution/execution/manager.ts:1502 (cancelSiblingExit)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: rare

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_3a.bybit.WEBSOCKET.BYBIT_MICROSECOND_TIMESTAMPS
  category: WEBSOCKET
  severity: critical
  description: >
    Bybit WS order events carry `updatedTime` in microseconds (μs). Adapter must
    divide by 1000. Affects entry fill, SL fill, and TP fill timestamps. Without
    conversion, db:fills timestamps will be in μs range corrupting all time-based checks.
  preconditions:
    - any Bybit WS order fill event processed
  trigger_sequence:
    - Bybit WS: order {updatedTime: <μs value>}
    - adapter: updatedTime / 1000 → ms
  expected_behavior:
    - db:fills createdAt in ms range (1700000000000-2000000000000)
  observability_contract:
    - db:fills createdAt in valid ms range for all bybit rows
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_3a.bybit.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_3a intent is in monitoring on Bybit. Recovery
    rehydrates IntentState. manager.start() re-arms sl_tp_deadline monitor.
  preconditions:
    - intent in DB with status=monitoring
    - exitOrderRefs.sl and .tp present (resting in Bybit book)
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
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_3a.bybit.SPEC_DIVERGENCE.BYBIT_MICROSECOND_TIMESTAMPS
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    Spec and internal timestamps are ms. Bybit WS events carry μs timestamps.
    Adapter divide-by-1000 is mandatory for correctness. Entry fill, SL fill,
    TP fill all affected.
  preconditions:
    - any Bybit WS fill event processed
  trigger_sequence:
    - Bybit WS: order {updatedTime: <μs>} → adapter / 1000 → ms
  expected_behavior:
    - all timestamps stored as ms
  observability_contract:
    - db:fills createdAt in ms range for all bybit rows
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_3a.bybit.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No Bybit REST sell order placed.
  preconditions:
    - kill switch mode != 'off', strategy_3a condition for bybit
  trigger_sequence:
    - manager.submit() → preflight → kill_switch
  expected_behavior:
    - intent.error {code: "kill_switch"}, no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/preflight.ts:32
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional
```
