# Checklist — bitget / strategy_3a

Exchange: **bitget**
Strategy: **strategy_3a** (Negative Funding SHORT — sl_tp_deadline)
Spec: `docs-strategy/strategies/strategy_3a.md`
Code: `src/execution/strategies/strategy_3a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/bitget.ts`

---

**Bitget-specific notes:**
- REST entry (no WS adapter for strategy_3a)
- Bitget 'orders' WS channel for fill events; timestamps in ms (no conversion)
- Bitget echoes `clientOrderId` → WS routing is primary for entry and exit fills
- SHORT position: entry=SELL market, SL=buy stop_market, TP=buy limit
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_3a.bitget.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_REST
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. Market SELL placed via REST
    createOrder. Bitget echoes clientOrderId in WS fills → WS routing is primary.
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
    - intent.created logged (strategy=strategy_3a, exchange=bitget)
    - order.placed (kind=entry, side=sell, orderType=market) logged
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_3a", exchange: "bitget"}
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

- id: strategy_3a.bitget.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Bitget WS 'orders' event with clientOrderId (ms timestamp). byEntryOrderId lookup
    succeeds. handleEntryFilled → position.opened (short). SL (buy stop_market) + TP
    (buy limit) placed. monitor.armed.sl_tp_deadline logged.
  preconditions:
    - entry sell order placed (working), Bitget WS connected
  trigger_sequence:
    - Bitget WS: orders {clientOrderId: <id>, status: "full-fill"}
    - byEntryOrderId lookup → handleEntryFilled
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice, ms timestamps)
    - position.opened logged (side=short)
    - order.placed {kind: "sl", side: "buy", orderType: "stop_market"} logged
    - order.placed {kind: "tp", side: "buy", orderType: "limit"} logged
    - monitor.armed.sl_tp_deadline logged (debug)
    - status working → filled → monitoring
  observability_contract:
    - log: 'order.filled' {exchange: "bitget", filledQty: ">0"}
    - log: 'position.opened' {side: "short"}
    - log: 'order.placed' {kind: "sl", side: "buy"}
    - log: 'order.placed' {kind: "tp", side: "buy"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1140 (handleEntryOrderEvent)
    - src/execution/execution/manager.ts:406 (handleEntryFilled SL+TP)
    - src/execution/execution/monitor.ts:80 (sl_tp_deadline arm)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_3a.bitget.ORDER_LIFECYCLE.SL_FILLS_TP_CANCELED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    SL buy stop_market fills (short covered at loss). Bitget WS 'orders' fill for SL
    with clientOrderId. monitor.settle('sl'). handleMonitorExit cancels TP.
  preconditions:
    - intent in monitoring, SL and TP resting, price rises to SL stop
  trigger_sequence:
    - Bitget WS: orders {clientOrderId: <slId>, status: "full-fill"}
    - monitor.settle('sl') → cancel TP
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.bitget.ORDER_LIFECYCLE.TP_FILLS_SL_CANCELED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    TP buy limit fills (short covered at profit). Bitget WS 'orders' fill for TP.
    monitor.settle('tp'). handleMonitorExit cancels SL.
  preconditions:
    - intent in monitoring, TP resting, price drops to TP level (for short)
  trigger_sequence:
    - Bitget WS: orders {clientOrderId: <tpId>, status: "full-fill"}
    - monitor.settle('tp') → cancel SL
  expected_behavior:
    - monitor.settle {reason: "tp"} logged
    - oco.cancel.start for SL
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:131 (ws.order TP listener)
    - src/execution/execution/manager.ts:1504 (cancel sl on tp)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_3a.bitget.TIMING.DEADLINE_FIRES_CANCEL_BOTH
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

- id: strategy_3a.bitget.OCO.SIMULTANEOUS_FILL_RACE
  category: OCO
  severity: high
  description: >
    Extreme price gap causes both SL and TP to appear filled nearly simultaneously.
    monitor.settle fires for first; TERMINAL guard blocks second. cancelSiblingExit on
    already-filled order returns order-not-found; treated as success.
  preconditions:
    - extreme price gap, both SL and TP fill simultaneously
  trigger_sequence:
    - Bitget WS: two fill events for SL and TP in quick succession
    - monitor.settle for first; TERMINAL guard blocks second
    - cancelSiblingExit → order-not-found → success
  expected_behavior:
    - intent exits once (TERMINAL guard)
    - oco.cancel.start for sibling (no error)
    - intent.exited.complete exactly once
  observability_contract:
    - log: 'intent.exited.complete' exactly once
  code_refs:
    - src/execution/execution/monitor.ts (TERMINAL guard)
    - src/execution/execution/manager.ts:1502 (cancelSiblingExit)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: rare

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_3a.bitget.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_3a intent is in monitoring on Bitget. Recovery
    rehydrates IntentState. manager.start() re-arms sl_tp_deadline monitor.
  preconditions:
    - intent in DB with status=monitoring
    - SL and TP resting in Bitget book
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

- id: strategy_3a.bitget.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No Bitget REST sell order placed.
  preconditions:
    - kill switch mode != 'off', strategy_3a condition for bitget
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
