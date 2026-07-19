# Funding Event Chart Visualizer

## 1. Goal

Build a TypeScript (Node.js) batch tool that, for every funding event in a ClickHouse database whose funding rate crosses a configurable threshold, generates a single TradingView-style PNG chart showing the 1-second bid and ask OHLC candles around the funding moment. The tool must run end-to-end fast on thousands of events via worker-thread parallelism, and output images into a folder structure that lets a human iterate through them with the arrow keys.

This tool is used to visually inspect price behavior during funding settlement so that backtesting and live trading strategies can be calibrated to the real microstructure of these events.

---

## 2. Data sources (ClickHouse)

Two tables are queried. Schemas (relevant columns shown):

**`funding_rate`** — one row per funding event.

| column            | type     | notes                                        |
| ----------------- | -------- | -------------------------------------------- |
| `exchange`        | String   | e.g. `binance`                               |
| `symbol`          | String   | e.g. `BTCUSDT`                               |
| `exchange_symbol` | String   | exchange-native symbol form                  |
| `funding_time`    | DateTime | settlement timestamp (UTC, second precision) |
| `funding_rate`    | Float64  | raw decimal (e.g. `-0.003` means `-0.3%`)    |

**`orderbook`** — 1-second OHLC for bids and asks, separately.

| column                                         | type     |
| ---------------------------------------------- | -------- |
| `exchange`                                     | String   |
| `symbol`                                       | String   |
| `ts`                                           | DateTime |
| `bid_open`, `bid_high`, `bid_low`, `bid_close` | Float64  |
| `ask_open`, `ask_high`, `ask_low`, `ask_close` | Float64  |

`bid_*` describes the best bid's 1s candle; `ask_*` describes the best ask's 1s candle. They are independent OHLC series for the same second.

---

## 3. Pipeline overview

```
┌─────────────────────────────────────────────────────────────┐
│ Main thread                                                 │
│  1. Load .env (ClickHouse creds) + config.yaml              │
│  2. Validate both with zod                                  │
│  3. Query funding_rate WHERE threshold matches              │
│  4. Build event list [{exchange, symbol, ts, rate}, ...]    │
│  5. Split events into N batches                             │
│  6. Spawn worker pool (worker_threads), dispatch batches    │
│  7. Aggregate progress, log summary                         │
└─────────────────────────────────────────────────────────────┘
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
       ┌────────┐    ┌────────┐    ┌────────┐
       │worker 0│    │worker 1│    │worker N│
       └────────┘    └────────┘    └────────┘
            │
            ▼ per event:
            ├─ query orderbook in [ts - preSec, ts + postSec]
            ├─ render chart (canvas)
            ├─ write PNG to outputDir/exchange/...
            └─ report progress
```

---

## 4. Tech stack

- **Node.js** ≥ 20 (for native `worker_threads`, fetch, etc.)
- **TypeScript** ≥ 5.3
- **`@clickhouse/client`** — official ClickHouse Node client. Use the streaming JSONEachRow format for the funding-events query; for orderbook windows use compact JSON.
- **`@napi-rs/canvas`** — fastest native Canvas implementation for Node (Skia-based via napi-rs). Drop-in `CanvasRenderingContext2D` API. Significantly faster than `node-canvas` for batch PNG export.
- **`yaml`** — parses `config.yaml`.
- **`dotenv`** — loads ClickHouse credentials from `.env` only.
- **`zod`** — runtime validation for both `.env` and `config.yaml`.
- **`commander`** — minimal CLI surface (mostly `--config` path).
- **`p-limit`** — bounded concurrency for DB I/O inside each worker.

No browser, no Puppeteer — direct canvas → PNG.

---

## 5. Configuration

Runtime options live in a YAML config file (default `./config.yaml`). ClickHouse credentials live separately in `.env` so they can be managed by secrets tooling and stay out of the repo. The two files are loaded at startup, merged into a single in-memory config object, and validated with `zod`. The tool fails fast on any validation error.

### 5.1 `.env` — ClickHouse credentials only

```
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=market_data
```

Nothing else belongs here. All behavioral configuration goes in YAML.

### 5.2 `config.yaml`

```yaml
# ── Filtering ────────────────────────────────────────────────
funding_rate_threshold: -0.003 # raw decimal; -0.003 means -0.3%
threshold_mode: lte # lte | gte | abs_gte
exchanges: [] # optional whitelist; [] = all
symbols: [] # optional whitelist; [] = all
date_range:
  from: '2025-01-01T00:00:00Z' # optional, ISO-8601 UTC
  to: '2025-12-31T23:59:59Z' # optional

# ── Window around funding event ──────────────────────────────
pre_seconds: 30
post_seconds: 180

# ── Output ───────────────────────────────────────────────────
output_dir: ./out
image_width: 1920
image_height: 900
overwrite: false # if false, skip when file exists

# ── Performance ──────────────────────────────────────────────
worker_count: null # null = os.cpus().length
db_concurrency_per_worker: 4

# ── Visual options ───────────────────────────────────────────
show_fib_ladder: true
show_spread_shade: false # faint band between bid/ask close
```

`threshold_mode` mapping:

- `lte` — `funding_rate <= threshold` (default; sweeps significantly negative funding).
- `gte` — `funding_rate >= threshold` (positive-funding sweeps).
- `abs_gte` — `abs(funding_rate) >= |threshold|` (catches both directions).

---

## 6. Database queries

### 6.1 Find funding events

Query the `funding_rate` table for rows matching the configured threshold. The condition is built from `threshold_mode`:

- `lte` — rows where `funding_rate` is less than or equal to the threshold.
- `gte` — rows where `funding_rate` is greater than or equal to the threshold.
- `abs_gte` — rows where the absolute value of `funding_rate` is at least the absolute threshold.

Additional optional `WHERE` clauses narrow by `exchange IN (...)`, `symbol IN (...)`, and `funding_time BETWEEN ... AND ...` from the YAML config. Result columns: `exchange`, `symbol`, `funding_time`, `funding_rate`. Ordered ascending by `funding_time`, then `exchange`, then `symbol`. The query streams (JSONEachRow format) so the main thread can dispatch events to workers as they arrive rather than after the full set is buffered.

### 6.2 Pull orderbook window for one event

For each event, fetch the 1-second OHLC for both bids and asks from the `orderbook` table, filtered to the single `(exchange, symbol)` pair and the time range `[funding_time − pre_seconds, funding_time + post_seconds]` inclusive. Columns: `ts`, `bid_open`, `bid_high`, `bid_low`, `bid_close`, `ask_open`, `ask_high`, `ask_low`, `ask_close`. Ordered ascending by `ts`.

Workers run these queries with bounded concurrency (`db_concurrency_per_worker`) so that DB I/O overlaps PNG encoding without overwhelming ClickHouse.

---

## 7. Visual specification — Option A (side-by-side bid/ask)

### 7.1 Canvas

- Background: `#0d1117` (very dark, slightly bluer than pure black).
- Default size: `1920 × 900`, configurable.
- Output: PNG, no transparency.

### 7.2 Color palette

| element              | color     | notes                        |
| -------------------- | --------- | ---------------------------- |
| chart background     | `#0d1117` |                              |
| grid lines           | `#1e222d` | 1px, solid                   |
| axis tick text       | `#787b86` | 11px monospace               |
| header text          | `#d1d4dc` | 13–14px                      |
| bid up (filled)      | `#26a69a` | teal-green                   |
| bid down (filled)    | `#ef5350` | red                          |
| ask up (hollow)      | `#26a69a` | outline only, 1.5px stroke   |
| ask down (hollow)    | `#ef5350` | outline only, 1.5px stroke   |
| funding event line   | `#7aa2ff` | dashed `[4,3]`, opacity 0.75 |
| Fib ladder line      | `#3a4055` | dashed `[2,4]`, opacity 0.7  |
| Fib ladder label     | `#9aa3b8` | 11px monospace               |
| funding badge border | `#30363d` | 0.5px                        |
| funding badge bg     | `#161b22` |                              |

### 7.3 Layout

```
┌────────────────────────────────────────────────────────────────┐
│ SYMBOL · 1s · EXCHANGE                       ┌──────────────┐  │
│ T₀ 2025-01-15 08:00:00 UTC                   │ FUNDING RATE │  │
│                                              │   -0.300%    │  │
│                                              └──────────────┘  │
│ ┌──────────────────────────────────────────────────┐  ─ 1.2345 │
│ │                                                  │  ─ 1.2300 │
│ │     ▮│ ▯│ ▮│      ║                              │  ─ 1.2255 │
│ │     ▮│ ▯│ ▮│      ║       ▮│ ▯│  ▮│              │  ─ 1.2210 │
│ │                  ║                              │  ─ 1.2165 │
│ │                  funding event                   │  ─ 1.2120 │
│ └──────────────────────────────────────────────────┘  ─ 1.2075 │
│  -30s     -15s      T₀     +30s    +60s ...   +180s            │
└────────────────────────────────────────────────────────────────┘
```

- **Plot area margins:** top `60`, right `90` (room for price axis), bottom `50` (time axis), left `12`.
- **Header (top-left):** symbol, exchange, timeframe label (`1s`), and the funding event UTC timestamp.
- **Funding rate badge (top-right):** small bordered box, label `FUNDING RATE` in muted text, value below in 18px monospace bold, colored red for negative or green for positive. Format value as percent with three decimals: `-0.300%`, `+0.450%`.
- **Right-side price axis:** ~7 horizontal grid lines with price labels in monospace, right-aligned in the right margin. Choose grid spacing by a nice-number algorithm against the y-range.
- **Bottom time axis:** ticks every 10s (configurable). Labels are HH:MM:SS in UTC; the funding-second label is bold and the same color as the funding line.

### 7.4 Candle rendering — side-by-side

For each second in the window (total `pre_seconds + post_seconds + 1` candles):

- Compute `slotWidth = plotWidth / numCandles`.
- The slot is split in half. The **bid candle** occupies the left half with the body filled in the direction color (teal up, red down). The **ask candle** occupies the right half, drawn as an outline only with a 1.5px stroke in the same direction color.
- Each candle body width is roughly `floor(slotWidth / 2) − 1` to leave a small visible gap between the bid and the ask within the same second.
- The wick is a 1px vertical line through the center of each half-slot, spanning the low-to-high range, in the same color as the body.
- Snap line coordinates to half-pixels (`x + 0.5`) for crisp rendering on integer canvas grids.
- **Doji case** (open within 1px of close): draw the body as a 1px-tall horizontal line so it remains visible.
- Bid candles render first, ask candles render on top, so their outlines never get clipped by adjacent fills.

### 7.5 Price range (y-axis)

- `yMin = min(all bid_low in window)` minus 4% padding of `(yMax − yMin)`.
- `yMax = max(all ask_high in window)` plus 4% padding.
- Choose ~7 gridlines via a nice-number algorithm (steps of `1·10ⁿ`, `2·10ⁿ`, `5·10ⁿ`).
- Format price labels with enough decimals to distinguish adjacent ticks. Auto-detect from the magnitude — for sub-1.0 prices use 4–6 decimals; for >100 use 2.

### 7.6 Funding event marker

A dashed vertical line in `#7aa2ff` at the **center** of the funding-event second's slot, spanning full plot height. A small label `T₀` sits at the top of the line, just below the header.

### 7.7 Fibonacci-style % drop ladder

Replaces TradingView's Fib retracement labeling with **cumulative price-drop percentages** at six evenly-spaced levels between the chart's high and low.

Algorithm:

- `chartHigh` = the maximum of every `ask_high` across the entire window.
- `chartLow` = the minimum of every `bid_low` across the entire window.
- `totalDropPct = (chartLow − chartHigh) / chartHigh × 100` — negative when the chart fell, which is the expected case for significant negative funding.
- Generate six levels at the fractions `0, 0.2, 0.4, 0.6, 0.8, 1.0`. For each fraction `t`:
  - The level's price is linearly interpolated between `chartHigh` (at `t = 0`) and `chartLow` (at `t = 1`).
  - The level's label value is `totalDropPct × t` — i.e. `0.00%`, then five progressively more negative values, terminating at `totalDropPct` itself.

Rendering:

- Draw a dashed horizontal line at each level spanning the full plot width, color `#3a4055`, opacity 0.7, dash pattern `[2, 4]`.
- Place the label at the right edge of the plot (just inside the price axis margin), vertically centered on the line, in 11px monospace `#9aa3b8`. Format with sign and two decimals: `-0.15%`, `-0.30%`, etc.
- The top label (`0.00%`) may be omitted for cleanliness.
- Draw the ladder **before** the candles so candles overlay it.
- If the chart shows a net rise (rare but possible for positive funding), the percentages come out positive — the same code path applies, sign-aware.

### 7.8 Header text

Top-left:

```
SYMBOL · 1s · exchange
2025-01-15 08:00:00 UTC
```

Top-right: the funding rate badge described in §7.3.

---

## 8. Output organization

### 8.1 Folder layout

```
out/
├── binance/
│   ├── BTCUSDT_2025-01-15_08-00-00_-0.300pct.png
│   ├── BTCUSDT_2025-01-15_12-00-00_-0.450pct.png
│   ├── ETHUSDT_2025-01-15_08-00-00_-0.310pct.png
│   └── ...
├── bybit/
│   ├── BTCUSDT_2025-01-15_08-00-00_-0.280pct.png
│   └── ...
└── okx/
    └── ...
```

### 8.2 Filename convention

`{symbol}_{YYYY-MM-DD}_{HH-MM-SS}_{rate}.png`

- All date and time components derived from `funding_time`, formatted as UTC.
- `rate` is the funding rate as percent with explicit sign and three decimals, plus a `pct` suffix (to avoid the `%` character in filenames):
  - `-0.003` → `-0.300pct`
  - `+0.00045` → `+0.045pct`
- Within each exchange folder, files sort alphabetically by symbol then chronologically by date and time — arrow-key traversal walks through one symbol's funding events in order.

If `overwrite` is `false` in the config and the destination file already exists, the event is skipped and logged at debug level.

---

## 9. Performance

### 9.1 Parallelization

- Use Node's built-in `worker_threads`. Each worker:
  - Owns its own `ClickHouseClient`.
  - Owns one reusable canvas instance (re-create context per render, or recreate the canvas if the lib doesn't support reset — Skia canvases are cheap).
  - Receives a chunk of `FundingEvent` records via `workerData`.
  - For each event, uses `p-limit(db_concurrency_per_worker)` to overlap DB fetches with rendering.
- Pre-split events into `worker_count` chunks rather than sending one task at a time via `postMessage` — at this scale the messaging overhead matters. If a worker finishes early it can request another chunk.

### 9.2 Targets

On modest hardware (8-core laptop, ClickHouse local), the pipeline should achieve **≥ 200 images/sec aggregate** for typical 211-candle windows. The bottleneck will alternate between ClickHouse latency and PNG encoding — the `db_concurrency_per_worker` knob lets you tune.

### 9.3 Memory

- Keep candle arrays as plain `Float64Array`s where practical (eight arrays × 211 floats per event is trivial; just don't allocate dozens of intermediate objects per render).
- Don't accumulate all events in memory if the total count is huge — stream the funding-events query and batch into the worker pool as rows arrive.

### 9.4 Logging

- Progress: events processed / total, images/sec, ETA. Update every 1s, not per image.
- On error rendering a single event, log and continue — never crash the whole batch.

---

## 10. CLI usage

The CLI is intentionally thin. Almost everything is driven by `config.yaml`; flags exist only to point at a different config, override a few high-impact knobs for ad-hoc runs, and to support a quick "see how many events would match" workflow.

```bash
# normal run — uses ./config.yaml and ./.env
npx tsx src/index.ts

# explicit config path
npx tsx src/index.ts --config ./configs/binance-only.yaml

# dry run — count matching events, do not render
npx tsx src/index.ts --dry-run

# render only the first N events (for visual iteration)
npx tsx src/index.ts --limit 20

# override worker count for one-off runs
npx tsx src/index.ts --workers 16
```

Any flag that overlaps with a YAML key takes precedence over the file.

---

## 11. Acceptance criteria

A reviewer can verify the implementation by checking that all of these hold:

- [ ] `.env` only contains `CLICKHOUSE_*` variables; all other settings live in `config.yaml`.
- [ ] Running with `funding_rate_threshold: -0.003` and `threshold_mode: lte` returns exactly the funding rows where `funding_rate <= -0.003`.
- [ ] For each returned event, exactly one PNG is produced at `out/{exchange}/{symbol}_{YYYY-MM-DD}_{HH-MM-SS}_{±X.XXXpct}.png`.
- [ ] Each PNG is `1920 × 900` by default and has the dark background `#0d1117`.
- [ ] Each second in the window has two candles drawn: a filled bid candle in the left half of the slot and a hollow ask candle in the right half. No overlap.
- [ ] Wick colors match the body direction (up = teal, down = red) on both bid and ask candles.
- [ ] A dashed `#7aa2ff` vertical line marks the center of the funding-event second's slot.
- [ ] The funding rate is displayed in the **top-right corner** in a bordered badge, with sign and three-decimal percent, colored red for negative or green for positive.
- [ ] Six horizontal dashed lines are drawn between `chartHigh` and `chartLow`, with cumulative drop-percent labels at the right edge (e.g. `0.00%`, `-0.15%`, `-0.30%`, `-0.45%`, `-0.60%`, `-0.75%` for a -0.75% total drop).
- [ ] Right-side price axis shows ~7 nice-number ticks with enough decimals to be unique.
- [ ] Bottom time axis shows UTC `HH:MM:SS` labels; the funding-second label is highlighted.
- [ ] Running on 1,000 events on an 8-core machine completes in under ~10 seconds (≥100/sec sustained), excluding cold DB cache.
- [ ] A failed render of a single event is logged and does not abort the run.
- [ ] If `overwrite: false` and the destination file already exists, the event is skipped with a debug log.
