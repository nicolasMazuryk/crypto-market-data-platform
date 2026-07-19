# Checklist — kucoin / strategy_4_1a

Exchange: **kucoin**
Strategy: **strategy_4_1a** (Negative Funding Ladder LONG — Post-Funding Entry)
Spec: `docs-strategy/strategies/strategy_4_1.md`
Code: `src/execution/strategies/strategy_4_1a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

**KuCoin-specific notes:**

- REST limit orders for all rungs (no WS adapter for ladder entry)
- KuCoin LIMIT order WS fills DO echo `clientOrderId` → WS routing works for rung fills
- KuCoin market order fills lack clientOrderId (but ladder rungs are limits — not affected)
- `cancelIgnoreCode: 100004` (order not found = success) for T_funding rung cancels and OCO
- ms timestamps throughout
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_4_1a.kucoin.ORDER_LIFECYCLE.ALL_RUNGS_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. All N ladder rungs placed in
    parallel via Promise.allSettled. Each rung: REST createOrder (limit, buy,
    reduceOnly=false). No clientOrderId transformation on KuCoin. ladder.rung_placed
    logged for each successful rung. KuCoin WS routing works for limit fills
    (clientOrderId IS echoed for limit orders).
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - N = ladderCount rungs configured
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → ladder_limit branch
    - Promise.allSettled: N REST createOrder calls
  expected_behavior:
    - intent.created logged (strategy=strategy_4_1a, exchange=kucoin)
    - N × order.placed logged (kind=entry, orderType=limit, side=buy)
    - N × ladder.rung_placed logged (rungIdx 0..N-1)
    - N clientOrderIds registered in byEntryOrderId
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_4_1a", exchange: "kucoin"}
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
    KuCoin limit order WS fills echo clientOrderId → normal WS routing works for
    rung fills. Only MARKET order WS fills lack clientOrderId on KuCoin.

- id: strategy_4_1a.kucoin.ORDER_LIFECYCLE.PRE_FUNDING_FILL_WARNING
  category: ORDER_LIFECYCLE
  severity: medium
  description: >
    A rung fills before T_funding (early market dip). KuCoin WS 'orders' emits
    fill for rung with clientOrderId (limit fills echo clientOrderId). Manager routes
    via byEntryOrderId, marks rung.filled=true, logs 'ladder.pre_funding_fill' at warn.
    T_funding timer still resolves.
  preconditions:
    - intent in working, rung limitPrice hit before T_funding
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <rungId>}
    - byEntryOrderId lookup succeeds → pre_funding_fill warn
  expected_behavior:
    - 'ladder.pre_funding_fill' warn logged
    - rung.filled=true, filledQty aggregated
    - status working → partially_filled
  observability_contract:
    - log: 'ladder.pre_funding_fill' {intentId, clientOrderId: "<rung id>"}  # warn
    - db:intentLifecycleEvents → partially_filled
  code_refs:
    - src/execution/execution/manager.ts:1074 (transition partially_filled)
    - src/execution/execution/manager.ts:1078 (ladder.pre_funding_fill warn)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Scenario A invariant)
  status: ⏳
  natural_occurrence: rare

- id: strategy_4_1a.kucoin.ORDER_LIFECYCLE.T_FUNDING_TIMER_RESOLVES
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    T_funding timer fires. Unfilled rungs cancelled via REST (KuCoin 100004 on
    cancel = success). Aggregate filledQty and P_avg computed. order.filled emitted
    programmatically. handleEntryFilled places SL (sell stop_market) + TP (sell limit).
    monitor.armed.sl_tp_deadline logged.
  preconditions:
    - intent in working or partially_filled
    - at least one rung filled (filledQty > 0)
  trigger_sequence:
    - T_funding timer fires → cancel unfilled rungs (100004 OK) → handleEntryFilled
  expected_behavior:
    - unfilled rungs cancelled (100004 treated as success)
    - order.filled logged (aggregate filledQty, P_avg)
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
    KuCoin cancelOrder for unfilled rungs: 100004 response means already cancelled/filled.
    cancelIgnoreCode=100004 ensures cancel proceeds silently.

- id: strategy_4_1a.kucoin.ORDER_LIFECYCLE.LADDER_NO_FILLS
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    T_funding fires but no rungs filled (filledQty=0). 'ladder.no_fills' warn logged.
    setError(s, 'ladder_no_fills'). Intent terminal.
  preconditions:
    - intent in working, no rungs filled before T_funding
  trigger_sequence:
    - T_funding timer: filledQty === 0 → setError('ladder_no_fills')
  expected_behavior:
    - 'ladder.no_fills' warn logged
    - intent.error {code: "ladder_no_fills"}
    - all rungs cancelled (100004 OK)
  observability_contract:
    - log: 'ladder.no_fills' {intentId}
    - log: 'intent.error' {code: "ladder_no_fills"}
    - db:intentLifecycleEvents working→error
  code_refs:
    - src/execution/execution/manager.ts:2520 (filledQty === 0 check)
    - src/execution/execution/manager.ts:2521 ('ladder.no_fills' warn)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_4_1a.kucoin.TIMING.SL_TP_PLACED_AT_T_FUNDING
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

- id: strategy_4_1a.kucoin.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL sell stop_market fills (long position). KuCoin WS 'orders' emits fill for
    SL with clientOrderId (stop orders echo clientOrderId). monitor.settle('sl').
    handleMonitorExit cancels TP (cancelIgnoreCode=100004).
  preconditions:
    - intent in monitoring, SL and TP resting, price drops below SL stop price
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <slId>}
    - monitor.settle('sl') → cancel TP (100004 OK)
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP (100004 = success)
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_1a.kucoin.OCO.DEADLINE_CANCELS_BOTH
  category: OCO
  severity: critical
  description: >
    Deadline fires. SL and TP cancelled (100004 OK each). Market close (sell,
    reduceOnly=true) placed for the long position.
  preconditions:
    - intent in monitoring at deadlineAt, neither SL nor TP filled
  trigger_sequence:
    - monitor.settle('deadline') → cancel [sl, tp] (100004 OK) → market close
  expected_behavior:
    - oco.cancel.start x2 (100004 = success)
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

- id: strategy_4_1a.kucoin.RECOVERY.RESTART_WHILE_RUNGS_RESTING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while rungs are resting in KuCoin order book (status=working).
    Recovery sees resting rungs as orphans and cancels them (100004 OK). Intent
    stays in error. No SL/TP placed.
  preconditions:
    - intent in DB status=working, rungs resting in KuCoin book
  trigger_sequence:
    - process restart → runRecovery() → REST getOpenOrders: rungs found
    - 'recovery: orphan order found, cancelling' for each rung
  expected_behavior:
    - orphan rungs cancelled (100004 OK)
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

- id: strategy_4_1a.kucoin.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while in monitoring (T_funding resolved, SL and TP resting).
    Recovery rehydrates IntentState. manager.start() re-arms sl_tp_deadline monitor.
    cancelIgnoreCode=100004 for orphan cancel calls.
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
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_4_1a.kucoin.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No KuCoin REST calls (no rungs placed).
  preconditions:
    - kill switch mode != 'off', strategy_4_1a condition met for kucoin
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

- id: strategy_4_1a.kucoin.SPEC_DIVERGENCE.KUCOIN_LIMIT_FILLS_ECHO_CLIENT_ORDER_ID
  category: SPEC_DIVERGENCE
  severity: low
  description: >
    Unlike KuCoin MARKET order fills (which lack clientOrderId in WS events), KuCoin
    LIMIT order fills DO echo clientOrderId. Strategy_4_1a uses limit rungs → WS routing
    works normally for rung fills. No pollForEntryFill PRIMARY quirk for this strategy.
  preconditions:
    - rung fill events arrive on KuCoin WS 'orders' channel
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <rungId>} (limit fill)
    - byEntryOrderId lookup succeeds → normal routing
  expected_behavior:
    - rung fills routed correctly via WS (no REST poll dependency for rung detection)
  observability_contract:
    - (normal WS routing path — no special logging)
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (limit fill: clientOrderId present)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    Contrast with strategy_2/strategy_3a/strategy_1_ws where market fills lack clientOrderId.
    Ladder strategies use limit orders → not affected by the KuCoin market fill quirk.
```
