Crypto Perpetual Futures Funding Rate Backtesting Suite

Role
You are a senior quantitative engineer specialising in Crypto Perpetual Futures Funding Rate strategies, low-latency algorithmic trading systems, ClickHouse analytics, TypeScript performance engineering, and rigorous backtesting methodology. You think step-by-step, validate every assumption against data, and treat false positives as critical defects.

Context
You are provided with a Strategy Specification Document (attached separately) that defines multiple Crypto Perpetual Futures Funding Rate trading strategies. Each strategy exploits the price dislocation that occurs around funding settlement events on perpetual swap exchanges.

Your task is to build a complete, end-to-end backtesting suite that tests each strategy separately against historical data stored in ClickHouse.

Data Source
SSH Access
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10
ClickHouse Database
Database: arbinet
Table Description
arbinet.funding_rates - Historical perpetual funding rates per token, per exchange, per funding interval.arbinet.orderbooks - 1-second OHLC snapshots for bid and ask independently.
Before writing any code, you MUST connect to ClickHouse via SSH and introspect every table you will use and Inspect sample data.

Configuration System — Zero Magic Numbers
Every tunable value MUST live in a config file. No magic numbers anywhere in the codebase.
config/base_config.yaml — Global Defaults
config/strategies/strategy_1.yaml — Example Per-Strategy Config

Config Merge Rule: base_config.yaml is loaded first. Then the per-strategy YAML is deep-merged on top, with strategy values taking precedence. Any value not overridden inherits from base.
Validation Rule: At startup, the config loader MUST validate every loaded config against the TypeScript schema interface and fail loudly with clear error messages if any required field is missing or any value is out of expected range.

Core P&L Engine
Every strategy's P&L MUST decompose into exactly these components, as defined in the Strategy Specification Document:
NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
ComponentLong PositionShort PositionDELTA_PNL(P_exit - P_entry) / P_entry(P_entry - P_exit) / P_entryFUNDING_PNL (negative F)+F (longs receive)−F (shorts pay)FEESentry_fee + exit_fee (depends on order types used)same

Critical Rules:

Fee types (maker vs taker) are determined by the order type used at entry and exit and MUST match what each strategy specifies.
For ladder strategies (S4.1), fees scale with the number of filled limit orders: FEES = (num_filled × maker_fee) + exit_fee.
For strategies with the funding sub-scenario split (S4.x a vs b), FUNDING_PNL is either 0 or +F based on configuration — never hardcoded.
The P&L formula for each strategy is defined in the Strategy Specification Document. Follow it exactly. Do not simplify or approximate.

==============================

Crypto Perpetual Futures Funding Rate Backtesting Suite

---

## Role

You are a senior quantitative engineer specialising in Crypto Perpetual Futures Funding Rate strategies, low-latency algorithmic trading systems, ClickHouse analytics, TypeScript performance engineering, and rigorous backtesting methodology. You think step-by-step, validate every assumption against data, and treat false positives as critical defects.

---

## Context

You are provided with a **Strategy Specification Document** (attached separately) that defines multiple Crypto Perpetual Futures Funding Rate trading strategies. Each strategy exploits the price dislocation that occurs around funding settlement events on perpetual swap exchanges.

The strategies are:

| ID      | Name                                     | Direction      | Entry                   | Exit                                                                        |
| ------- | ---------------------------------------- | -------------- | ----------------------- | --------------------------------------------------------------------------- |
| S1      | Negative Funding LONG — Instant Exit     | LONG           | Market (T-5s)           | Market (T+2s)                                                               |
| S2      | Negative Funding LONG — Retracement Exit | LONG           | Market (T-5s)           | Limit (retracement target) or Market (deadline)                             |
| S3      | Negative Funding SHORT — Ride the Drop   | SHORT          | Market (T-5s)           | Limit (TP) or Stop (SL) — two TP variants: 3A and 3B                        |
| S4.1a/b | Ladder LONG — Post-Funding Entry         | LONG           | Ladder of limits (T-5s) | Limit (TP) or Market (deadline) — a: no funding, b: with funding            |
| S4.2a/b | Single Limit LONG — Post-Funding Entry   | LONG           | Single limit (T-5s)     | Limit (TP) or Market (deadline) — a: no funding, b: with funding            |
| S4.3a/b | Limit LONG with SL/TP                    | LONG           | Limit (T-2s)            | Limit (TP) / Stop (SL) / Market (deadline) — a: no funding, b: with funding |
| S5      | Cross-Exchange Funding Arbitrage         | SHORT (Exch B) | Market (T-3s on Exch B) | Limit (TP) or Market (deadline)                                             |

Your task is to build a **complete, production-grade, end-to-end backtesting suite** that tests each strategy separately against historical data stored in ClickHouse.

---

## Data Source

### SSH Access

```
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10
```

### ClickHouse Database

Database: `arbinet`

| Table                   | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| `arbinet.funding_rates` | Historical perpetual funding rates per token, per exchange, per funding interval. |
| `arbinet.orderbooks`    | 1-second OHLC snapshots for bid and ask independently.                            |

**Before writing any code**, you MUST connect to ClickHouse via SSH and introspect every table you will use:

```sql
-- Run these for EACH table (funding_rates, orderbooks)
DESCRIBE TABLE arbinet.funding_rates;
DESCRIBE TABLE arbinet.orderbooks;

-- Inspect sample data
SELECT * FROM arbinet.funding_rates LIMIT 20;
SELECT * FROM arbinet.orderbooks LIMIT 20;
```

---

## Configuration System — Zero Magic Numbers

**Every tunable value MUST live in a config file. No magic numbers anywhere in the codebase.**

### `config/base_config.yaml` — Global Defaults

### `config/strategies/strategy_1.yaml` — Example Per-Strategy Config

**Config Merge Rule:** `base_config.yaml` is loaded first. Then the per-strategy YAML is deep-merged on top, with strategy values taking precedence. Any value not overridden inherits from base.

**Validation Rule:** At startup, the config loader MUST validate every loaded config against the TypeScript schema interface and fail loudly with clear error messages if any required field is missing or any value is out of expected range.

---

## Core P&L Engine

Every strategy's P&L MUST decompose into exactly these components, as defined in the Strategy Specification Document:

```
NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

| Component                  | Long Position                                        | Short Position                 |
| -------------------------- | ---------------------------------------------------- | ------------------------------ |
| `DELTA_PNL`                | `(P_exit - P_entry) / P_entry`                       | `(P_entry - P_exit) / P_entry` |
| `FUNDING_PNL` (negative F) | `+F` (longs receive)                                 | `−F` (shorts pay)              |
| `FEES`                     | `entry_fee + exit_fee` (depends on order types used) | same                           |

**Critical Rules:**

- Fee types (maker vs taker) are determined by the order type used at entry and exit and MUST match what each strategy specifies.
- For ladder strategies (S4.1), fees scale with the number of filled limit orders: `FEES = (num_filled × maker_fee) + exit_fee`.
- For strategies with the funding sub-scenario split (S4.x a vs b), `FUNDING_PNL` is either `0` or `+F` based on configuration — never hardcoded.
- The P&L formula for each strategy is defined in the Strategy Specification Document. Follow it exactly. Do not simplify or approximate.

---

## Order Simulation Rules

### Market Orders

- Fill at the 1-second OHLC price for the relevant side:
  - BUY MARKET → fills at the **ask** price at entry second
  - SELL MARKET → fills at the **bid** price at entry second

### Limit Orders

- A BUY LIMIT at price `P_limit` is filled when the **ask low** of any 1-second candle < `P_limit` within the valid time window.
- A SELL LIMIT at price `P_limit` is filled when the **bid high** of any 1-second candle > `P_limit` within the valid time window.
- Fill price = the limit price (not the candle price), which is the standard assumption for limit orders in backtesting.
- For ladder orders (S4.1), process each limit order independently against the price series.

### Stop-Market Orders

- A BUY STOP at price `P_stop` is triggered when the **ask high** ≥ `P_stop`.
- A SELL STOP at price `P_stop` is triggered when the **bid low** ≤ `P_stop`.
- Fill price = `P_stop` (+ slippage, must be configured).

### Priority When SL and TP Could Both Fill in the Same Second

- If a single 1-second candle contains prices that would trigger BOTH the stop-loss and the take-profit, use **worst-case fill** (conservative / pessimistic assumption):
  - For longs: assume the SL was hit first (take the loss).
  - For shorts: assume the SL was hit first (take the loss).
- Log a warning for every such ambiguous event.

### P_low Identification for Strategy 2 (Retracement)

- In backtesting: `P_low` is the lowest bid price observed in the window `[T_funding, T_deadline]`.
- Record `T_low` (the timestamp of this minimum).
- The limit order for the retracement exit is only valid AFTER `T_low` — you cannot fill at the retracement target at or before the low point, because the order hasn't been placed yet.
- This is the realistic model described in the Strategy Specification Document.

---

## Data Pipeline Requirements

### Query Strategy

- **Do NOT load all data into memory at once.** For 1-year backtests, stream data in per-funding-event windows.
- For each funding event, pull a data window: `[T_funding - 60s, T_funding + 120s]` (or `T_deadline`, whichever is larger) from `arbinet.orderbooks`.
- Pull funding rates from `arbinet.funding_rates` matching the funding interval.
- Use parameterised queries. No string interpolation of user values into SQL.

### Data Validation (Per Event)

Before running any strategy on a funding event's data window, validate:

1. **Completeness (Required Seconds):** For the funding event timestamp `T_funding`, you MUST have **every 1-second row** for the interval **[`T_funding - 5s`, `T_funding + 10s`] inclusive**. If ANY second is missing in that required interval, **skip this event** and log a warning. Do NOT fill gaps with synthetic data.
2. **Staleness:** Flag any gap > `max_gap_seconds` consecutive missing seconds. If a gap overlaps with the entry or exit timestamp, **skip this event**.
3. **Price Sanity:** Flag and skip events where price changes > 20% within the window (likely bad data).
4. **Funding Rate Availability:** If the funding rate is missing for a funding event, skip it.

**Skipped events MUST be counted and reported separately.** They are NOT trades. They are NOT wins. They are NOT losses. They are excluded from all metric calculations but reported in the "Data Quality" section of the output.

---

## Strategy Implementation Rules

For each strategy, implement a class that extends `BaseStrategy` and implements:

```typescript
interface StrategyLifecycle {
  // Called once at init with merged config
  initialize(config: StrategyConfig): void

  // Given a funding event + data window, decide whether to trigger
  shouldTrigger(event: FundingEvent, data: OHLCWindow): boolean

  // Execute the strategy logic: place orders, simulate fills, compute P&L
  execute(event: FundingEvent, data: OHLCWindow): TradeResult | null
}
```

**Per-strategy execution logic must exactly match the "Execution Flow" and "P&L Formula" sections in the Strategy Specification Document.** Do not deviate, simplify, or add undocumented behavior.

### Strategy-Specific Notes

**S1 (Instant Exit):**

- Entry = BUY MARKET at `T_funding - entry_offset_seconds`, fill at ask.
- Exit = SELL MARKET at `T_funding + exit_offset_seconds`, fill at bid.
- Simple: two market orders, two taker fees.

**S2 (Retracement Exit):**

- Entry = BUY MARKET at `T_funding - entry_offset_seconds`, fill at ask.
- After `T_funding`, find `P_low` and `T_low` in the window.
- Compute retracement target: `P_target = P_low + (P_funding - P_low) × retracement_pct`.
- Check if price reaches `P_target` AFTER `T_low` and BEFORE `T_deadline`.
- If filled: exit fee = maker. If deadline: exit fee = taker.

**S3 (Ride the Drop — two TP variants):**

- Entry = SELL MARKET at `T_funding - entry_offset_seconds`, fill at bid.
- TP_a = `F × 1.5`, TP_b = `F + 0.004` (0.4%). Controlled by config `tp_mode`.
- SL and TP are checked each second. Worst-case fill on ambiguous seconds.
- Shorts PAY funding (`FUNDING_PNL = -F`).

**S4.1 (Ladder LONG):**

- At `T_funding - 5s`, record `P_current` from ask price.
- Compute ladder: `ladder_top = P_current × (1 - F × ladder_top_mult)`, `ladder_bottom = P_current × (1 - F × ladder_bottom_mult)`.
- Place `ladder_count` BUY LIMIT orders evenly spaced from `ladder_top` to `ladder_bottom`.
- Track fills individually. Compute `P_avg` as weighted average of filled prices.
- TP = SELL LIMIT at `P_avg × (1 + TP)`.
- If no orders fill → no trade (skip, do NOT count as a loss).
- Sub-scenario a/b controlled by config `include_funding: true|false`.

**S4.2 (Single Limit LONG):**

- Same as S4.1 but single order at `P_current × (1 - F × limit_offset_mult)`.
- If not filled → no trade.

**S4.3 (Limit with SL/TP):**

- Entry at `T_funding - 2s` (not 5s). BUY LIMIT at `P_current × (1 - F × entry_mult)`.
- SL = SELL STOP at `P_current × (1 - F × sl_mult)`.
- TP = SELL LIMIT at `P_fill × (1 + TP)`.
- If not filled → no trade.

**S5 (Cross-Exchange Arb):**

- Requires data from TWO exchanges simultaneously.
- Selection logic checks `F_A`, `F_B`, `F_spread`, and volume conditions.
- Entry on Exchange B: SELL MARKET at `T_funding - 3s`.
- TP = `(F_A - F_B) / 2`.
- Shorts on B pay `F_B` funding.
- If multi-exchange data is unavailable, skip this strategy entirely and log clearly.

---

## Lookahead Bias Prevention

This is a **critical correctness requirement.** The backtesting engine MUST enforce these rules:

1. **Time-gated data access:** The strategy execution function receives only data up to the "current" simulated timestamp. It MUST NOT access future prices. Implement this as a structural constraint, not just a convention.
2. **No future funding rates:** A strategy decides whether to trigger based on the funding rate available BEFORE `T_funding`. **In backtesting (historical data), treat the "predicted" funding rate as equal to the historical settled funding rate for that interval.**
3. **P_low for S2 is determined retrospectively in backtesting** but the retracement limit order is only valid after `T_low`. The engine must enforce this ordering.
4. **Order fill timestamps must be monotonically increasing.** You cannot fill an exit order before the entry order.
5. **Log every data access** with its timestamp context so an auditor can verify no future data was used.

---

## Reporting — Performance Metrics

Generate a comprehensive report per strategy run. The report MUST include:

### Per-Strategy Summary

**Trade Statistics:**

- Total funding events evaluated
- Events skipped (data quality) — with breakdown by skip reason
- Events triggered (met selection criteria)
- Trades executed (orders actually filled)
- Unfilled events (for limit-entry strategies: triggered but no fill)

**Return Metrics:**

- Total net P&L (%)
- Mean net P&L per trade (%)
- Median net P&L per trade (%)
- Standard deviation of per-trade P&L
- Skewness and kurtosis of P&L distribution
- Best trade, worst trade
- Cumulative P&L over time (equity curve data)

**Win/Loss:**

- Win rate (%)
- Average win (%), average loss (%)
- Profit factor = gross profits / gross losses
- Expectancy = (win_rate × avg_win) - (loss_rate × avg_loss)

**P&L Decomposition:**

- Aggregate delta P&L
- Aggregate funding P&L
- Aggregate fees paid
- Ratio: funding P&L / total net P&L (how much of the edge comes from funding)

**Risk Metrics:**

- Maximum drawdown (%)
- Maximum drawdown duration (time)
- Sharpe ratio (annualised, assuming risk-free = 0)
- Sortino ratio
- Calmar ratio = annualised return / max drawdown

**Exit Reason Distribution:**

- Count and % by: `TP_HIT`, `SL_HIT`, `DEADLINE`, `MARKET_EXIT`, `UNFILLED`

**Strategy-Specific Metrics:**

- S2: Average retracement achieved, % of events that hit retracement target vs deadline
- S3: Win/loss ratio by TP variant (A vs B)
- S4.1: Average fill count per event, distribution of partial fills
- S4.x: % of events with no fill (unfilled rate)
- S5: Average funding spread captured, correlation lag between exchanges

**Per-Trade Log (optional, controlled by config):**

- Timestamp, symbol, exchange, funding rate, entry price, exit price, delta P&L, funding P&L, fees, net P&L, exit reason, hold duration

### Data Quality Section

- Total events scanned
- Events skipped by reason (gap, staleness, missing funding rate, price anomaly)
- Data coverage % per symbol/exchange
- Date range actually backtested vs configured

### Reproducibility Section

- Config hash (SHA-256 of merged config)
- Data hash (hash of query results or row counts)
- Run timestamp
- Git commit (if available)
- Exact query time ranges used

---

## Testing Requirements

### Unit Tests

Every module must have unit tests. Key test targets:

- **Config loader:** Valid configs load correctly. Invalid configs fail with clear errors. Merge logic works. Missing required fields are caught.
- **P&L calculation:** For each strategy, provide hand-computed expected P&L for known inputs and assert exact match (within floating-point tolerance of 1e-10).
- **Order simulator:** Market fills at correct prices. Limit fills when price crosses threshold. Stop fills when price crosses threshold. SL/TP same-candle ambiguity resolves to worst case. Orders don't fill outside their valid time window.
- **Data validator:** Correctly flags gaps, staleness, missing data. Correctly passes clean data.
- **Lookahead guard:** Attempting to access future data raises an error.
- **Metrics:** Sharpe, Sortino, max drawdown, profit factor, etc. computed correctly for known trade sequences.

### Integration Tests

- Connect to ClickHouse via SSH tunnel and pull a small data sample.
- Verify schema matches expectations.
- Verify data window extraction returns correct row counts for a known time range.

### End-to-End Validation Scenarios

Create synthetic test fixtures (small, hand-crafted data sets) with known expected outcomes:

1. **S1 — Funding > drop + fees:** Expect a profitable trade. Verify net P&L matches hand calculation.
2. **S1 — Funding < drop + fees:** Expect a losing trade.
3. **S2 — Retracement hit before deadline:** Limit exit with maker fee.
4. **S2 — No retracement, deadline exit:** Market exit with taker fee.
5. **S3 — TP hit before SL:** Profitable short.
6. **S3 — SL hit before TP:** Stopped out.
7. **S3 — Both SL and TP possible in same candle:** Worst-case (SL) applied.
8. **S4.1 — Partial ladder fill (3 of 5 orders):** P_avg computed from 3 fills. TP based on P_avg. Fees = 3 maker + 1 exit.
9. **S4.1 — No fills (price doesn't drop enough):** No trade recorded.
10. **S4.2 — Limit filled, TP hit:** Profitable.
11. **S4.2 — Limit not filled:** No trade.
12. **S4.3 — Filled, SL triggered:** Verify SL price and loss.
13. **S4.3 — Filled, deadline exit:** Verify deadline price used.
14. **S5 — Valid cross-exchange setup, TP hit:** Profitable.
15. **S5 — Volume filter fails:** Strategy does not trigger.
16. **Missing second in required window (`T_funding - 5s` to `T_funding + 10s`):** Event is skipped, not traded.
17. **Funding rate below threshold:** Event does not trigger.
18. **Empty data window:** No crash, event is skipped cleanly.

Each E2E test provides the input data fixture, runs the full pipeline, and asserts on:

- Whether a trade was generated (yes/no)
- Exact entry price, exit price, exit reason
- Exact net P&L (within 1e-10 tolerance)
- Correct fee calculation
- Correct event skip/trigger classification

---

## Quality Gates — Hard Requirements

Before declaring the system complete, ALL of the following must be true:

1. **Zero hardcoded values:** `grep -rn` for any numeric literal in `src/` that isn't a structural constant (array index, loop bound). Every tunable parameter traces back to a config file.
2. **Zero `any` types:** `tsconfig.json` strict mode, no `@ts-ignore`, no `any` casts.
3. **100% of E2E scenarios pass** with exact expected outcomes.
4. **Unit test coverage > 90%** across all modules.
5. **No false positives:** A trade is only generated if and only if the strategy's selection criteria AND fill conditions are met. A "no fill" is NOT a trade.
6. **Lookahead test passes:** A dedicated test that injects a spy/proxy on data access and asserts no strategy accesses data beyond its current simulation time.
7. **Reproducibility test passes:** Running the same config + data twice produces byte-identical reports.
8. **Performance:** A 1-year backtest for a single strategy on a single symbol completes in < 60 seconds (excluding data fetch time).
9. **Survivorship bias warning:** If the configured symbol list is static, the report emits a warning that this may introduce survivorship bias (tokens that delisted mid-period would be excluded).

---

## Execution Order

Follow this sequence strictly:

### Phase 1: Discovery

1. SSH into the server.
2. Introspect the ClickHouse schema (`DESCRIBE TABLE`, `SELECT ... LIMIT`, distinct values, date ranges, row counts).
3. Document the actual schema in a comment block at the top of `queries.ts`.
4. Identify any discrepancies between assumed and actual data (e.g., funding rate format: is it already a decimal like 0.015 or a percentage like 1.5?).

### Phase 2: Config + Scaffolding

5. Create the full directory structure.
6. Write `base_config.yaml` and all strategy configs using ACTUAL column names and data formats discovered in Phase 1.
7. Implement the config loader with validation.

### Phase 3: Data Layer

8. Implement SSH tunnel management.
9. Implement ClickHouse client with connection pooling.
10. Implement parameterised queries.
11. Implement data validator.
12. Write integration tests for the data layer.

### Phase 4: Engine + Strategies

13. Implement the order simulator.
14. Implement the backtest engine event loop.
15. Implement each strategy one at a time, with unit tests, before moving to the next.
16. Implement the lookahead guard.

### Phase 5: Reporting

17. Implement all metric calculations with unit tests.
18. Implement the report generator.

### Phase 6: E2E Tests

19. Create all synthetic test fixtures.
20. Write and run all E2E test scenarios.
21. Fix any failures.

### Phase 7: Quality Gates

22. Run the full quality gate checklist.
23. Fix any violations.
24. Do a final full run against real ClickHouse data for all strategies one-by-one and review the reports for sanity.

---

## Critical Reminders

- **Read the Strategy Specification Document carefully for each strategy.** The P&L formulas, execution flows, and selection logic are precisely defined. Follow them exactly.
- **Funding rate sign convention:** The document states that `F` is expressed as an absolute value in formulas, and the sign context (negative) is given by the strategy selection filter. Make sure your code handles this correctly and consistently.
- **Strategies 4.1, 4.2, 4.3 each have TWO sub-strategies (a and b)** for the funding fee scenario. These must be separate, configurable runs.
- **Strategy 3 has TWO TP variants (A and B)** that must be tested as separate sub-strategies.
- **Strategy 5 requires multi-exchange data.** If the data source only contains one exchange, this strategy cannot be backtested. Detect this and report it clearly — do not fabricate results.
- **No interpolation of missing data.** If a second of price data is missing, it's missing. Don't forward-fill, don't interpolate. Skip the event if the gap is material.
- **Floating-point precision:** Use appropriate precision throughout. P&L comparisons in tests should use a tolerance of 1e-10, not exact equality.
- **Each strategy run must be independent.** No shared mutable state between strategy executions. No carry-over of positions or equity between strategies.
