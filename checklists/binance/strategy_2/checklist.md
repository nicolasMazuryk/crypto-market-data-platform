# Checklist — binance / strategy_2

Exchange: **binance**
Strategy: **strategy_2** (Negative Funding LONG — Retracement Exit)
Spec: `docs-strategy/strategies/strategy_2.md`
Code: `src/execution/strategies/strategy_2.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_2.binance.ORDER_LIFECYCLE.ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - entryOffsetSeconds (default 5s). Preflight passes.
    setLeverage succeeds. A market BUY is placed via the WS order adapter
    (requiresWsOrderAdapter('strategy_2')=true). order.placed logged with
    kind=entry, side=buy, orderType=market, reduceOnly=false.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() called with strategy_2 TradeIntent
  expected_behavior:
    - intent.created logged (status=decided)
    - intent.submitted logged (entryKind=market)
    - order.placed logged (kind=entry, side=buy, orderType=market, reduceOnly=false)
    - status transitions decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_2", exchange: "binance"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "market", status: "pending"}
    - db:intentLifecycleEvents transitions decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2000 (intent.created log)
    - src/execution/execution/manager.ts:2081 (transition submitted)
    - src/execution/execution/manager.ts:2755 (order.placed log)
    - src/execution/strategies/strategy_2.ts:59 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Entry — market BUY via WS adapter at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance WS order adapter is used for entry (requiresWsOrderAdapter=true).
    clientOrderId uses no transformation on Binance. ACK returns exchangeOrderId.

- id: strategy_2.binance.ORDER_LIFECYCLE.ENTRY_FILLED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market order fills. Binance emits ORDER_TRADE_UPDATE with X=FILLED on
    the private WS stream. Manager routes via byEntryOrderId lookup (field 'c'),
    logs order.filled, transitions to filled, then handleEntryFilled places SL
    immediately and arms the retracement monitor.
  preconditions:
    - entry order placed and in status=working or acked
    - Binance private WS connected
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <clientOrderId>}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice present)
    - status transitions working → filled → monitoring
    - SL placed immediately (stop_market)
    - position.opened logged (after SL placed)
    - monitor.armed.sl_tp_deadline_retracement logged (debug)
    - spawnRetracementTracker invoked
  observability_contract:
    - log: 'order.filled' {exchange: "binance", filledQty: ">0"}
    - log: 'order.placed' {kind: "sl", side: "sell", orderType: "stop_market", stopPrice: ">0"}
    - log: 'position.opened' {side: "long", filledQty: ">0"}
    - log: 'monitor.armed.sl_tp_deadline_retracement' {deadlineDelay, slId}  # debug
    - db:orders rows for kind=entry (filled) and kind=sl (pending)
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/binance.ts:48 (ORDER_TRADE_UPDATE parser)
    - src/execution/execution/manager.ts:1136 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:1156 (order.filled log)
    - src/execution/execution/manager.ts:292 (handleEntryFilled retracement variant)
    - src/execution/execution/manager.ts:368 (order.placed sl log)
    - src/execution/execution/manager.ts:397 (position.opened log)
    - src/execution/execution/manager.ts:400 (monitor.arm call)
    - src/execution/execution/manager.ts:402 (spawnRetracementTracker call)
    - src/execution/execution/monitor.ts:181 (monitor.armed.sl_tp_deadline_retracement debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (SL placed immediately after fill)
  status: ⏳
  natural_occurrence: routine
  notes: >
    SL price = avgEntryPrice * (1 - slPct/100). slPct = |fundingRatePercent| * slMultiplier.
    Binance field 'c' in ORDER_TRADE_UPDATE carries the clientOrderId.

- id: strategy_2.binance.ORDER_LIFECYCLE.SL_PLACED_IMMEDIATELY
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Immediately after entry fill, handleEntryFilled places a stop_market SL order.
    The SL is placed before position.opened and before monitor.arm. If SL placement
    fails or is rejected, closeAfterProtectionFailure fires instead of monitoring.
  preconditions:
    - entry filled, avgEntryPrice known
  trigger_sequence:
    - handleEntryFilled called after FILLED event
    - rest.createOrder {type: stop_market, stopPrice: entry * (1 - slPct/100), reduceOnly: true}
  expected_behavior:
    - order.placed logged {kind: "sl", side: "sell", orderType: "stop_market", stopPrice}
    - s.exitOrderRefs.sl set to {clientOrderId, exchangeOrderId}
    - position.opened logged immediately after
  observability_contract:
    - log: 'order.placed' {kind: "sl", orderType: "stop_market", stopPrice: ">0", reduceOnly: true}
    - db:orders row {kind: "sl", orderType: "stop_market", status: "pending"}
    - log: 'position.opened' appears after order.placed(sl)
  code_refs:
    - src/execution/execution/manager.ts:305 (slId = ids.forExit)
    - src/execution/execution/manager.ts:334 (rest.createOrder stop_market)
    - src/execution/execution/manager.ts:368 (order.placed sl log)
    - src/execution/execution/manager.ts:329 (durability write warn on failure)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (SL at avgEntryPrice * (1 - slPct/100))
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance stop_market requires stopPrice. SL is a reduce-only order. If the
    SL is immediately rejected (e.g. -2022 ReduceOnly), replaceTp detects
    "empty position" and settles as SL exit.

- id: strategy_2.binance.ORDER_LIFECYCLE.ENTRY_WS_REJECTED_REST_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    WS order adapter returns rejected (e.g. WS connectivity issue). Manager
    detects closeAck.status=rejected for a strategy requiring WS adapter and
    falls back to a REST reduce-only market close via rest.createOrder.
    Logged as close.ws_rejected.
  preconditions:
    - intent in status=exiting (deadline or other exit triggered)
    - WS order adapter returns rejected for close order
    - requiresWsOrderAdapter('strategy_2')=true
  trigger_sequence:
    - handleMonitorExit places close via orderClient(WS)
    - closeAck.status === 'rejected'
  expected_behavior:
    - close.ws_rejected logged (error level)
    - REST fallback createOrder called immediately
    - close order placed via REST (reduceOnly=true, market)
  observability_contract:
    - log: 'close.ws_rejected' {intentId, rejectReason}  # error level
    - log: 'order.placed' {kind: "close", orderType: "market", reduceOnly: true}  # via REST
  code_refs:
    - src/execution/execution/manager.ts:1620 (closeAck.status === 'rejected' && requiresWsOrderAdapter)
    - src/execution/execution/manager.ts:1621 (close.ws_rejected log)
    - src/execution/execution/manager.ts:1625 (REST fallback createOrder)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (no WS fallback in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    On Binance, WS order adapter rejections are rare but can occur during
    heavy load or auth token expiry. REST fallback uses the same clientOrderId.

- id: strategy_2.binance.ORDER_LIFECYCLE.SL_REJECTED_PROTECTIVE_CLOSE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    After entry fill, rest.createOrder for the SL stop_market returns rejected.
    closeAfterProtectionFailure is called with code=retracement_sl_rejected.
    A REST market close is placed immediately (protective.close_placed logged).
    Intent transitions to error.
  preconditions:
    - entry filled, SL placement returns status=rejected
  trigger_sequence:
    - handleEntryFilled: slResult.status === 'rejected'
    - closeAfterProtectionFailure(s, 'retracement_sl_rejected', ...)
  expected_behavior:
    - protective.close_placed logged (error level) with code=retracement_sl_rejected
    - order.placed logged {kind: "close", reduceOnly: true}
    - intent.error logged with code=retracement_sl_rejected
    - no position.opened, no monitor.arm
  observability_contract:
    - log: 'protective.close_placed' {code: "retracement_sl_rejected"}  # error level
    - log: 'order.placed' {kind: "close", reduceOnly: true}
    - log: 'intent.error' {code: "retracement_sl_rejected"}
    - db:intentLifecycleEvents filled→error
  code_refs:
    - src/execution/execution/manager.ts:345 (slResult.status === 'rejected')
    - src/execution/execution/manager.ts:346 (closeAfterProtectionFailure call)
    - src/execution/execution/manager.ts:273 (protective.close_placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (no SL rejection path in spec)
  status: ⏳
  natural_occurrence: rare
  notes: >
    Binance SL rejection codes: -2022 (ReduceOnly), -1111 (invalid parameters).
    If position is already zero, the close itself may fail — check for
    'protective market close rejected' log at manager.ts:275.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_2.binance.TIMING.ENTRY_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Entry order is placed at approximately T_f - entryOffsetSeconds (5s by default).
    entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000. Elapsed time from
    entryAt to order.placed should be within a few hundred milliseconds.
  preconditions:
    - scheduler running, strategy condition met
  trigger_sequence:
    - scheduler fires evaluate() at entryAt
  expected_behavior:
    - intent.submitted timestamp <= entryAt + 1000ms
    - order.placed timestamp <= entryAt + 2000ms
  observability_contract:
    - log: 'intent.submitted' timestamp <= entryAt + 1000ms
    - log: 'order.placed' {kind: "entry"} timestamp <= entryAt + 2000ms
  code_refs:
    - src/execution/strategies/strategy_2.ts:59 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Entry at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    WS adapter adds negligible latency versus REST. monitor.ts skewMs affects
    deadline timing only, not entry placement.

- id: strategy_2.binance.TIMING.FUNDING_FEE_EVENT_OPENS_GATE
  category: TIMING
  severity: critical
  description: >
    At T_f, Binance emits ACCOUNT_UPDATE with m=FUNDING_FEE on the private WS.
    mapFundingFee parses it and emits ws.funding_fee on the bus. The retracement
    tracker's bus.on('ws.funding_fee') handler checks exchange/symbol/fundingTime
    within 5s tolerance of fundingTs, sets fundingGateOpen=true, and begins
    P_low tracking on the next tick.
  preconditions:
    - intent in status=monitoring, retracement tracker running
    - WS connected, funding settlement occurs at T_f
  trigger_sequence:
    - Binance WS: ACCOUNT_UPDATE {m: "FUNDING_FEE", s: <symbol>}
    - bus.emit('ws.funding_fee') triggered in private-ws-base
  expected_behavior:
    - ws.funding_fee bus event emitted (internal only — no logger.info)
    - fundingGateOpen set to true in tracker
    - P_low tracking begins on next 1s tick
  observability_contract:
    - bus: 'ws.funding_fee' {exchange: "binance", symbol: <symbol>}
    - log: event='intent.funding_gate_opened' {intentId: "<id>", openedAt: ">0", fundingTs: ">0"}
    - db:fundingAttributions row inserted for the funding fee credit
    - log: 'retracement.tp_placed' appears shortly after (once P_low makes new low)
  code_refs:
    - src/execution/adapters/privatews/binance.ts:52 (ACCOUNT_UPDATE handler)
    - src/execution/adapters/privatews/binance.ts:55 (mapFundingFee call)
    - src/execution/execution/manager.ts:871 (bus.on ws.funding_fee in tracker)
    - src/execution/execution/manager.ts:875 (fundingGateOpen = true)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (P_low tracking after funding fee)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance ACCOUNT_UPDATE m=FUNDING_FEE is the primary gate signal. The
    5s tolerance window handles exchange clock drift.

- id: strategy_2.binance.TIMING.FUNDING_FEE_TIMEOUT_FALLBACK
  category: TIMING
  severity: high
  description: >
    The ws.funding_fee event does not arrive before timeoutAt (= T_f + fundingFeeTimeoutSeconds).
    The hard timeout setTimeout in the tracker fires, setting fundingGateOpen=true
    via the fallback path. P_low tracking begins without the WS event.
  preconditions:
    - intent in monitoring, ws.funding_fee not received before timeoutAt
  trigger_sequence:
    - setTimeout fires at timeoutAt (T_f + fundingFeeTimeoutSeconds * 1000)
    - fundingGateOpen set to true via timeout fallback
  expected_behavior:
    - P_low tracking begins after timeout fires
    - TP may be placed if price has dropped below anchor
    - No ws.funding_fee log (event not received)
  observability_contract:
    - no bus: 'ws.funding_fee' for this intent/symbol before timeout
    - log: 'retracement.tp_placed' may appear post-timeout (if P_low new low)
    - db:fundingAttributions row absent (fee not received via WS)
  code_refs:
    - src/execution/execution/manager.ts:879 (setTimeout timeoutDelay fallback)
    - src/execution/execution/manager.ts:881 (fundingGateOpen = true via timeout)
    - src/execution/strategies/strategy_2.ts:68 (timeoutAt = nextFundingTimestamp + fundingFeeTimeoutSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (no timeout fallback in spec — spec divergence)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    This is a spec divergence: spec assumes immediate P_low tracking after T_funding,
    code adds a timeout gate. Binance ACCOUNT_UPDATE is generally reliable; this
    fallback handles WS gaps.

- id: strategy_2.binance.TIMING.DEADLINE_FIRES
  category: TIMING
  severity: critical
  description: >
    Deadline timer fires at deadlineAt = T_f + deadlineSeconds * 1000. Monitor
    settle('deadline') is called. handleMonitorExit cancels both SL and TP
    (if resting), then places a market close order (kind=close).
  preconditions:
    - intent in monitoring
    - SL resting, TP may or may not be resting
    - neither SL nor TP has filled before deadline
  trigger_sequence:
    - setTimeout callback in monitor fires at deadlineAt - skewMs
    - monitor.settle('deadline') called
    - handleMonitorExit: cancel SL ref, cancel TP ref (if present), place market close
  expected_behavior:
    - monitor.deadline_fired logged {deadlineAt}
    - monitor.settle {reason: "deadline"} logged
    - intent.exiting.start {reason: "deadline"} logged
    - oco.cancel.start logged for each ref (SL, TP if present)
    - order.placed {kind: "close", orderType: "market", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"} (from poll path) or db transition
  observability_contract:
    - log: 'monitor.deadline_fired' {intentId, deadlineAt}
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'intent.exiting.start' {reason: "deadline"}
    - log: 'order.placed' {kind: "close", orderType: "market", reduceOnly: true}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "deadline", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:156 (deadline timer set)
    - src/execution/execution/monitor.ts:157 (monitor.deadline_fired log)
    - src/execution/execution/monitor.ts:93 (monitor.settle log)
    - src/execution/execution/manager.ts:1479 (intent.exiting.start log)
    - src/execution/execution/manager.ts:1578 (cancel SL/TP refs loop)
    - src/execution/execution/manager.ts:1660 (order.placed close log)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Deadline at T_f + deadlineSeconds)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Deadline is the most common exit when P_low never drops below anchorPrice.
    skewMs is subtracted from deadlineDelay in monitor.ts:155.

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_2.binance.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market fills. Binance emits ORDER_TRADE_UPDATE for the SL order.
    Monitor's ws.order listener detects fill (clientOrderId matches slId),
    calls settle('sl'). handleMonitorExit cancels residual TP via
    cancelSiblingExit, sweeps, exits with reason=sl.
  preconditions:
    - intent in monitoring
    - SL and TP (if placed) both resting
    - price drops to SL trigger level
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <slClientOrderId>}
    - monitor.settle('sl') → handleMonitorExit(s, 'sl')
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - intent.exiting.start {reason: "sl"} logged
    - oco.cancel.start logged for TP ref (if TP was resting)
    - oco.cancel.success logged
    - oco.sweep.start/complete (sweepReduceOnlyOrders)
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'intent.exiting.start' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpClientOrderId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "sl", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
    - db:realizedPnl row
  code_refs:
    - src/execution/execution/monitor.ts:166 (ws.order listener for SL fill)
    - src/execution/execution/monitor.ts:177 (settle 'sl')
    - src/execution/execution/manager.ts:1502 (reason === 'sl': cancel tp ref)
    - src/execution/execution/manager.ts:1520 (cancelSiblingExit call)
    - src/execution/execution/manager.ts:1561 (sweepReduceOnlyOrders)
    - src/execution/execution/manager.ts:1564 (transition exited)
    - src/execution/execution/manager.ts:1565 (intent.exited.complete log)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (SL fills → cancel TP → exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Binance SL fill arrives via ORDER_TRADE_UPDATE X=FILLED with stopPrice
    present. The monitor matches by clientOrderId (slId field).

- id: strategy_2.binance.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit order fills. The retracement tracker's per-TP WS subscription
    (bus.on('ws.order') scoped to canonTpId) detects fill, calls settleTp().
    settleTp calls monitor.disarm then handleMonitorExit('tp'). handleMonitorExit
    cancels residual SL via cancelSiblingExit.
  preconditions:
    - TP limit order resting, SL resting
    - price retraces to TP limit price
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <tpClientOrderId>}
    - tracker's currentTpUnsub fires → settleTp(avgFillPrice)
    - monitor.disarm → handleMonitorExit(s, 'tp')
  expected_behavior:
    - monitor.settle logged (via handleMonitorExit internal path) — actually monitor.disarm called
    - intent.exiting.start {reason: "tp"} logged
    - oco.cancel.start logged for SL ref
    - oco.cancel.success logged
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'intent.exiting.start' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slClientOrderId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "tp", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:935 (currentTpUnsub bus.on ws.order)
    - src/execution/execution/manager.ts:839 (settleTp called on fill)
    - src/execution/execution/manager.ts:843 (monitor.disarm)
    - src/execution/execution/manager.ts:844 (handleMonitorExit 'tp')
    - src/execution/execution/manager.ts:1504 (reason === 'tp': cancel sl ref)
    - src/execution/execution/manager.ts:1565 (intent.exited.complete)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (TP fills → cancel SL → exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    The TP fill is detected by the tracker's own subscription (not the main
    monitor). monitor.disarm must be called before handleMonitorExit to prevent
    the deadline from firing concurrently.

- id: strategy_2.binance.OCO.DEADLINE_CANCELS_BOTH
  category: OCO
  severity: critical
  description: >
    Deadline fires while both SL and TP are resting. handleMonitorExit iterates
    s.exitOrderRefs [sl, tp] and calls cancelSiblingExit for each, then places
    a market close order.
  preconditions:
    - intent in monitoring
    - both SL and TP resting at deadline
  trigger_sequence:
    - monitor.settle('deadline')
    - handleMonitorExit: for ref of [sl, tp] → cancelSiblingExit
    - rest.createOrder market close
  expected_behavior:
    - oco.cancel.start logged twice (for sl, for tp)
    - oco.cancel.success or oco.cancel.exhausted for each
    - order.placed {kind: "close", orderType: "market"}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'oco.cancel.start' x2 (sl and tp refs)
    - log: 'order.placed' {kind: "close", orderType: "market", reduceOnly: true}
    - log: 'intent.exited.complete' {exitReason: "deadline"}
    - db:orders no open sl or tp rows after exit
  code_refs:
    - src/execution/execution/manager.ts:1578 (refs = [sl, tp].filter...)
    - src/execution/execution/manager.ts:1580 (cancelSiblingExit for each ref)
    - src/execution/execution/manager.ts:1660 (order.placed close log)
    - src/execution/execution/manager.ts:1409 (cancelSiblingExit function)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Deadline cancels SL+TP, market close)
  status: ⏳
  natural_occurrence: routine
  notes: >
    If TP has not yet been placed (price never dropped below anchor), only SL
    ref exists in exitOrderRefs. refs array will have only the sl entry.

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_2.binance.STRATEGY_SPECIFIC.TP_PLACED_ON_NEW_P_LOW
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    After fundingGateOpen=true, the tracker polls refPrice every 1s. When
    currentPrice < pLow and currentPrice < anchorPrice, a new pLow is recorded
    and replaceTp is called. A TP limit order is placed at
    pLow + (anchorPrice - pLow) * retracementPct. retracement.tp_placed logged.
  preconditions:
    - fundingGateOpen=true (ws.funding_fee received or timeout fired)
    - currentPrice < pLow (new low established)
    - currentPrice < anchorPrice
  trigger_sequence:
    - tracker tick: refPrice < pLow → replaceTp(tpPrice)
    - rest.createOrder {type: limit, price: tpPrice, reduceOnly: true, kind: tp}
  expected_behavior:
    - SL is cancelled before TP placed (Bybit reduce-only quota; also done on Binance for consistency)
    - order.placed {kind: "tp", orderType: "limit", price: tpPrice}
    - retracement.tp_placed logged (info level)
    - tpVersion increments to 1
  observability_contract:
    - log: 'retracement.tp_placed' {kind: "tp", orderType: "limit", price: ">0", tpVersion: 1}
    - db:orders row {kind: "tp", orderType: "limit", status: "pending"}
  code_refs:
    - src/execution/execution/manager.ts:1020 (currentPrice < pLow → replaceTp)
    - src/execution/execution/manager.ts:1026 (tpPrice = pLow + (anchorPrice-pLow)*retracementPct)
    - src/execution/execution/manager.ts:992 (retracement.tp_placed log)
    - src/execution/execution/manager.ts:929 (tpId = ids.forIntent(intent.id, 100+tpVersion++))
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Dynamic TP at retracement level)
  status: ⏳
  natural_occurrence: routine
  notes: >
    On Binance, SL cancel before TP placement follows the same replaceTp logic
    as Bybit (cancel SL via cancelSiblingExit, then place TP). SL is removed from
    exitOrderRefs after successful cancel.

- id: strategy_2.binance.STRATEGY_SPECIFIC.TP_REPLACED_ON_FURTHER_LOW
  category: STRATEGY_SPECIFIC
  severity: high
  description: >
    Price makes a further new low after the first TP was placed. replaceTp is
    called again: the previous TP is cancelled via cancelSiblingExit, a new TP
    is placed at the updated tpPrice. tpVersion increments monotonically.
  preconditions:
    - TP already placed (currentTpCanonId set)
    - price drops below previous pLow
  trigger_sequence:
    - tracker tick: refPrice < pLow → replaceTp
    - cancelSiblingExit(currentTpRef) → places new TP
  expected_behavior:
    - oco.cancel.start logged for previous TP
    - oco.cancel.success logged
    - retracement.tp_placed logged with incremented tpVersion
    - old TP order cancelled on Binance
  observability_contract:
    - log: 'oco.cancel.start' {clientOrderId: <old-tp-id>}
    - log: 'retracement.tp_placed' {tpVersion: ">1"}
    - db:orders: old tp row cancelled, new tp row pending
  code_refs:
    - src/execution/execution/manager.ts:890 (replaceTp: cancel previous TP)
    - src/execution/execution/manager.ts:900 (cancelSiblingExit currentTpRef)
    - src/execution/execution/manager.ts:929 (new tpId with incremented tpVersion)
    - src/execution/execution/manager.ts:992 (retracement.tp_placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (TP tracks P_low dynamically)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    replaceTp rate-limits to 1 replace per second (lastReplaceAt check at
    manager.ts:887). Multiple new lows within 1s are batched to the next tick.

- id: strategy_2.binance.STRATEGY_SPECIFIC.TP_VERSION_MISMATCH_IGNORED
  category: STRATEGY_SPECIFIC
  severity: medium
  description: >
    A WS fill event arrives for a stale TP version (old canonTpId after replaceTp
    has updated currentTpCanonId). The tracker's currentTpUnsub was already
    cleaned up via cleanup() before the new TP was placed, so the old subscription
    is gone. The fill event for the old TP is ignored by the main monitor (not in
    monitor's slId watch). Intent stays in monitoring.
  preconditions:
    - TP replaced at least once (tpVersion >= 2)
    - stale TP fill event arrives after replacement
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE for old TP clientOrderId
    - currentTpUnsub already unsubscribed (cleanup() called in replaceTp)
  expected_behavior:
    - fill event not acted on (no settleTp call)
    - intent remains in monitoring
    - new TP subscription active for current tpVersion
  observability_contract:
    - no 'intent.exiting.start' for stale TP fill
    - intent stays in monitoring (db status unchanged)
    - log: 'retracement.tp_placed' for current version still active
  code_refs:
    - src/execution/execution/manager.ts:833 (cleanup: currentTpUnsub?.())
    - src/execution/execution/manager.ts:935 (new subscription only for canonTpId)
    - src/execution/execution/manager.ts:890 (replaceTp cleanup call)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (TP version monotonically increases)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    The main monitor (monitor.ts) only watches slId for the retracement variant
    (not tpId — TP is managed by the tracker). So a stale TP fill via WS
    would not trigger the monitor's settle path either.

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_2.binance.WEBSOCKET.RECONNECT_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    Binance private WS disconnects and reconnects while intent is in monitoring.
    store.reconcile is called on reconnect (ws.connection→connected transition).
    SL and TP orders are fetched from REST getOpenOrders and remain tracked.
    The deadline timer remains armed (not reset by reconnect).
  preconditions:
    - intent in status=monitoring, SL resting, TP may be resting
    - WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"} then {state: "connected"}
    - store.reconcile(exchange) called
  expected_behavior:
    - REST getOpenOrders fetched for the exchange
    - SL/TP refs still correctly tracked in exitOrderRefs
    - deadline timer fires at original deadlineAt (unchanged)
    - no duplicate exit triggered
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal — no logger.info)
    - log: event='ws.connection' {exchange: "binance", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - SL and TP orders visible in REST getOpenOrders response
    - db:intentLifecycleEvents no extraneous transitions
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile call)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (no WS reconnect behavior)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Binance listen key expires after 60 minutes; the WS adapter renews it.
    Reconnect after expiry will trigger reconcile. The retracement tracker
    continues independently of WS reconnects (it uses bus.on for WS events).

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_2.binance.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while a strategy_2 intent is in status=monitoring (entry
    filled, SL resting, TP may be resting). Recovery rehydrates IntentState
    from DB including exitOrderRefs (sl, tp refs). manager.start() re-arms
    the monitor with sl_tp_deadline_retracement policy. spawnRetracementTracker
    is NOT re-called on recovery — deadline is the only remaining exit path
    (TP must be re-placed manually if not already resting and price is still low).
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline_retracement_funding_event
    - exitOrderRefs.sl present in DB
  trigger_sequence:
    - process restart → runRecovery() → loadActiveIntents
    - manager.start() → monitor.arm(s) for monitoring intents
  expected_behavior:
    - 'recovery: rehydrated intent states' logged with rehydratedCount >= 1
    - monitor.armed.sl_tp_deadline_retracement logged (debug) — slId from exitOrderRefs
    - deadline timer re-armed; SL WS listener re-wired to slId
    - if deadlineAt is past: deadline fires immediately (delay=0)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline_retracement' {deadlineDelay, slId}  # debug
    - db:intentLifecycleEvents no change on recovery (already monitoring)
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1892 (monitor.arm for status=monitoring)
    - src/execution/execution/monitor.ts:153 (sl exitOrderRefs rehydrated)
    - src/execution/execution/monitor.ts:181 (monitor.armed.sl_tp_deadline_retracement debug)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    After recovery, the retracement tracker does NOT restart. If the position is
    still open and deadlineAt is in the future, the deadline will close it.
    If SL fires after recovery, it is detected by the re-armed monitor WS listener.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_2.binance.SPEC_DIVERGENCE.FUNDING_FEE_TIMEOUT
  category: SPEC_DIVERGENCE
  severity: medium
  description: >
    Spec assumes P_low tracking begins immediately after T_funding. Code adds
    a funding-fee gate: P_low tracking only begins when ws.funding_fee is received
    OR when the hard timeout (timeoutAt = T_f + fundingFeeTimeoutSeconds) fires.
    If the WS event is delayed, TP placement is delayed proportionally.
  preconditions:
    - ws.funding_fee delayed or missing before timeoutAt
  trigger_sequence:
    - tracker registered but fundingGateOpen=false
    - timeout at timeoutAt fires → fundingGateOpen=true
  expected_behavior:
    - P_low tracking starts at timeoutAt, not at T_f
    - potential missed TP placement window if price already retraced
  observability_contract:
    - no 'retracement.tp_placed' log before timeoutAt (gate was closed)
    - if price already retraced: TP may not be placed (no further new low)
  code_refs:
    - src/execution/execution/manager.ts:879 (timeoutDelay setTimeout)
    - src/execution/execution/manager.ts:822 (isFundingEventKind flag)
    - src/execution/strategies/strategy_2.ts:68 (timeoutAt computation)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (immediate tracking after T_funding)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    This divergence is intentional code behavior. Tracking only after the funding
    fee is confirmed prevents placing TP before the position's P&L snapshot.

- id: strategy_2.binance.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch is active when a strategy_2 intent would be submitted. Preflight
    rejects with code=kill_switch. No order reaches the exchange.
  preconditions:
    - kill switch mode != 'off'
    - strategy_2 condition met
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.created logged
    - intent.error logged with code=kill_switch
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/manager.ts:2044 (preflight call)
    - src/execution/execution/manager.ts:2046 (setError on preflight fail)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (no kill switch in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Kill switch is the emergency stop for all strategies. Not in spec but
    critical for go-live safety.
```
