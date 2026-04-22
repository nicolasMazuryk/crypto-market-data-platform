# Equity Curve Metrics

The **equity curve** is an ordered array of cumulative PnL values, one per funding event (e.g., every 8 hours). While trade-level metrics like Sharpe, Sortino, and max drawdown describe individual outcome statistics, equity curve metrics describe the *shape* of wealth accumulation over time — catching patterns like inconsistent growth, extended underwater periods, and step-level imbalances that trade stats miss.

---

## At a Glance

| Metric | Measures | Higher is better? | Good threshold |
|---|---|---|---|
| R² (Log-Linear Smoothness) | How closely growth follows a straight log-scale line | Yes | > 0.95 |
| K-Ratio (Slope Consistency) | Whether the growth rate is steady across sub-periods | Yes | > 0.25 |
| Ulcer Index (Sustained Drawdown Pain) | Average depth of drawdown experienced over time | No (lower = better) | < 5% |
| Recovery Factor | Net profit earned per unit of max absolute drawdown | Yes | > 3 |
| Serenity Ratio | Mean step return relative to Ulcer pain | Yes | Strategy-relative |
| Gain-to-Pain Ratio | Sum of positive steps vs. sum of negative steps | Yes | > 1.5 |

---

## R² — Log-Linear Smoothness

### What it measures
R² quantifies how closely the equity curve hugs a straight line when plotted on a logarithmic scale. A value of 1.0 means growth is perfectly smooth and exponential; values approaching 0 indicate the curve is erratic, plateaus frequently, or collapses.

### Why it matters
A strategy that makes most of its profit in a single lucky spike can show impressive total return while its equity curve is otherwise flat or declining. R² penalizes this by measuring *consistency of growth over the full history*, not just the endpoint.

### Interpretation
| R² | Quality |
|---|---|
| > 0.98 | Excellent |
| 0.95–0.98 | Good |
| 0.85–0.95 | Acceptable |
| < 0.85 | Poor |

---

## K-Ratio — Slope Consistency

### What it measures
K-Ratio measures whether the equity curve grows at a *stable rate* across the entire period. It rewards a steady upward slope and penalizes strategies whose growth rate swings wildly between sub-periods. A negative K-Ratio means the overall equity trend is downward.

### Why it matters
A strategy can have a high R² (good fit to a line overall) yet still exhibit steep growth in one period followed by stagnation in another. K-Ratio catches this: it explicitly weights the slope by its standard error and normalises for the number of observations, so short-window inconsistency shows up.

### Interpretation
| K-Ratio | Quality |
|---|---|
| > 0.35 | Excellent |
| 0.25–0.35 | Good |
| 0.10–0.25 | Acceptable |
| < 0.10 | Poor |
| < 0 | Equity declining |

---

## Ulcer Index — Sustained Drawdown Pain

### What it measures
The Ulcer Index measures the *average squared depth of drawdown* across the entire history — not just the single worst moment. A strategy that spends weeks 15% below its peak accumulates a high Ulcer Index even if max drawdown is moderate.

### Why it matters
Max drawdown is a single worst-case snapshot; it says nothing about how long the strategy stayed in trouble. Ulcer Index captures the *ongoing experience of loss* that a real portfolio manager or investor lives through. Two strategies with the same max drawdown can feel very different to hold if one recovers quickly and the other lingers.

### Interpretation
| Ulcer Index | Quality |
|---|---|
| < 2% | Excellent |
| 2–5% | Good |
| 5–10% | Acceptable |
| > 10% | Poor |

---

## Recovery Factor

### What it measures
Recovery Factor is total net profit divided by the maximum absolute drawdown. A value of 5 means the strategy earned five times as much as its worst peak-to-trough dollar loss.

### Why it matters
Unlike Sharpe (which uses return standard deviation), Recovery Factor uses the *actual capital loss* the strategy inflicted. It bridges the gap between raw return and real risk: a strategy with high returns but a catastrophic drawdown scores poorly, while one that earns steadily with shallow drawdowns scores well.

### Interpretation
| Recovery Factor | Quality |
|---|---|
| > 10 | Excellent |
| 3–10 | Good |
| 1–3 | Acceptable |
| < 1 | Poor |

---

## Serenity Ratio

### What it measures
Serenity Ratio is the mean equity step return divided by the Ulcer Index. It is conceptually analogous to the Sharpe Ratio, but uses Ulcer pain in the denominator instead of standard deviation. This makes it sensitive only to *downside* volatility.

### Why it matters
The Sharpe Ratio penalises upside volatility the same as downside — a strategy that frequently makes large gains looks "noisy" to Sharpe. Serenity Ratio ignores upside volatility and only asks: given how much drawdown pain this curve caused, how much return did it deliver per step?

### Interpretation
Higher is always better. Serenity Ratio does not have universal absolute thresholds — compare it across strategies evaluated on the same dataset. A negative value means the equity curve is on average declining relative to its drawdown pain.

---

## Gain-to-Pain Ratio — Step-Level Balance

### What it measures
Gain-to-Pain Ratio (GPR) is the sum of all positive equity steps divided by the absolute sum of all negative equity steps. It measures the directional balance of the curve at the granular per-step level, independently of trade-level statistics.

### Why it matters
A strategy can have a healthy win rate on individual trades, yet still exhibit large losses at the equity-step level if consecutive losing trades cluster together. GPR captures this clustering effect. A GPR below 1.0 means that, in aggregate, the equity curve's negative moves outweigh its positive moves — regardless of how the final PnL looks.

### Interpretation
| GPR | Quality |
|---|---|
| > 2.0 | Excellent |
| 1.5–2.0 | Good |
| 1.0–1.5 | Acceptable |
| < 1.0 | Poor (losses outweigh gains at step level) |

---

## Aggregate Quality Score

The `equity_curve_quality_score` (0–100) combines all six metrics into a single number for quick triage.

### Weights

| Metric | Weight |
|---|---|
| R² | 20% |
| K-Ratio | 20% |
| Ulcer Index | 20% |
| Recovery Factor | 15% |
| Serenity Ratio | 15% |
| Gain-to-Pain Ratio | 10% |

**Total: 100%**

### Rationale

R² and K-Ratio together carry 40% because smoothness and slope consistency are the most fundamental properties of a well-behaved equity curve. Ulcer Index at 20% captures sustained drawdown pain better than any single drawdown stat. Recovery Factor and Serenity Ratio together at 30% bridge the return-vs-drawdown tradeoff from complementary angles. GPR at 10% is a useful but lighter signal — it is partly redundant with K-Ratio, since a consistent upward slope naturally produces more positive steps than negative ones.

---

## How to Read a Report

**Start with the aggregate score** for a quick yes/no on overall curve quality. A score below ~50 usually signals a structural problem worth investigating before examining trade-level metrics.

**Drill into R² and K-Ratio** to diagnose smoothness. Low R² points to erratic or spike-dominated growth; low K-Ratio points to inconsistent growth *rate*.

**Check Ulcer Index and Recovery Factor** together for the drawdown story. Ulcer tells you how painful the ride was; Recovery Factor tells you whether the final return justified it.

**Finish with Serenity Ratio and GPR** for step-level balance. These are most useful when comparing two strategies with similar aggregate scores — small differences here can reveal which curve is more comfortable to hold in live trading.
