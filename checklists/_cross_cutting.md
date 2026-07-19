# Cross-Cutting Scenarios

These scenarios apply across all 6 exchanges × all 7 strategies. They are not strategy-specific but are critical for live verification. Each exchange/strategy checklist may reference this file rather than duplicate these items.

---

## 1. WS RECONNECT → RECONCILE

**Trigger:** Private WS emits `ws.connection` event with `{state:'connected'}` after having been in a non-connected state (disconnected, connecting, or reconnecting).

**Code:** `src/execution/state/store.ts:214-222`

**Flow:**

1. WS drops (network blip, keepalive timeout, exchange-side close).
2. WS adapter re-establishes connection and emits `ws.connection {state:'connected'}`.
3. State store listener detects the transition from non-connected → connected.
4. `store.reconcile()` is called: REST `getOpenOrders` and `getPositions` are fetched for the exchange.
5. In-memory order/position maps are updated from REST snapshot.
6. Any actively armed monitor timer is NOT reset — it continues to fire at the original `exitAt`.

**Observable signals:**

- Bus event: `ws.connection {state:'connected'}` — now also a structured `logger.info` line: `log: event='ws.connection' {exchange: "<exchange>", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}`
- REST activity: `getOpenOrders` + `getPositions` calls visible in exchange rate-limit counters or network logs
- State maps should reflect consistent values after reconcile

**Telemetry:** Reconcile completion is logged at INFO as `store.reconcile.complete` with `durationMs` and `desyncCount`. A `reconcile_failed` fatal opsEvent fires on unexpected error.

**What to verify:**

- State maps are not stale after reconnect (position qty matches exchange REST)
- No duplicate exit is triggered by reconcile (monitor timer survives reconnect)
- No intent status regression (e.g. monitoring → working)

**Applies to:** All 6 exchanges × all 7 strategies

---

## 2. PROCESS RESTART → RECOVERY

**Trigger:** Engine process restarts — crash, OOM kill, deliberate redeploy, or systemd unit restart.

**Code:** `src/execution/recovery/index.ts:87-360`

**Flow:**

1. `runRecovery()` is called on startup.
2. `findLatestOpenRun()` checks DB for a prior open run. If found, logs `'recovery: found open run, resuming'` and resumes it.
3. `loadActiveIntents()` reads all non-terminal intents from DB, rehydrates `IntentState` maps, and restores `byEntryOrderId` / `byCloseOrderId` lookup maps.
4. Logs `'recovery: rehydrated intent states'` with `{rehydratedCount}`.
5. Open exchange orders not in the rehydrated set are treated as orphans: `'recovery: orphan order found, cancelling'` logged, `cancelOrder` called.
6. Open positions without a matching rehydrated intent are flattened (orphan position).
7. Rehydrated states plus initial REST snapshot are passed to `manager.start()`.
8. `manager.start()` re-arms monitors for all intents in `monitoring`, `exiting`, or `working` states.

**Observable signals:**

- `log: 'recovery: found open run, resuming'` or `'recovery: started new run'`
- `log: 'recovery: rehydrated intent states' {rehydratedCount: N}`
- `log: 'recovery: orphan order found, cancelling'` (if applicable)
- `log: 'monitor.armed.timed'` for all re-armed monitoring intents (may fire immediately if `exitAt` is in the past)
- `db:opsEvents {eventType: "recovery.orphan_order_cancelled"}` on each successful orphan cancel
- `db:opsEvents {eventType: "recovery.orphan_position_flattened"}` on each successful orphan position flatten
- `db:opsEvents {eventType: "recovery.orphan_order_cancel_failed"}` if orphan cancel throws unexpectedly
- `db:opsEvents {eventType: "recovery.orphan_position_flatten_failed"}` if orphan position flatten throws unexpectedly

**Critical edge case:** If `exitAt` (timed) or `deadlineAt` is already in the past when recovery runs, `delay = max(0, ...)` resolves to 0 and the timer fires immediately. The position may still be open — the close order must still be placed and will be.

**Applies to:** All 6 exchanges × all 7 strategies

---

## 3. RATE LIMIT HANDLING

**Trigger:** Exchange returns a rate-limit error during order placement (REST `createOrder` call).

**Code:** `src/execution/execution/manager.ts:2707` (createOrder catch → `setError('create_order_failed')`)

**Flow:**

1. Preflight passes. `createOrder` REST call is made.
2. Exchange returns HTTP 429 or an API-level rate-limit code.
3. CCXT wraps this as a `RateLimitExceeded` exception.
4. Manager catch block calls `setError(s, 'create_order_failed', err.message)`.
5. Intent transitions to error (terminal). No retry is attempted at this level.

**Observable signals:**

- `log: 'intent.error' {code:'create_order_failed'}` — the `err.message` field contains the exchange-specific code
- `db:intentLifecycleEvents` transition: `submitted → error`
- `db:orders` row may exist in `status=pending` (durability write runs before `createOrder`)

**Exchange-specific rate-limit codes:**
| Exchange | Code |
|----------|------|
| Binance | -1003 |
| Bybit | 10006 |
| OKX | 50011 |
| Gate.io | `RateLimitExceeded` (CCXT class) |
| KuCoin | 429 |
| Bitget | 429 / `Too Many Requests` |

**Applies to:** All 6 exchanges × all 7 strategies (entry and close order placement)

---

## 4. KILL SWITCH

**Trigger:** `killSwitch.canPlaceOrder()` returns `false` at preflight time.

**Code:** `src/execution/execution/preflight.ts:32`, `src/execution/execution/manager.ts:2044-2052`

**Flow:**

1. Strategy evaluates condition and calls `manager.submit()`.
2. Preflight runs as the first gate — before balance check, market check, or any REST call.
3. `killSwitch.canPlaceOrder()` returns `false` (kill switch mode is not `'off'`).
4. `setError(s, 'kill_switch')` called immediately.
5. Intent is terminal. No order reaches the exchange.

**Observable signals:**

- `log: 'intent.created' {status:'decided'}`
- `log: 'intent.error' {code:'kill_switch'}`
- `db:intentLifecycleEvents` transition: `decided → error`
- `db:orders`: no row for this `intentId`

**Note:** The kill switch is the emergency stop for all strategies. Documented in `docs-strategy/strategies/_globals.md` under "Safety Mechanisms".

**Applies to:** All 6 exchanges × all 7 strategies, at all submission stages

---

## 5. DURABILITY WRITE FAILURE

**Trigger:** `beforeCreateOrder()` DB write throws before the REST `createOrder` call is made (or the SL durability write at line 329 fails for retracement strategies).

**Code:** `src/execution/execution/manager.ts:2680-2685` (entry order durability), `src/execution/execution/manager.ts:329` (SL order durability)

**Flow:**

1. `beforeCreateOrder()` is called with the pending order record.
2. DB write fails (ClickHouse unreachable, connection timeout, schema error).
3. Manager logs a **warn** and continues — the REST `createOrder` call proceeds anyway.
4. If `createOrder` succeeds: order is live on exchange but NOT in DB.
5. If process then crashes before the fill WS event updates the DB, recovery sees this order as an orphan and cancels it.

**Observable signals:**

- `log: 'manager: durability write failed — proceeding without pre-submit persistence'` (warn level)
- If crash follows: `log: 'recovery: orphan order found, cancelling'` on restart

**Risk:** An order placed after a durability write failure that then fills before the process crashes will create a real position that recovery cancels (or leaves flat). A `durability_write_failed` fatal opsEvent is emitted on each durability failure.

**Applies to:** All 6 exchanges × all 7 strategies

---

## 6. SEQUENCE GAP (WS event drop)

**Trigger:** WS sequence number gap detected in the state store while processing inbound WS events.

**Code:** `src/execution/state/store.ts:231-237` (`checkSeqGap` → `emitDesync` + `store.reconcile`)

**Flow:**

1. Inbound WS event carries a sequence number lower or non-contiguous with the expected next sequence.
2. `checkSeqGap` detects the gap.
3. `emitDesync` is called — a `desync` event is emitted on the internal bus.
4. `store.reconcile()` is triggered to restore consistent state from REST.
5. Any in-flight intent that was updated by the dropped WS event will be corrected by the REST snapshot.

**Observable signals:**

- Bus: `desync` event (internal bus only — no `logger.info`)
- Reconcile-level REST activity (same as scenario 1 above)
- Brief window of potentially stale in-memory state between gap and reconcile completion

**Applies to:** All exchanges that provide sequence numbers in their private WS streams (Binance, Bybit, OKX). Gate.io, KuCoin, and Bitget may use non-sequential or no sequence numbers — gap detection behavior varies.
