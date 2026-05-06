# Strategy: Delta-Neutral Spot-Futures Funding Capture

## Thesis

When a perpetual's funding rate is significantly positive, longs pay shorts
at each funding settlement (every 1h, 2h, 4h, or 8h depending on market
conditions). By simultaneously holding LONG spot + SHORT perp on the same
symbol, the position is price-delta-neutral and collects the funding payment
each cycle. The trade is held across one or more funding
events and exits when the funding rate falls below a convergence threshold,
when the spread moves favourably (TP), when the spread widens adversely (SL),
or at a safety deadline.

> **Note:** Spot OHLC data is not yet ingested in ClickHouse. Until it is,
> `fetchSpotOrderbookWindow` is aliased to `fetchOrderbookWindow` (perp data).
> In alias mode the spread is always 0, so `spread_pnl ≈ 0` for all trades.
> Only funding_pnl drives returns. When real spot data arrives, only
> `src/backtesting/data/spot-data.ts` needs to change.

---

## Entry Logic

| Step           | Description                                                                              |
| -------------- | ---------------------------------------------------------------------------------------- |
| Trigger        | `funding_rate >= F_threshold` on the perp exchange                                       |
| Profit gate    | `(funding_rate + entry_spread − round_trip_fees) >= minTotalProfit`; rejected if not met |
| T_entry        | `T_funding − entry_offset_seconds`                                                       |
| Spot leg       | BUY MARKET at `ask_open` of spot candle at T_entry                                       |
| Perp leg       | SELL MARKET at `bid_open` of perp candle at T_entry                                      |
| `entry_spread` | `(perp_entry − spot_entry) / spot_entry` ≈ 0 in alias mode                               |

---

## Carry Loop

After entry, the position is held second-by-second through a wide window
sized to cover `max_carry_funding_events` cycles. Funding settlement intervals
vary (1h, 2h, 4h, or 8h); the window uses up to 9h per cycle as a conservative
upper bound. Funding events are pre-fetched and accrued as the cursor crosses
each event's timestamp.

The first exit window opens at:

```
T_exit_first = next_funding_time − exit_offset_seconds
```

Before `T_exit_first`, no exits are checked (gate ensures at least one
funding payment is collected before exiting).

---

## Exit Conditions (checked at every second ≥ T_exit_first)

| Reason          | Condition                                                                   |
| --------------- | --------------------------------------------------------------------------- |
| `FUNDING_FLOOR` | `current_funding_rate <= fundingConvergenceThreshold`                       |
| `SPREAD_TP`     | `(entry_spread − current_spread) >= spreadTakeProfit`                       |
| `SPREAD_SL`     | `(current_spread − entry_spread) >= spreadWideningThreshold`                |
| `DEADLINE`      | `funding_events_collected >= max_carry_funding_events`, or window exhausted |

`current_funding_rate` is the most recently collected funding event's rate.

---

## P&L Formula

```
entry_spread = (perp_entry − spot_entry) / spot_entry
exit_spread  = (perp_exit  − spot_exit)  / spot_entry

spread_pnl   = entry_spread − exit_spread
funding_pnl  = Σ funding_rate over all collected events  (positive = received)
fees         = 2 × spot_fee + 2 × perp_taker_fee
net_pnl      = spread_pnl + funding_pnl − fees
```

`delta_pnl = 0` (the two legs are delta-neutral by construction).

---

## Fee Model

| Order           | Exchange      | Fee type | Count |
| --------------- | ------------- | -------- | ----- |
| Entry spot BUY  | spot_exchange | taker    | 1     |
| Entry perp SELL | perp_exchange | taker    | 1     |
| Exit spot SELL  | spot_exchange | taker    | 1     |
| Exit perp BUY   | perp_exchange | taker    | 1     |

Total: `2 × spot_fee + 2 × perp_taker` (4 market orders per round trip).

---

## Parameters

| Parameter                     | Default | Bounds           | Notes                                                |
| ----------------------------- | ------- | ---------------- | ---------------------------------------------------- |
| `F_threshold`                 | 0.0015  | 0.0002–0.004     | Min positive funding rate to trigger                 |
| `entry_offset_seconds`        | 5       | 1–5, int         | Seconds before T_funding to enter                    |
| `exit_offset_seconds`         | 5       | 1–5, int         | Seconds before next funding to open exit window      |
| `minTotalProfit`              | 0.0005  | -0.005–0.005     | Min expected net profit at entry (negative = looser) |
| `fundingConvergenceThreshold` | 0.0002  | 0–F_threshold    | Exit when funding falls to/below this                |
| `spreadWideningThreshold`     | 0.03    | 0.005–0.03       | SL: spread widening fraction                         |
| `spreadTakeProfit`            | 0.005   | 0.005–0.02       | TP: spread narrowing fraction                        |
| `max_carry_funding_events`    | 8       | 1–336, int       | Safety bound on carry cycles (336 ≈ 14d at 1h)      |

**Coupling constraint:** `fundingConvergenceThreshold < F_threshold` (enforced by loader).
