# Implement New Backtesting Strategy: `spot-futures` (Delta-Neutral Funding Capture)

## Scope

Implement a new trading strategy called **`spot-futures`** end-to-end **for backtesting only**. Do **not** implement the execution engine (no changes under `src/execution/`) for this strategy yet. All other relevant areas (docs, configs, backtesting engine, autoresearch matrix/program, etc) must be updated.

## Thesis

Profit from **positive funding rates** on perpetual futures (and potentially from spread convergence between perp and spot) by entering a **delta-neutral hedged** position on the same symbol:

- **LONG** spot
- **SHORT** perpetual future

Funding fees on the SHORT perp accrue as profit while funding remains positive. The spread (price difference) between perp and spot can be positive, negative, or neutral — and can move either in our favor or against us during the trade.

Spot and perpetual legs **may be on the same exchange or on different exchanges**. The strategy must support both.

## Important: Spot Data Is Not Yet Available

Our ClickHouse database currently stores **only perpetual futures market data**. Spot data will be added later.

- Architect the strategy so that spot data is a first-class input that **will be** integrated later without rewrites.
- For the current backtesting implementation, **use perpetual prices as a proxy for spot prices**, i.e. `spot_price = perp_price`, which makes `spread_delta = 0` at all times.
- All configs, types, data-access layers, and analytics must already model spot as a distinct input — only the data source is temporarily aliased to perp. Adding real spot data later should be a data-source swap, not a refactor.

## Parameters (configurable)

| Parameter | Default | Meaning |
|---|---|---|
| `F_threshold` | `0.15%` | Minimum positive predicted funding rate required to enter a trade. |
| `T_entry` | `T_funding − 5s` | Entry timing offset: 5 seconds before the funding event. |
| `T_exit` | `T_next_funding − 5s` | Earliest exit timing offset: 5 seconds before the *next* funding event. |
| `minTotalProfit` | `0.05%` | Minimum required *expected* round-trip net profit to enter the trade, computed as `predicted_funding_rate + entry_spread − round_trip_fees`. |
| `fundingConvergenceThreshold` | `0.02%` | Funding floor at which capital is no longer worth locking up; trigger exit. |
| `spreadWideningThreshold` | `5%` | Stop-loss on the delta-neutral pair: exit if `current_spread − entry_spread` exceeds this. |
| `spreadTakeProfit` | `0.4%` | Take-profit on spread movement: exit any time spread P&L exceeds this, without waiting for funding convergence. |

### Timing constraints

- `T_entry != T_exit`
- `T_entry < T_exit`
- We **must** hold across at least one funding event. Entering and exiting around the same funding event defeats the strategy (no funding collected, only fees paid).

## Trading Fees

- **Perpetual futures fees**: already configured somewhere in the existing config tree — locate and reuse them. Do not redefine.
- **Spot fees**: must be **configurable per exchange**, default `0.1%` per transaction. A round-trip is **2 transactions** (open + close).

## Entry Logic

Trigger entry **iff** all of the following hold:

```
current_time == T_entry
AND predicted_funding_rate >= F_threshold
AND (predicted_funding_rate + entry_spread − round_trip_fees) >= minTotalProfit
```

## Exit Logic

Exit when **any** of the following becomes true (whichever fires first), but **never before** `T_exit` has been reached for the first time (i.e., we must collect at least one funding payment):

1. `current_funding_rate <= fundingConvergenceThreshold`
2. `spread_pnl >= spreadTakeProfit` — *this one may fire at any time after entry, including before the first funding event if the system is later configured to allow it; for now, gate it behind `T_exit` as well unless we explicitly decide otherwise — flag this as a config decision.*
3. `(current_spread − entry_spread) >= spreadWideningThreshold` — stop-loss

If none fire and funding remains `> fundingConvergenceThreshold`, **carry the position across multiple funding events** and keep collecting funding until an exit condition triggers.

## Files to Create or Update

Update or create all relevant files. Non-exhaustive list — touch anything else needed for a coherent implementation:

- `docs-strategy/**` — strategy documentation (thesis, parameters, entry/exit logic, fee model, spot-data caveat, examples).
- `config/**` — new strategy config file(s) with all parameters above; per-exchange spot fees; reuse existing perp fees.
- `autoresearch/matrix.yaml` — parameter sweep grid for the new strategy.
- `autoresearch/program.md` — describe the new strategy in the autoresearch program.
- `src/backtesting/**` — strategy implementation, signal generation, position lifecycle (entry/hold-through-funding/exit), fee accounting, P&L attribution (split: funding P&L vs. spread P&L vs. fees).
- `src/autoresearch/**` — wire the new strategy into the autoresearch runner.
- Any types, interfaces, data-access modules, tests, fixtures, and analytics needed.

## Architectural Requirements

1. **Spot as a first-class data input** even though it currently aliases to perp. Adding a real spot data source later must be a one-line swap.
2. **Per-leg, per-exchange** modeling. The strategy must natively support spot leg and perp leg on different exchanges.
3. **P&L attribution**: each closed trade must report funding P&L, spread P&L, and fees separately, in addition to net P&L.
4. **Carry across funding events** must be implemented as the default behavior, not a special case.
5. **No execution-engine changes.** Backtesting + autoresearch only.

## Out of Scope (do not do in this task)

- Live execution engine integration.
- Real spot data ingestion (architect for it; do not implement it).
- Changes to other strategies.