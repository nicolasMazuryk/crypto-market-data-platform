# Autoresearch — Equity Curve Reliability Ranking

Ranks the **best iteration of each strategy/exchange pair** (from `AUTORESEARCH_BEST_ITERATIONS.md`) by how _reliable_ its equity curve is: steady, gradual, monotonic growth with shallow drawdowns — not a curve that gets to the same PnL through spikes and crashes.

Source: the full per-trade `equity_curve` series in `.autoresearch/reports/<tag>/iter_<n>.json`.

---

## Read this first: two findings that reshape the ranking

### 1. The `strategy_spot_futures` family models no price risk — its curves are smooth by construction

Every trade in all 6 `strategy_spot_futures` pairs has `delta_pnl = 0` **and** `spread_pnl = 0`. Net PnL reduces to `funding_pnl − fees`, where `funding_pnl` is always positive and `fees` is a constant per exchange. A curve built from an always-positive term minus a constant _cannot_ have meaningful drawdowns.

Every other family (`strategy_1`, `2`, `3a`, `3b`, `4_1a`, `4_2a`, `4_3a`, `5`) carries real, non-zero `delta_pnl` on ~100% of trades. So `spot_futures` curves are not comparable to the rest and are ranked separately below, not as winners.

`strategy_spot_futures-kucoin` is the extreme case: **390 trades, 390 wins, worst trade +0.00008** — a literally monotonic curve. It is not an edge. Its funding floor (min `funding_pnl` 0.00328) simply sits above its fixed fee (0.0032), so every trade clears costs by construction. Its siblings on binance/gateio have the same zero-risk model but a lower floor, so they book small fixed losses. **Do not read this as the most reliable strategy.**

### 2. Backtest windows differ by a factor of 5

Bitget and OKX funding history starts ~2026-01, giving those pairs **~2.9 months** of data. Binance/KuCoin/Gate pairs get **~15 months**. Smoothness over one quarter is much weaker evidence than smoothness over five, so the score discounts short windows and low trade counts rather than letting them top the table.

---

## Scoring method

Shape score (0–100), on the cumulative-PnL curve:

| Component                                     | Weight | Meaning                                                                          |
| --------------------------------------------- | -----: | -------------------------------------------------------------------------------- |
| R² of linear fit                              |    30% | How close to a straight rising line. This is the core of "gradual and constant". |
| Normalized max drawdown (`maxDD / final PnL`) |    25% | Depth of the worst fall relative to what was earned.                             |
| Normalized ulcer index                        |    15% | RMS drawdown — penalizes _frequent/long_ falls, not just the worst one.          |
| Time under water                              |    10% | Fraction of trades spent below a prior peak.                                     |
| Positive-month fraction                       |    20% | Share of calendar months that ended green — direct test of "constantly growing". |

**Evidence factor** = `sqrt(min(1, months/12)) × sqrt(min(1, trades/200))`. A pristine curve over 2.9 months and 21 trades gets heavily discounted.

**Reliability = Shape × Evidence.** Pairs with final PnL ≤ 0 are disqualified outright — a curve that ends below zero cannot be reliable regardless of its shape.

---

## Ranking — real strategies (price risk modeled)

|   # | Pair                      | Iter | Reliability | Shape | Evidence | Final PnL |    R² | maxDD/PnL | Time u/w | Pos. months | Months | Trades |
| --: | ------------------------- | ---: | ----------: | ----: | -------: | --------: | ----: | --------: | -------: | ----------: | -----: | -----: |
|   1 | **strategy_1-kucoin**     |   10 |    **83.8** |  83.8 |     1.00 |     +4.57 | 0.899 |      0.06 |      64% |         80% |   13.5 |   1800 |
|   2 | **strategy_4_2a-binance** |   20 |    **79.6** |  79.6 |     1.00 |     +0.53 | 0.930 |      0.21 |      56% |         75% |   15.2 |    272 |
|   3 | **strategy_3a-binance**   |   12 |    **67.5** |  67.5 |     1.00 |     +0.69 | 0.816 |      0.36 |      89% |         75% |   15.3 |    771 |
|   4 | **strategy_3b-binance**   |   23 |    **66.9** |  66.9 |     1.00 |     +0.70 | 0.827 |      0.36 |      90% |         69% |   15.3 |    771 |
|   5 | **strategy_4_1a-bybit**   |   25 |    **65.1** |  81.8 |     0.80 |     +1.39 | 0.970 |      0.16 |      84% |         89% |    7.6 |   1133 |
|   6 | **strategy_1-binance**    |    3 |    **64.2** |  64.2 |     1.00 |     +5.26 | 0.523 |      0.20 |      75% |         75% |   15.4 |   3010 |
|   7 | **strategy_5-binance**    |   50 |    **46.2** |  85.0 |     0.54 |     +0.17 | 0.915 |      0.14 |      47% |         90% |   14.7 |     59 |
|   8 | **strategy_4_1a-okx**     |   14 |    **44.5** |  90.0 |     0.49 |     +0.78 | 0.983 |      0.07 |      65% |        100% |    2.9 |    268 |
|   9 | **strategy_4_1a-bitget**  |   16 |    **44.1** |  91.7 |     0.48 |     +1.45 | 0.982 |      0.06 |      54% |        100% |    2.8 |    245 |
|  10 | **strategy_2-bitget**     |   24 |    **43.0** |  89.3 |     0.48 |     +2.07 | 0.947 |      0.04 |      71% |        100% |    2.8 |    707 |
|  11 | **strategy_1-bitget**     |   10 |    **41.4** |  85.7 |     0.48 |     +6.66 | 0.931 |      0.23 |      39% |        100% |    2.8 |   2674 |
|  12 | **strategy_4_2a-okx**     |   24 |    **40.9** |  82.9 |     0.49 |     +0.13 | 0.940 |      0.24 |      67% |        100% |    2.9 |    209 |
|  13 | **strategy_4_1a-binance** |    0 |    **40.0** |  40.0 |     1.00 |     +0.56 | 0.299 |      0.94 |      93% |         62% |   15.2 |   1276 |
|  14 | **strategy_3b-gateio**    |   26 |    **33.9** |  33.9 |     1.00 |     +0.64 | 0.265 |      1.74 |      90% |         62% |   15.4 |   1256 |
|  15 | **strategy_1-okx**        |   14 |    **30.4** |  61.4 |     0.49 |     +0.12 | 0.909 |      0.57 |      90% |         50% |    2.9 |    543 |
|  16 | **strategy_2-okx**        |   26 |    **26.7** |  57.6 |     0.46 |     +0.10 | 0.827 |      1.26 |      86% |         75% |    2.9 |    177 |
|  17 | **strategy_4_3a-okx**     |   24 |    **26.6** |  64.9 |     0.41 |     +0.18 | 0.868 |      0.84 |      77% |         75% |    2.9 |    138 |
|  18 | **strategy_4_2a-bitget**  |   16 |    **19.3** |  73.9 |     0.26 |     +0.40 | 0.853 |      0.32 |      57% |         75% |    2.7 |     61 |
|  19 | **strategy_3a-gateio**    |   18 |    **15.4** |  15.4 |     1.00 |     +0.05 | 0.111 |     17.81 |      96% |         50% |   15.4 |   1256 |

### Tiers

**Tier A — genuinely reliable** (score ≥70): `strategy_1-kucoin`, `strategy_4_2a-binance`

**Tier B — usable, with caveats** (score 50–70): `strategy_3a-binance`, `strategy_3b-binance`, `strategy_4_1a-bybit`, `strategy_1-binance`

**Tier C — weak / short-window** (score 35–50): `strategy_5-binance`, `strategy_4_1a-okx`, `strategy_4_1a-bitget`, `strategy_2-bitget`, `strategy_1-bitget`, `strategy_4_2a-okx`, `strategy_4_1a-binance`

**Tier D — unreliable shape** (score <35): `strategy_3b-gateio`, `strategy_1-okx`, `strategy_2-okx`, `strategy_4_3a-okx`, `strategy_4_2a-bitget`, `strategy_3a-gateio`

---

## Separate table — `strategy_spot_futures` (no price risk modeled; NOT comparable)

| Pair                          | Iter | Shape | Final PnL |    R² | maxDD/PnL | Win rate | Months | Trades | Note                                                  |
| ----------------------------- | ---: | ----: | --------: | ----: | --------: | -------: | -----: | -----: | ----------------------------------------------------- |
| strategy_spot_futures-kucoin  |   18 |  99.9 |     +2.23 | 0.996 |      0.00 |    1.000 |   13.4 |    390 | **100% win rate — funding floor above fee; artifact** |
| strategy_spot_futures-gateio  |   17 |  89.3 |     +3.71 | 0.896 |      0.00 |    0.496 |   14.9 |    395 | delta_pnl and spread_pnl identically zero             |
| strategy_spot_futures-binance |   14 |  89.2 |     +3.20 | 0.925 |      0.00 |    0.516 |   14.8 |    213 | delta_pnl and spread_pnl identically zero             |
| strategy_spot_futures-bybit   |   17 |  85.2 |     +1.80 | 0.787 |      0.02 |    0.386 |    7.4 |    236 | delta_pnl and spread_pnl identically zero             |
| strategy_spot_futures-okx     |   14 |  89.7 |     +0.08 | 0.935 |      0.05 |    0.576 |    2.9 |     33 | delta_pnl and spread_pnl identically zero             |
| strategy_spot_futures-bitget  |    4 |  95.9 |     +0.25 | 0.921 |      0.01 |    0.857 |    2.3 |     21 | delta_pnl and spread_pnl identically zero             |

These curves look immaculate. They are immaculate because the model cannot lose on price. Treat the whole family as unvalidated until the spot and futures legs are marked to market.

---

## Disqualified — final PnL ≤ 0 (24 pairs)

Best iteration still ends flat or in the red, so curve shape is moot.

| Pair                  | Iter | Final PnL |
| --------------------- | ---: | --------: |
| strategy_2-gateio     |   12 |     -7.91 |
| strategy_3b-kucoin    |   25 |     -6.55 |
| strategy_3a-kucoin    |   25 |     -6.43 |
| strategy_3b-bitget    |   26 |     -3.98 |
| strategy_2-binance    |   23 |     -2.85 |
| strategy_2-bybit      |   24 |     -2.40 |
| strategy_2-kucoin     |   23 |     -1.93 |
| strategy_3a-bitget    |   25 |     -1.90 |
| strategy_4_1a-kucoin  |   26 |     -1.51 |
| strategy_4_2a-gateio  |   11 |     -1.31 |
| strategy_4_1a-gateio  |   18 |     -1.10 |
| strategy_3b-bybit     |   14 |     -1.09 |
| strategy_3a-bybit     |   10 |     -1.04 |
| strategy_4_3a-kucoin  |   26 |     -0.75 |
| strategy_4_2a-kucoin  |   21 |     -0.65 |
| strategy_1-bybit      |   13 |     -0.59 |
| strategy_4_3a-gateio  |   26 |     -0.42 |
| strategy_1-gateio     |   22 |     -0.32 |
| strategy_3a-okx       |   26 |     -0.28 |
| strategy_4_3a-bybit   |   16 |     -0.22 |
| strategy_4_3a-binance |   26 |     -0.13 |
| strategy_4_2a-bybit   |   17 |     -0.09 |
| strategy_4_3a-bitget  |   13 |     -0.05 |
| strategy_3b-okx       |   22 |     +0.00 |

---

## Verdict

**Most reliable real curve: `strategy_1-kucoin` (iteration 10).** 83.8 reliability — R² 0.899 over 13.5 months and 1800 trades, max drawdown only 6% of final PnL, 80% of months green, ending +4.57. It is the only pair that combines a long window, a high trade count, and a near-linear rise.

Runners-up: `strategy_4_2a-binance` (79.6) and `strategy_3a-binance` (67.5).

Worth flagging: **`strategy_1-binance` has the largest PnL of any real pair (+5.26) but ranks only #6** — R² of just 0.523 means it earns that PnL in lurches, not steadily. The highest-PnL pair and the most reliable pair are not the same pair, which is exactly the distinction this ranking exists to draw.
