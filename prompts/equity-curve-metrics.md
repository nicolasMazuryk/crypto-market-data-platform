# Equity Curve Metrics

## Context

You are implementing equity curve analysis metrics for an algorithmic trading strategy backtesting harness. The backtesting engine already computes standard trade-level metrics (Sharpe, Sortino, max drawdown %, win rate, etc.). Your task is to add a new analysis module that takes the raw **equity curve array** as input and computes six structured metrics that measure the *quality and shape* of the equity curve itself — not individual trade statistics.

The equity curve is an ordered array of cumulative PnL values over time, one value per funding event (e.g., every 8 hours). The index position represents time; the value represents cumulative net PnL at that point.

**Example input shape:**
```json
"equity_curve": [-0.000279, 0.000162, 0.002546, ..., 1.9976]
```

---

## Module Requirements

### Input
```typescript
equity: number[]   // ordered array of cumulative PnL values, length N
```

### Output
A structured object `EquityCurveMetrics` containing all six metrics described below, plus a top-level `equity_curve_quality_score` (0–100) that aggregates them. See the Output Schema section at the end.

---

## Metric 1 — R² (Log-Linear Smoothness)

### What it measures
How well the equity curve fits a straight line on a log scale. A perfectly smooth, compounding strategy scores R² = 1.0. Discontinuous jumps, flat plateaus, and crashes all reduce R² toward 0.

### Why it matters
A high R² means returns are generated consistently over time, not from a single lucky event. It is the primary measure of *smoothness*.

### Formula

```
1. Compute log-equity:
   log_equity[i] = log(equity[i])                  // natural log
   NOTE: skip or clamp any equity[i] <= 0 to a small epsilon (e.g. 1e-10)

2. Fit OLS linear regression over index i = 0..N-1:
   ŷ[i] = a + b·i                                  // fitted values

3. Compute R²:
   SS_res = Σ (log_equity[i] - ŷ[i])²
   SS_tot = Σ (log_equity[i] - mean(log_equity))²
   R²     = 1 - SS_res / SS_tot
```

### Interpretation
| R²       | Quality         |
|----------|-----------------|
| > 0.98   | Excellent       |
| 0.95–0.98| Good            |
| 0.85–0.95| Acceptable      |
| < 0.85   | Poor            |

---

## Metric 2 — K-Ratio (Slope Consistency)

### What it measures
Whether the equity grows at a *consistent rate* over time. Unlike R², it explicitly penalizes deviation from slope and normalizes for observation count. Introduced by Lars Kestner (1996).

### Why it matters
A strategy can have decent R² but a wildly volatile slope in sub-periods. K-Ratio catches this. Negative K-Ratio means the equity trend is downward.

### Formula

```
1. Perform OLS regression of equity[i] over index i:
   (same regression as R², but on raw equity values, not log)
   → slope     b
   → std error of slope  SE_b = sqrt( SS_res / ((N-2) · Σ(i - mean_i)²) )
   → n = N (number of observations)

2. K-Ratio = (b / SE_b) / sqrt(n)
```

### Interpretation
| K-Ratio  | Quality         |
|----------|-----------------|
| > 0.35   | Excellent       |
| 0.25–0.35| Good            |
| 0.10–0.25| Acceptable      |
| < 0.10   | Poor            |
| < 0      | Equity declining|

---

## Metric 3 — Ulcer Index (Sustained Drawdown Pain)

### What it measures
The *average* squared depth of drawdown across the entire period — not just the single worst point. It heavily penalizes strategies that stay deep underwater for extended periods.

### Why it matters
`max_drawdown_pct` is a single worst-case snapshot. Ulcer Index measures the *ongoing experience* of loss throughout the strategy's life. A strategy can have a low max drawdown but a high Ulcer Index if it spends most of its time in moderate drawdown.

### Formula

```
1. Compute running maximum (peak) up to each point:
   running_max[i] = max(equity[0], equity[1], ..., equity[i])

2. Compute percentage drawdown at each point:
   drawdown_pct[i] = ((equity[i] - running_max[i]) / running_max[i]) * 100
   NOTE: drawdown_pct[i] is always <= 0; use 0 if equity[i] >= running_max[i]

3. Compute Ulcer Index:
   UI = sqrt( (1/N) · Σ drawdown_pct[i]² )
```

### Interpretation
| UI       | Quality         |
|----------|-----------------|
| < 2%     | Excellent       |
| 2–5%     | Good            |
| 5–10%    | Acceptable      |
| > 10%    | Poor            |

---

## Metric 4 — Recovery Factor

### What it measures
How much net profit the strategy generated per unit of maximum absolute drawdown. A strategy that earns a lot but drawdowns massively is less capital-efficient than one that earns less but stays shallow.

### Why it matters
Bridges the gap between return and risk. Unlike Sharpe (which uses std dev), Recovery Factor uses actual experienced capital loss.

### Formula

```
1. Compute running maximum:
   running_max[i] = max(equity[0..i])

2. Compute absolute drawdown at each point:
   abs_drawdown[i] = running_max[i] - equity[i]      // always >= 0

3. Max absolute drawdown:
   max_abs_dd = max(abs_drawdown[i])

4. Total net PnL:
   total_pnl = equity[N-1] - equity[0]

5. Recovery Factor = total_pnl / max_abs_dd
   NOTE: if max_abs_dd == 0, return Infinity (no drawdown at all)
```

### Interpretation
| Recovery Factor | Quality         |
|-----------------|-----------------|
| > 10            | Excellent       |
| 3–10            | Good            |
| 1–3             | Acceptable      |
| < 1             | Poor            |

---

## Metric 5 — Serenity Ratio (Composite Quality Score)

### What it measures
Return per unit of Ulcer pain. Analogous to the Sharpe Ratio but uses Ulcer Index in the denominator instead of standard deviation. Rewards both high return *and* low sustained drawdown.

### Why it matters
Sharpe penalizes upside volatility the same as downside. Serenity Ratio only penalizes actual drawdown pain — making it a purer measure of risk-adjusted equity curve quality.

### Formula

```
1. Compute step-wise equity changes:
   Δ[i] = equity[i] - equity[i-1]   for i = 1..N-1

2. Mean step return:
   mean_return = mean(Δ[i])

3. Ulcer Index (UI) from Metric 3 above.

4. Serenity Ratio = mean_return / UI
   NOTE: if UI == 0, return Infinity (perfect no-drawdown curve)
   NOTE: result sign reflects equity direction (positive = growing)
```

### Interpretation
Higher is always better. Compare across strategies on the same dataset — there is no universal threshold. A negative value means the equity is declining on average relative to its drawdown.

---

## Metric 6 — Gain-to-Pain Ratio (Step-Level Balance)

### What it measures
The sum of all positive equity steps divided by the absolute sum of all negative equity steps. Measures how the curve *behaves at each step*, independently of trade-level P&L.

### Why it matters
A strategy might have a good win rate on individual trades, but if the losing *steps* on the equity curve are large (e.g., from multiple losing trades hitting consecutively), GPR captures that. It is the cleanest measure of step-by-step directional consistency.

### Formula

```
1. Compute step-wise equity changes:
   Δ[i] = equity[i] - equity[i-1]   for i = 1..N-1

2. Separate gains and losses:
   gains  = Σ max(Δ[i], 0)
   losses = Σ |min(Δ[i], 0)|         // absolute value

3. Gain-to-Pain Ratio = gains / losses
   NOTE: if losses == 0, return Infinity (equity never declined)
```

### Interpretation
| GPR      | Quality         |
|----------|-----------------|
| > 2.0    | Excellent       |
| 1.5–2.0  | Good            |
| 1.0–1.5  | Acceptable      |
| < 1.0    | Poor (losses outweigh gains at step level) |

---

## Aggregate Quality Score

Compute a single `equity_curve_quality_score` between 0 and 100 by scoring each metric independently and taking a weighted average.

### Individual Metric Scores (0–100)

Each metric is mapped to a 0–100 score using a piecewise linear scale:

```
score_r2 = clamp(
  (r2 - 0.70) / (1.00 - 0.70) * 100,
  0, 100
)

score_k_ratio = clamp(
  (k_ratio - 0.0) / (0.40 - 0.0) * 100,
  0, 100
)

score_ulcer = clamp(
  (1 - ulcer_index / 15.0) * 100,       // inverted: lower UI = higher score
  0, 100
)

score_recovery = clamp(
  (recovery_factor / 15.0) * 100,
  0, 100
)

score_serenity = clamp(
  (serenity_ratio / 0.01) * 100,        // tune this scalar to your domain
  0, 100
)

score_gpr = clamp(
  (gpr - 0.5) / (2.5 - 0.5) * 100,
  0, 100
)
```

### Weighted Average

```
equity_curve_quality_score =
    0.20 · score_r2
  + 0.20 · score_k_ratio
  + 0.20 · score_ulcer
  + 0.15 · score_recovery
  + 0.15 · score_serenity
  + 0.10 · score_gpr
```

Weights rationale:
- R² and K-Ratio together (40%) dominate because smoothness and slope consistency are the most fundamental equity curve properties.
- Ulcer Index (20%) captures sustained pain better than any single drawdown stat.
- Recovery and Serenity (30%) together bridge return vs. drawdown.
- GPR (10%) is a useful signal but partially redundant with K-Ratio.

---

## Output Schema

```typescript
interface EquityCurveMetrics {
  r2: number;                          // 0 to 1
  k_ratio: number;                     // typically -1 to 1+
  ulcer_index: number;                 // percentage, e.g. 7.3 means 7.3%
  recovery_factor: number;             // e.g. 4.2
  serenity_ratio: number;              // domain-dependent
  gain_to_pain_ratio: number;          // e.g. 1.8

  // Per-metric scores 0–100
  scores: {
    r2: number;
    k_ratio: number;
    ulcer_index: number;
    recovery_factor: number;
    serenity_ratio: number;
    gain_to_pain_ratio: number;
  };

  // Aggregate
  equity_curve_quality_score: number;  // 0 to 100
}
```

This object should be appended to the existing backtest result JSON at the top level under the key `"equity_curve_metrics"`.

---

## Implementation Notes

### Edge Cases to Handle
| Case | Handling |
|------|----------|
| `equity[i] <= 0` | Clamp to `1e-10` before `log()` for R² |
| `max_abs_dd == 0` | Return `Infinity` for Recovery Factor |
| `ulcer_index == 0` | Return `Infinity` for Serenity Ratio |
| `losses == 0` | Return `Infinity` for GPR |
| `N < 3` | Return `null` for all metrics and log a warning |
| `NaN` or `Infinity` in equity array | Throw a descriptive error before computing |

### Testing
Validate the implementation against these known-good inputs:

**Perfectly linear curve** `[0, 1, 2, 3, 4, 5]`:
- R² ≈ 1.0
- K-Ratio > 0 (positive slope, low SE)
- Ulcer Index = 0 (never draws down)
- Recovery Factor = Infinity (no drawdown)
- GPR = Infinity (no negative steps)

**Flat then crash** `[5, 5, 5, 5, 2, 1]`:
- R² << 1
- K-Ratio < 0 (downward trend)
- Ulcer Index high
- Recovery Factor < 0 (loss overall)
- GPR < 1 (losses dominate)

**Monotone growing then single spike then crash** (mirrors the provided `iter_0_copy.json` equity curve):
- R² significantly degraded by the discontinuous jump
- K-Ratio may be near zero or negative due to post-spike collapse
- Ulcer Index very high (equity spends ~40% of its history in deep drawdown after the spike)
- Recovery Factor misleadingly low because `total_pnl` is small relative to the spike's drawdown

---

## Reference: use this json file `iter_0_copy.json` containing `equity_curve` array with values for running you tests. Make sure the coding agent (Claude Code) do not read it and load its content to the LLM, because it contain a lot of data (~80,000 tokens which is huge for LLM and waste of money) which can be programatically parsed.

All six metrics should report honestly on this curve — do not normalize away the spike or collapse.