# Checklist — bybit / strategy_6

Exchange: **bybit**
Strategy: **strategy_6** (Pre-Funding then Main — sl_tp_deadline_post_funding_event)
Spec: `docs-strategy/strategies/strategy_6.md`
Code: `src/execution/strategies/strategy_6.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/bybit.ts`

---

**Bybit-specific notes (CRITICAL):**
- WS entry via WS order adapter (requiresWsOrderAdapter=true)
- Bybit WS event timestamps in **microseconds (μs)** → adapter divides by 1000 for ms
- Bybit echoes `clientOrderId` for market fills → WS routing is primary
- Bybit wallet/position channel for funding event gates MAIN entry
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_6.bybit.ORDER_LIFECYCLE.PRE_FUNDING_ENTRY_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. PRE-FUNDING market BUY placed
    via WS order adapter. Bybit echoes clientOrderId → WS routing is primary.
    pollForEntryFill started as backup. Bybit wallet listener registered to gate
    MAIN entry.
  preconditions:
    - strategy_6 condition met
    - WS order adapter available for bybit
  trigger_sequence:
    - scheduler fires → manager.submit() → WS adapter createOrder (buy, market)
    - pollForEntryFill started (backup)
    - wallet/position listener registered
  expected_behavior:
    - intent.created logged (strategy=strategy_6, exchange=bybit)
    - order.placed {kind: "pre_funding", side: "sell"|"buy", orderType: "market"} logged
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_6", exchange: "bybit"}
    - log: 'order.placed' {kind: "pre_funding", side: "sell"|"buy", orderType: "market"}
    - db:orders {kind: "pre_funding", intentId: "<id>", exchange: "bybit"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.bybit.ORDER_LIFECYCLE.PRE_FUNDING_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Bybit WS 'order' event with clientOrderId for the pre-funding market buy
    (μs timestamp, adapter ÷1000). byEntryOrderId lookup succeeds.
    position.pre_funding_opened logged. Strategy waits for Bybit funding event
    to gate MAIN entry. TERMINAL guard prevents double-processing from pollForEntryFill.
  preconditions:
    - pre-funding entry order placed (working), Bybit WS connected
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <id>, orderStatus: "Filled", updatedTime: <μs>}
    - adapter: updatedTime / 1000 → ms
    - byEntryOrderId lookup → position.pre_funding_opened
  expected_behavior:
    - order.filled logged (ms timestamps)
    - position.pre_funding_opened logged
    - db:fills createdAt in ms range
  observability_contract:
    - log: 'order.filled' {exchange: "bybit", filledQty: ">0"}
    - log: 'position.pre_funding_opened'
    - db:fills createdAt in valid ms range
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/strategies/strategy_6.ts (pre_funding_opened handler)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.bybit.ORDER_LIFECYCLE.MAIN_ENTRY_AFTER_WALLET_EVENT
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Bybit wallet/position WS event indicates funding fee received at T_f.
    fundingEventReceived=true. MAIN market BUY placed via WS adapter. Fill detected
    via WS (clientOrderId echoed). SL + TP placed after MAIN fill.
    monitor.armed.sl_tp_deadline_post_funding_event.
  preconditions:
    - pre-funding fill confirmed, waiting for Bybit funding event
  trigger_sequence:
    - Bybit WS: wallet/position funding event → fundingEventReceived=true
    - MAIN market buy via WS adapter
    - Bybit WS: order fill for MAIN (clientOrderId present)
  expected_behavior:
    - order.placed {kind: "main", side: "buy"|"sell"} logged
    - MAIN fill detected via WS (<1s)
    - SL (stop_market, sell) + TP (limit, sell) placed
    - monitor.armed.sl_tp_deadline_post_funding_event logged
  observability_contract:
    - log: 'order.placed' {kind: "main", side: "buy"|"sell"}
    - log: 'order.filled' (main fill, ms timestamps)
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - log: 'monitor.armed.sl_tp_deadline_post_funding_event' (debug)
    - db:fills main fill createdAt in ms range
    - db:intentLifecycleEvents →monitoring
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (funding event handler)
    - src/execution/strategies/strategy_6.ts (fundingEventReceived gate)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.bybit.ORDER_LIFECYCLE.SL_FILLS_TP_CANCELED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    SL stop_market fills (long). Bybit WS fill for SL (μs, ÷1000). monitor.settle('sl').
    Cancel TP.
  preconditions:
    - intent in monitoring, price drops to SL stop
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <slId>, orderStatus: "Filled", updatedTime: <μs>}
    - monitor.settle('sl') → cancel TP
  expected_behavior:
    - monitor.settle {reason: "sl"}
    - oco.cancel.start for TP
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:fills SL createdAt in ms range
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_6.bybit.ORDER_LIFECYCLE.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit fills. Bybit WS fill for TP (μs, ÷1000). monitor.settle('tp'). Cancel SL.
  preconditions:
    - intent in monitoring, price rises to TP level
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <tpId>, orderStatus: "Filled"}
    - monitor.settle('tp') → cancel SL
  expected_behavior:
    - monitor.settle {reason: "tp"}
    - oco.cancel.start for SL
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - db:fills TP createdAt in ms range
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/monitor.ts:131 (ws.order TP listener)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_6.bybit.TIMING.WALLET_EVENT_GATES_MAIN_ENTRY
  category: TIMING
  severity: critical
  description: >
    At T_f, Bybit emits a wallet/position WS event indicating funding fee received.
    fundingEventReceived=true. MAIN market buy placed immediately. Critical timing path.
  preconditions:
    - pre-funding fill confirmed, waiting for Bybit funding event
  trigger_sequence:
    - Bybit WS: wallet/position funding event → fundingEventReceived=true
    - MAIN buy via WS adapter
  expected_behavior:
    - MAIN entry placed within ms of funding event
  observability_contract:
    - log: 'order.placed' {kind: "main"} timestamp ≈ funding event timestamp
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (funding event handler)
    - src/execution/strategies/strategy_6.ts (fundingEventReceived gate)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.bybit.TIMING.DEADLINE_FIRES_CANCEL_BOTH
  category: TIMING
  severity: high
  description: >
    Neither SL nor TP fills before deadlineAt. Deadline fires. SL and TP cancelled.
    Market close sell placed.
  preconditions:
    - intent in monitoring, no exit before deadline
  trigger_sequence:
    - monitor.settle('deadline') → cancel [sl, tp] → market sell close
  expected_behavior:
    - oco.cancel.start x2
    - order.placed {kind: "close", side: "sell", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'oco.cancel.start' x2
    - log: 'order.placed' {kind: "close"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:115 (deadline timer)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_6.bybit.WEBSOCKET.BYBIT_MICROSECOND_TIMESTAMPS
  category: WEBSOCKET
  severity: critical
  description: >
    Bybit WS order events carry `updatedTime` in μs. Adapter ÷1000 mandatory.
    Affects pre-funding fill, MAIN fill, SL fill, TP fill timestamps.
  preconditions:
    - any Bybit WS order fill event processed
  trigger_sequence:
    - Bybit WS: order {updatedTime: <μs>} → adapter / 1000 → ms
  expected_behavior:
    - all db:fills createdAt in ms range
  observability_contract:
    - db:fills createdAt > 1700000000000 AND < 2000000000000 for all bybit rows
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.bybit.WEBSOCKET.RECONNECT_BETWEEN_PRE_AND_MAIN
  category: WEBSOCKET
  severity: high
  description: >
    Bybit WS disconnects after pre-funding fill detected but before wallet event.
    On reconnect, store.reconcile called. wallet/position listener must be re-registered.
    If funding event was missed during disconnect, MAIN entry may not fire.
  preconditions:
    - pre-funding fill confirmed, waiting for Bybit funding event
    - Bybit WS disconnects
  trigger_sequence:
    - ws.connection {state: "connected"} → store.reconcile('bybit')
    - wallet/position listener re-registered
  expected_behavior:
    - pre-funding position visible after reconcile
    - wallet listener active on new connection
    - if funding event missed: timeout/deadline fallback
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "bybit", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position visible after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: rare

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_6.bybit.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_6 intent is in monitoring on Bybit. Recovery
    rehydrates IntentState. manager.start() re-arms sl_tp_deadline_post_funding_event
    monitor.
  preconditions:
    - intent in DB with status=monitoring
    - SL and TP resting in Bybit book
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.sl_tp_deadline_post_funding_event logged (debug)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed' (debug)
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_6.bybit.SPEC_DIVERGENCE.BYBIT_MICROSECOND_TIMESTAMPS
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    Bybit WS events carry μs timestamps. Adapter ÷1000 mandatory for all fills
    (pre-funding, MAIN, SL, TP). Without conversion, db:fills timestamps corrupt.
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
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.bybit.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No Bybit WS call for pre-funding entry.
  preconditions:
    - kill switch mode != 'off', strategy_6 condition for bybit
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
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional
```
