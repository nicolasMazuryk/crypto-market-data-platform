# Autoresearch — Best Iteration per Strategy/Exchange Pair

Generated from `.autoresearch/dashboard.json` (dashboard snapshot `2026-05-09T10:00:29.099Z`) joined against each pair's `.autoresearch/results/<tag>/results.tsv`.

## How the iteration index was resolved

The dashboard records a `best_commit` per pair but not the iteration that produced it. In `results.tsv`, `commit_hash` is the worktree HEAD at the time an iteration ran, so a kept commit is repeated on every subsequent *discarded* row. The best iteration is therefore the **earliest row whose `commit_hash` equals `best_commit` and whose `total_net_pnl` equals `best_pnl`**. All 49 pairs resolved unambiguously, and every resolved row has `status = keep`.

`Best Iter` is the 0-indexed iteration number; iteration 0 is always the un-tuned baseline. A best iteration of 0 means no agent proposal beat the baseline.

## Results

| Strategy | Exchange | Best Iter | Total Iters | Best PnL | Baseline PnL | Delta | Sharpe | Best Commit |
|---|---|---:|---:|---:|---:|---:|---:|---|
| strategy_1 | binance | **3** | 27 | +5.2622 | +4.2694 | +0.9927 | 8.99 | `d852151bc1a2` |
| strategy_1 | bitget | **10** | 27 | +6.6571 | +4.3628 | +2.2942 | 10.69 | `cbd8ee86e252` |
| strategy_1 | bybit | **13** | 27 | -0.5904 | -3.4061 | +2.8157 | -3.71 | `d523519d5787` |
| strategy_1 | gateio | **22** | 27 | -0.3172 | -2.8751 | +2.5578 | -0.38 | `18abbe039b66` |
| strategy_1 | kucoin | **10** | 27 | +4.5734 | +1.9841 | +2.5893 | 9.06 | `5d3a795687e1` |
| strategy_1 | okx | **14** | 27 | +0.1247 | +0.0121 | +0.1126 | 1.80 | `c5e768fb5475` |
| strategy_2 | binance | **23** | 27 | -2.8467 | -23.4728 | +20.6261 | -10.40 | `cd75adf3059d` |
| strategy_2 | bitget | **24** | 27 | +2.0747 | -3.1286 | +5.2033 | 9.54 | `3ef5d59d721f` |
| strategy_2 | bybit | **24** | 27 | -2.4046 | -24.4951 | +22.0905 | -6.45 | `ac482f8d2846` |
| strategy_2 | gateio | **12** | 27 | -7.9093 | -33.3374 | +25.4282 | -9.48 | `3817b3d0aca9` |
| strategy_2 | kucoin | **23** | 27 | -1.9287 | -24.7060 | +22.7773 | -5.76 | `d940332da4ae` |
| strategy_2 | okx | **26** | 27 | +0.1026 | -4.0682 | +4.1709 | 1.52 | `21e03184ce7c` |
| strategy_3a | binance | **12** | 27 | +0.6861 | -20.1768 | +20.8629 | 1.86 | `f1205aafdcd4` |
| strategy_3a | bitget | **25** | 27 | -1.9042 | -40.2776 | +38.3734 | -22.52 | `4b2d10e9747b` |
| strategy_3a | bybit | **10** | 27 | -1.0441 | -28.6621 | +27.6179 | -3.56 | `60cc84abc8a6` |
| strategy_3a | gateio | **18** | 27 | +0.0468 | -39.5658 | +39.6126 | 0.07 | `a19d60a00202` |
| strategy_3a | kucoin | **25** | 27 | -6.4305 | -79.7362 | +73.3057 | -12.49 | `e2f96085a755` |
| strategy_3a | okx | **26** | 27 | -0.2833 | -4.8262 | +4.5429 | -3.14 | `5e5e1c94b6c2` |
| strategy_3b | binance | **23** | 27 | +0.7048 | -20.1194 | +20.8242 | 1.86 | `226d77d6536e` |
| strategy_3b | bitget | **26** | 27 | -3.9789 | -38.1734 | +34.1945 | -27.58 | `75a9ac94170e` |
| strategy_3b | bybit | **14** | 27 | -1.0868 | -29.3113 | +28.2245 | -3.98 | `389151fe7cd7` |
| strategy_3b | gateio | **26** | 27 | +0.6447 | -41.1163 | +41.7610 | 1.00 | `acead9e4d17d` |
| strategy_3b | kucoin | **25** | 27 | -6.5549 | -80.3961 | +73.8413 | -13.11 | `936afbf42844` |
| strategy_3b | okx | **22** | 27 | +0.0000 | -4.4417 | +4.4417 | 0.00 | `1d6900dbb1d9` |
| strategy_4_1a | binance | **0** | 27 | +0.5583 | +0.5583 | +0.0000 | 1.13 | `4913a3c145cc` |
| strategy_4_1a | bitget | **16** | 27 | +1.4487 | -0.0685 | +1.5172 | 13.11 | `a50e34f46206` |
| strategy_4_1a | bybit | **25** | 27 | +1.3917 | -0.4513 | +1.8430 | 3.02 | `aabfe369d801` |
| strategy_4_1a | gateio | **18** | 27 | -1.1022 | -4.8387 | +3.7366 | -3.91 | `e367f623b4a0` |
| strategy_4_1a | kucoin | **26** | 27 | -1.5059 | -4.5039 | +2.9980 | -9.48 | `b2e62055dba7` |
| strategy_4_1a | okx | **14** | 27 | +0.7776 | +0.6452 | +0.1324 | 9.97 | `516a4f16486a` |
| strategy_4_2a | binance | **20** | 27 | +0.5288 | +0.0814 | +0.4474 | 6.59 | `a08bd29e19e3` |
| strategy_4_2a | bitget | **16** | 27 | +0.3979 | -0.1823 | +0.5802 | 8.99 | `d95168615145` |
| strategy_4_2a | bybit | **17** | 27 | -0.0869 | -0.9170 | +0.8301 | -6.80 | `ef954714d00a` |
| strategy_4_2a | gateio | **11** | 27 | -1.3090 | -1.4589 | +0.1499 | -9.07 | `25422d848ae0` |
| strategy_4_2a | kucoin | **21** | 27 | -0.6544 | -2.1651 | +1.5107 | -27.17 | `8a3c840a8a00` |
| strategy_4_2a | okx | **24** | 27 | +0.1305 | +0.0000 | +0.1305 | 4.91 | `5ac3c6877c4b` |
| strategy_4_3a | binance | **26** | 27 | -0.1341 | -4.8382 | +4.7041 | -3.48 | `91c9e062a1ec` |
| strategy_4_3a | bitget | **13** | 27 | -0.0533 | -0.4328 | +0.3795 | -9.67 | `8b1eeaf48ee2` |
| strategy_4_3a | bybit | **16** | 27 | -0.2226 | -5.4467 | +5.2240 | -8.63 | `1c8b95c34494` |
| strategy_4_3a | gateio | **26** | 27 | -0.4172 | -11.0824 | +10.6652 | -23.52 | `19ad6134cef2` |
| strategy_4_3a | kucoin | **26** | 27 | -0.7550 | -8.6811 | +7.9261 | -33.89 | `d51e5b7538b2` |
| strategy_4_3a | okx | **24** | 27 | +0.1824 | -0.5348 | +0.7173 | 3.84 | `0a554071be70` |
| strategy_5 | binance | **50** | 60 | +0.1677 | -2.6220 | +2.7897 | 13.45 | `6345a2ebc0be` |
| strategy_spot_futures | binance | **14** | 20 | +3.1970 | +0.1299 | +3.0671 | 12.12 | `3f538564863c` |
| strategy_spot_futures | bitget | **4** | 20 | +0.2474 | +0.1675 | +0.0799 | 20.80 | `9a6c45651ebe` |
| strategy_spot_futures | bybit | **17** | 20 | +1.7989 | +0.1769 | +1.6220 | 10.06 | `15f9b1b7dd0f` |
| strategy_spot_futures | gateio | **17** | 20 | +3.7121 | +0.9598 | +2.7523 | 7.89 | `05252ead1c6a` |
| strategy_spot_futures | kucoin | **18** | 20 | +2.2277 | +1.9335 | +0.2942 | 27.05 | `46a921a1e23a` |
| strategy_spot_futures | okx | **14** | 20 | +0.0804 | +0.0191 | +0.0613 | 13.49 | `38b32d47d5ae` |

## Winning change per pair

| Pair | Best Iter | Change that produced the best commit |
|---|---:|---|
| strategy_1-binance | 3 | entry_offset_seconds 4 → 5 (test upper boundary for pre-funding entry lead time) |
| strategy_1-bitget | 10 | entry_offset_seconds 2 → 1 (minimize pre-funding delta exposure) |
| strategy_1-bybit | 13 | improved |
| strategy_1-gateio | 22 | entry_offset_seconds 2 → 5 (test max pre-funding window at optimal threshold) |
| strategy_1-kucoin | 10 | funding_threshold 0.009 → 0.011 (jump upward to probe optimum under improved 5s entry) |
| strategy_1-okx | 14 | improved |
| strategy_2-binance | 23 | entry_offset_seconds 2 → 1 (test tighter entry timing on high-conviction -1.5% funding signals) |
| strategy_2-bitget | 24 | funding_threshold 0.009 → 0.007 (expand signal set for more retracement opportunities) |
| strategy_2-bybit | 24 | sl_mult 3.0 → 3.5 (expand SL buffer, continue trend reducing early stops) |
| strategy_2-gateio | 12 | improved |
| strategy_2-kucoin | 23 | retracement_pct 1.75 → 2.0 (widen TP targets to maximum for ultra-filtered signals) |
| strategy_2-okx | 26 | retracement_pct 1.2 → 1.4 (extend TP relaxation trend for higher hit-rate on filtered signals) |
| strategy_3a-binance | 12 | improved |
| strategy_3a-bitget | 25 | entry_offset_seconds 4 → 5 (extend proven market absorption trend; test maximum delay window) |
| strategy_3a-bybit | 10 | entry_offset_seconds 2 → 1 (catch drop earlier on strongest signals) |
| strategy_3a-gateio | 18 | improved |
| strategy_3a-kucoin | 25 | tp_multiplier 1.85 → 1.9 (probe continuation of local optimum improvement trend) |
| strategy_3a-okx | 26 | stop_loss 0.028 → 0.026 (extend proven SL-tightening trend, 2.6% loss budget) |
| strategy_3b-binance | 23 | tp_addend 0.0200 → 0.0210 (refine peak between confirmed-good 0.020 and failed 0.025) |
| strategy_3b-bitget | 26 | deadline_seconds 90 → 120 (more time for TP fill on high-conviction setups) |
| strategy_3b-bybit | 14 | improved |
| strategy_3b-gateio | 26 | tp_addend 0.020 → 0.024 (continue TP-widening trend; final iteration probe) |
| strategy_3b-kucoin | 25 | tp_addend 0.012 → 0.016 (skip micro-tweaks, jump magnitude to explore wider TP targets) |
| strategy_3b-okx | 22 | funding_threshold 0.015 → 0.016 (stricter entry, focus on ultra-high-conviction signals) |
| strategy_4_1a-binance | 0 | baseline |
| strategy_4_1a-bitget | 16 | take_profit 0.020 → 0.018 (tighten TP for early ladder entries; improve achievability) |
| strategy_4_1a-bybit | 25 | ladder_count 5 → 6 (finer rung spacing for optimized 1.8pt span with 4.5x SL buffer) |
| strategy_4_1a-gateio | 18 | improved |
| strategy_4_1a-kucoin | 26 | ladder_count 4 → 3 (test coarser rung spacing; opposite to regressed iter 9, 22 increases) |
| strategy_4_1a-okx | 14 | improved |
| strategy_4_2a-binance | 20 | sl_mult 1.5 → 1.55 (wider loss buffer for edge trade hold-through) |
| strategy_4_2a-bitget | 16 | funding_threshold 0.020 → 0.015 (relax gate; test more trades under high-conviction regime) |
| strategy_4_2a-bybit | 17 | improved |
| strategy_4_2a-gateio | 11 | take_profit 0.003 → 0.0035 (test optimal win-rate range between iter-6 success and upper bound) |
| strategy_4_2a-kucoin | 21 | sl_mult 1.5 → 1.8 (fix coupling rule; widen SL for trade development) |
| strategy_4_2a-okx | 24 | entry_offset_seconds 2 → 3 (allow price confirmation in tight-filtering regime) |
| strategy_4_3a-binance | 26 | sl_mult 1.105 → 1.101 (continue tight SL filtering for whipsaw reduction in tight-TP regime) |
| strategy_4_3a-bitget | 13 | improved |
| strategy_4_3a-bybit | 16 | entry_mult 1.8 → 1.9 (continue relaxation trend for selective trades) |
| strategy_4_3a-gateio | 26 | entry_mult 2.0 → 2.3, sl_mult 2.1 → 2.4 (probe deep-limit regime with 0.1 SL margin) |
| strategy_4_3a-kucoin | 26 | sl_mult 1.5 → 1.45 (tighten SL, enforce discipline on extreme-signal regime) |
| strategy_4_3a-okx | 24 | take_profit 0.015 → 0.018 (extend upside capture on elite signals with adequate SL budget) |
| strategy_5-binance | 50 | min_funding_spread 0.012 → 0.0125 (test intermediate threshold for marginal-spread trade optimization) |
| strategy_spot_futures-binance | 14 | fundingConvergenceThreshold 0.000001 → 0.0000005 (tighten convergence 2× for refined delta-neutral selection) |
| strategy_spot_futures-bitget | 4 | minTotalProfit -0.003 → -0.002 (higher trade quality filter under improved F_threshold) |
| strategy_spot_futures-bybit | 17 | minTotalProfit -0.003 → -0.004 (loosen quality filter in permissive regime) |
| strategy_spot_futures-gateio | 17 | F_threshold 0.0008 → 0.0005 (re-tune after minTotalProfit loosening; test lower-F regime scaling) |
| strategy_spot_futures-kucoin | 18 | minTotalProfit 0.0001 → 0.00008 (continue softening quality filter for additional trade volume) |
| strategy_spot_futures-okx | 14 | F_threshold 0.0012 → 0.0009 (escape converged peak, probe lower-selectivity regime) |

## Summary

- **49 pairs** total.
- **48 pairs** improved on the baseline (best iteration > 0).
- **1 pair** never beat the baseline (best iteration = 0): `strategy_4_1a-binance`

- Largest PnL gains over baseline:

  - `strategy_3b-kucoin` — iteration 25, -80.3961 → -6.5549 (+73.8413)
  - `strategy_3a-kucoin` — iteration 25, -79.7362 → -6.4305 (+73.3057)
  - `strategy_3b-gateio` — iteration 26, -41.1163 → +0.6447 (+41.7610)
  - `strategy_3a-gateio` — iteration 18, -39.5658 → +0.0468 (+39.6126)
  - `strategy_3a-bitget` — iteration 25, -40.2776 → -1.9042 (+38.3734)
