# Execution Engine — Trading Logic

## Signal source

All three strategies share the same signal: **predicted funding rate on USDT-margined perpetual swaps**. `FundingRateSource` polls each exchange REST endpoint every `fundingPullMs` milliseconds (default 15,000 ms) and caches a snapshot per `(exchange, symbol)`. `FundingEventScheduler` wakes `wakeBeforeHourEndMs` (default 300,000 ms = 5 min) before each hourly boundary and evaluates symbols whose `nextFundingTimestamp` falls within `fundingWindowMs` (default 300,000 ms) of that boundary.

A symbol is eligible for evaluation when:
- Its snapshot is fresh (age < 2 × `fundingPullMs`)
- `market.status === 'trading'`
- The signal condition below is met

**Signal condition** — identical across all three strategies:

```
snap.fundingRatePercent ≤ -|negativeFundingThresholdPercent|
```

`fundingRatePercent` is the predicted rate from the exchange (e.g., `-0.6` for a −0.6% rate). `negativeFundingThresholdPercent` defaults to `-0.5`; a more negative value raises the bar (fewer trades).

---

## Strategy 1 — Negative funding LONG, timed exit

**Thesis**: collect the funding payment by holding a long position through the settlement event, accepting a brief window of delta exposure.

| Attribute | Value |
|---|---|
| Direction | LONG |
| Exit policy | Timed |
| Profits from | Funding payment received (longs receive on negative funding) |
| Costs | Expected price drop during hold window + trading fees |

**Entry time**: `nextFundingTimestamp − entryOffsetSeconds × 1000` ms (default: 10 s before funding)

**Exit**: market reduce-only order submitted when a single timer fires at `nextFundingTimestamp + exitOffsetSeconds × 1000` ms (default: 2 s after funding). No SL or TP orders are placed.

**Sizing**: see [Shared sizing rule](#shared-sizing-rule) below.

### Config keys (`id: 'strategy_1'`)

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `false` | Must be `true` to activate |
| `negativeFundingThresholdPercent` | number | `-0.5` | Trigger threshold (e.g., `-0.5` → trades when rate ≤ −0.5%) |
| `entryOffsetSeconds` | number | `10` | Seconds before `nextFundingTimestamp` to submit market entry |
| `exitOffsetSeconds` | number | `2` | Seconds after `nextFundingTimestamp` to submit market exit |
| `amountUsd` | number | `20` | Target notional in USD |
| `leverage` | number | `4` | Position leverage; margin = `amountUsd / leverage` |

---

## Strategy 3a — Negative funding SHORT, TP = |F| × multiplier

**Thesis**: profit directly from the anticipated price drop triggered by the funding event. The price decline must exceed the funding fee paid plus execution fees.

| Attribute | Value |
|---|---|
| Direction | SHORT |
| Exit policy | SL + TP + deadline |
| Profits from | Price decline after funding settlement |
| Costs | Funding fee paid (shorts pay on negative funding) + trading fees |

**Entry time**: `nextFundingTimestamp − entryOffsetSeconds × 1000` ms (default: 10 s before funding)

**Take profit** (limit order, reduce-only):

```
tpPct = |fundingRatePercent| × tpVariantAMultiplier   (default multiplier: 1.5)
TP price = P_entry × (1 − tpPct / 100)
```

The `takeProfitPercent` config key is **not used at runtime** — the actual TP is computed dynamically from the funding rate at decision time. `takeProfitPercent` exists only for spec-compatibility.

**Stop loss** (stop_market order, reduce-only):

```
SL price = P_entry × (1 + stopLossPercent / 100)
```

**Deadline**: if neither SL nor TP fills before `nextFundingTimestamp + deadlineSeconds × 1000` ms (default: 300 s), the engine submits a market reduce-only close.

The first exit to trigger (SL, TP, or deadline) causes the manager to cancel the remaining exit order.

### Config keys (`id: 'strategy_3a'`)

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `false` | Must be `true`; mutually exclusive with `strategy_3b` |
| `negativeFundingThresholdPercent` | number | `-0.5` | Same signal filter as strategy_1 |
| `entryOffsetSeconds` | number | `10` | Same as strategy_1 |
| `stopLossPercent` | number | `1` | SL distance from entry in % (exits short if price rises by this %) |
| `takeProfitPercent` | number | `1` | **Not used at runtime** — exists for spec compatibility only |
| `tpVariantAMultiplier` | number | `1.5` | TP distance = \|fundingRatePercent\| × this multiplier |
| `tpVariantBOffsetPercent` | number | `0.4` | Used by strategy_3b only; ignored here |
| `deadlineSeconds` | number | `300` | Max hold from `nextFundingTimestamp` before forced market close |
| `amountUsd` | number | `20` | Target notional in USD |
| `leverage` | number | `4` | Position leverage |

---

## Strategy 3b — Negative funding SHORT, TP = |F| + offset

Identical to strategy_3a in every respect except the take-profit distance formula:

```
tpPct = |fundingRatePercent| + tpVariantBOffsetPercent   (default offset: 0.4%)
TP price = P_entry × (1 − tpPct / 100)
```

`tpVariantBOffsetPercent` is a fixed additive offset rather than a multiplier. For a −1.0% funding rate: strategy_3a gives TP = 1.5%, strategy_3b gives TP = 1.4%. For a −0.5% rate: 3a = 0.75%, 3b = 0.9%.

**Mutually exclusive with strategy_3a**: config parsing raises a `ConfigError` if both have `enabled: true`. The `tpVariant` field stored in Postgres (`'A'` or `'B'`) is an audit label only; the execution manager uses the computed `tpPct` directly and never reads `tpVariant`.

### Config keys (`id: 'strategy_3b'`)

Identical to strategy_3a except `id: 'strategy_3b'`. The `tpVariantAMultiplier` key is present in config but ignored; only `tpVariantBOffsetPercent` is used.

---

## Shared sizing rule

All three strategies compute order quantity via `computeOrderQty` in [`src/execution/strategies/shared/sizing.ts`](../strategies/shared/sizing.ts):

```
contractSize = market.contractSize  (> 0; default 1 for standard linear perps)
rawQty = amountUsd / price / contractSize

step derived from market.amountPrecision:
  • amountPrecision >= 1  →  step = 10^(-round(amountPrecision))   e.g. 3 → 0.001
  • 0 < amountPrecision < 1  →  step = amountPrecision             (tick size directly)
  • amountPrecision <= 0  →  step = 1

qty = floor(rawQty / step) × step
```

Returns `null` (intent rejected at preflight) if any of:
- `qty ≤ 0`
- `qty < market.minAmount` (when defined by exchange)
- `qty × price < market.minCost` (when defined by exchange)

`price` is the latest mark price fetched from the exchange REST adapter at evaluation time. `contractSize` matters for contract-based exchanges (e.g., KuCoin Futures: `contractSize = 0.001 BTC/contract`).

---

## Risk controls

All checks run in [`src/execution/execution/preflight.ts`](../execution/preflight.ts) before any REST call. On rejection the manager logs the error code and drops the intent; no retry is attempted for the same `(strategy, exchange, symbol, nextFundingTimestamp)` tuple.

| Order | Check | Error code | Condition |
|---|---|---|---|
| 1 | Kill switch not halted | `kill_switch` | `canPlaceOrder()` returns `false` in `halted` mode |
| 2 | Market metadata exists | `no_market` | `markets.get(exchange, symbol)` returned `undefined` |
| 3 | Leverage ≤ market max | `leverage_exceeded` | Checked only when `market.maxLeverage` is defined |
| 4 | Quantity computable | `invalid_qty` | `computeOrderQty()` returned `null` |
| 5 | Min notional met | `min_notional` | `qty × refPrice < market.minCost` |
| 6 | Sufficient margin | `insufficient_balance` | `stateStore USDT available < amountUsd / leverage` |
| 7 | Global concurrent cap | `cap_exceeded` | In-flight intent count ≥ `risk.globalMaxConcurrentIntents` (default 10) |
| 8 | Global notional cap | `cap_exceeded` | In-flight notional + `amountUsd` > `risk.globalMaxNotionalUsd` (default $1,000) |
| 9 | Per-strategy concurrent cap | `cap_exceeded` | Strategy intent count ≥ `risk.perStrategy[id].maxConcurrentIntents` (default 1) |
| 10 | Per-strategy notional cap | `cap_exceeded` | Strategy notional + `amountUsd` > `risk.perStrategy[id].maxNotionalUsd` (default $100) |

**Live safety ceiling**: config validation (`parseEngineConfig`) raises a `ConfigError` if `mode: live` and `risk.globalMaxNotionalUsd > $100,000` without `risk.acknowledgeUncapped: true`.

### Kill switch

[`src/execution/risk/killSwitch.ts`](../risk/killSwitch.ts) has three states:

| State | `canPlaceOrder()` | How to enter |
|---|---|---|
| `live` | `true` | Config `mode: live` at startup, or `setMode('live')` |
| `dry_run` | `true` | Config `mode: dry_run` at startup, or `setMode('dry_run')` |
| `halted` | `false` | `trip(reason)` — manual call or automatic on fatal alert |

`trip(reason)` immediately invokes `flattenAll()` (wired to `ExecutionManager` at startup): cancels all open orders, then submits market reduce-only close orders for every open position across all configured exchanges. There is no automatic recovery from `halted`; re-entering `live` or `dry_run` requires a manual `setMode()` call (or restarting the engine with the intended config).

---

## Order types

| Order | Strategy | Type | Side | Notes |
|---|---|---|---|---|
| Entry | All | Market | Buy (strategy_1) / Sell (strategy_3a, 3b) | Submitted at `entryAt` |
| Timed exit | strategy_1 | Market, reduce-only | Sell | Submitted when `exitAt` timer fires |
| Take profit | strategy_3a, strategy_3b | Limit, reduce-only | Buy | Placed immediately after entry fill; price = `P_entry × (1 − tpPct/100)` |
| Stop loss | strategy_3a, strategy_3b | Stop-market, reduce-only | Buy | Placed immediately after entry fill; price = `P_entry × (1 + slPct/100)` |
| Deadline close | strategy_3a, strategy_3b | Market, reduce-only | Buy | Submitted if deadline reached before SL/TP fill |

---

## Related docs

- **Runtime mechanics** (how intents flow through the engine): [architecture.md](./architecture.md)
- **Canonical business specs** (profit thesis, entry/exit math, backtesting variables): [`docs-strategy/funding_rate_strategies.md`](../../../docs-strategy/funding_rate_strategies.md)
