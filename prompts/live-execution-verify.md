# Live-Execution Verification

**Input format:** The very first line of this prompt is `<exchange> <strategy>` (e.g. `gateio strategy_3a`). Parse exchange and strategy by splitting that line on the first space. Everything after the blank line that follows is the instruction body — do not re-parse it as arguments.

Run once per active combo. Verifies live behavior against the checklist, deletes verified items, writes a timestamped report.

---

## Step 1 — Bootstrap

Read **only** these files, in order:

1. `checklists/<exchange>/<strategy>/checklist.md` — items to verify.
2. `src/execution/docs/verification-data-sources.md` — category → data-source contract.
3. `live-configs/registry.yaml` — find row where `exchange == $1 AND assigned_strategy == $2 AND status == active`. Extract `sub_account_id`, `api_key`, `api_secret`, `api_passphrase`, `allocated_capital_usdt`. Derive `combo_id` as `<exchange>-<strategy>-<sub_account_short>` where `sub_account_short` is the first segment of `sub_account_id` before `@` (or the full id if no `@`). Resolve the exact unit name by running `ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 'systemctl list-units "execution-engine@*" --no-legend'` and matching the combo_id substring. If multiple active rows, pick highest `last_assigned_at`. If none active, **abort with a 1-line "no active combo" report** and stop — no cursor update, no file edits.

   **Credential bootstrap (mandatory before any exchange-skill or CLI call):**
   Run immediately after registry lookup:
   ```bash
   source <(bash scripts/exchange-subkey.sh <exchange> <strategy>)
   ```
   This exports the correct env vars for the exchange's skill/CLI into the current shell — safe for parallel runs because each `claude -p` subprocess has an isolated env.
   Do **not** use `--profile`, `binance-cli profile create`, `okx config init`, or any command that writes to a shared config file — those will race when multiple agents run simultaneously.

   Env vars set per exchange:
   | Exchange | Vars exported |
   |---|---|
   | `gateio` | `GATE_API_KEY`, `GATE_API_SECRET` |
   | `binance` | `BINANCE_API_KEY`, `BINANCE_SECRET_KEY` |
   | `bybit` | `BYBIT_API_KEY`, `BYBIT_API_SECRET` |
   | `okx` | `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` |
   | `bitget` | `BITGET_API_KEY`, `BITGET_API_SECRET`, `BITGET_API_PASSPHRASE` |
   | `kucoin` | `KUCOIN_API_KEY`, `KUCOIN_API_SECRET`, `KUCOIN_API_PASSPHRASE` |
4. `checklists/_cursors.yaml` — read `last_checked_utc` for key `<exchange>__<strategy>`. If absent or file missing, use `last_assigned_at` from the matched registry row as the window start (the moment the combo became active — everything since activation is in scope). Set `window = [last_checked_utc, now_utc]`. Do **not** assume a fixed funding interval; the prompt runs ad hoc and the window can span hours, days, or longer.
5. Strategy spec **only when needed** for a specific checklist item: `docs-strategy/strategies/strategy_<N>.md`.
6. Strategy code **only when needed**: `src/execution/strategies/strategy_<N>.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`. The checklist's `code_refs` point to exact lines — read only those.

No broad exploration. No Glob/Grep across src/.

---

## Step 2 — Collect evidence

Run **only the queries required by categories present in remaining checklist items**. Open one SSH session per data source, batch all queries, close.

### Postgres

```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  "docker exec -i arbinet-postgres psql -U arbinet -d arbinet -At -F '|' <<'SQL'

-- 1. Trade intents in window
SELECT id, strategy, exchange, symbol, status, decided_at, entry_at, entry_filled_at,
       exit_at, exit_filled_at, next_funding_ts, funding_gate_open, error_reason
  FROM trade_intents
  WHERE exchange = '<exchange>'
    AND strategy = '<strategy>'
    AND decided_at >= '<last_checked_utc>'
    AND decided_at < '<now_utc>';

-- 2. Orders for those intents
SELECT id, intent_id, kind, side, order_type, status, reduce_only, placed_at, filled_at,
       filled_qty, avg_fill_price, exchange_order_id, error_reason
  FROM orders
  WHERE intent_id IN (<intent_ids_from_above>);

-- 3. Fills
SELECT id, intent_id, order_id, qty, price, fee, fee_currency, filled_at, created_at
  FROM fills
  WHERE intent_id IN (<intent_ids_from_above>);

-- 3b. Dead-letter fills (unmatched fills that could not be routed to an intent)
SELECT id, exchange, symbol, exchange_order_id, qty, price, fee, fee_currency, filled_at, error_reason, created_at
  FROM fills_dead_letter
  WHERE exchange = '<exchange>'
    AND filled_at >= '<last_checked_utc>'
    AND filled_at < '<now_utc>';

-- 4. Lifecycle events
SELECT id, intent_id, from_status, to_status, latency_ms, context, occurred_at
  FROM intent_lifecycle_events
  WHERE intent_id IN (<intent_ids_from_above>)
  ORDER BY occurred_at;

-- 5. Exit triggers
SELECT id, intent_id, source, trigger_event, exit_order_client_id, latency_ms, context, triggered_at
  FROM exit_triggers
  WHERE intent_id IN (<intent_ids_from_above>);

-- 6. Funding attributions
SELECT id, intent_id, exchange, symbol, funding_time, funding_rate, attributed_pnl_usd, created_at
  FROM funding_attributions
  WHERE intent_id IN (<intent_ids_from_above>);

-- 7. Ops events (recovery + risk events only)
SELECT id, event_type, exchange, strategy, context, occurred_at
  FROM ops_events
  WHERE exchange = '<exchange>'
    AND strategy = '<strategy>'
    AND occurred_at >= '<last_checked_utc>'
    AND occurred_at < '<now_utc>'
    AND (event_type LIKE 'recovery.%' OR event_type LIKE 'risk.%');

-- 8. Realized PnL
SELECT id, intent_id, pnl_usd, realized_at
  FROM realized_pnl
  WHERE intent_id IN (<intent_ids_from_above>);

SQL"
```

Build `<intent_ids_from_above>` from query 1 results; if empty, skip queries 2–8 and skip exchange-skill call. Proceed to Step 3 with zero intents.

### Journald

One SSH call. Target the specific unit for this combo (`execution-engine@<combo_id>.service`), resolved in Step 1:

```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  "sudo journalctl -u execution-engine@<combo_id>.service \
    --since '<last_checked_utc>' --until '<now_utc>' --output=json -q" \
  | jq -c 'select(.event | IN(
      "fill.unmatched","preflight.rejected",
      "oco.cancel.start","oco.cancel.attempt","oco.cancel.success",
      "oco.cancel.exhausted","oco.cancel.already_gone","oco.cancel.strategy_failed",
      "oco.sweep.complete","ws.connection",
      "intent.funding_gate_opened","intent.funding_gate_closed",
      "persistence.wal.discarded",
      "intent.created","intent.submitted","intent.error","intent.exited.complete",
      "order.placed","order.filled","position.opened",
      "monitor.armed.sl_tp_deadline","monitor.deadline_fired",
      "protective.close_placed"
    ))'
```

### Exchange-side cross-check (skill)

Use the exchange-specific skill **only** when intents exist in the window. Credentials are already in env (loaded in Step 1 bootstrap) — skills and CLIs pick them up automatically. Fetch orders, fills, and funding fees for the symbols that traded — do **not** fetch full account history.

Skill / CLI mapping (credentials flow from env vars set in Step 1):
| Exchange | Skill / CLI | Auth mechanism |
|---|---|---|
| `gateio` | `gate-exchange-futures` skill → `gate-cli` | `GATE_API_KEY`/`GATE_API_SECRET` env; also `--api-key`/`--api-secret` flags |
| `binance` | `binance` skill → `binance-cli` | `BINANCE_API_KEY`/`BINANCE_SECRET_KEY` env |
| `bybit` | `bybit-trading` skill | `BYBIT_API_KEY`/`BYBIT_API_SECRET` env (curl/HMAC, no CLI) |
| `okx` | `okx-cex-trade` + `okx-cex-portfolio` skills → `okx` CLI | `OKX_API_KEY`/`OKX_SECRET_KEY`/`OKX_PASSPHRASE` env |
| `bitget` | `bitget-skill` (global at `~/.claude/skills/bitget-skill/`) → `bgc` CLI | `BITGET_API_KEY`/`BITGET_SECRET_KEY`/`BITGET_PASSPHRASE` env |
| `kucoin` | `futures-trading` skill (at `.claude/skills/futures-trading/`) | Direct curl with HMAC — no CLI, no env vars. Agent uses `api_key`/`api_secret`/`api_passphrase` values already extracted from registry in Step 1 to build signed requests |

Skip the exchange-skill call when Postgres + journald already disagree — the divergence is the issue; record it in the report and move on.

### ClickHouse (only if a checklist item references funding-rate snapshot data)

```bash
npm run remote:clickhouse:query -- "SELECT exchange, symbol, funding_time, funding_rate
  FROM arbinet.funding_rates
  WHERE exchange='<exchange>'
    AND funding_time BETWEEN '<last_checked_utc>' AND '<now_utc>'"
```

**Skip Prometheus in v1** — Postgres + journald cover every checklist category. Note in the report.

---

## Step 3 — Verify each open checklist item

For each YAML item in `checklists/<exchange>/<strategy>/checklist.md`:

1. Check whether `trigger_sequence` occurred in the window.
2. If yes, check every clause in `observability_contract` against collected evidence. **All clauses must match** — partial = not verified.
3. Cross-check timing against the strategy spec: entry at `next_funding_ts - entryOffsetSeconds*1000` ± tolerance, exit per `exit_at`.
4. Cross-check exchange-side fills (price, qty, timestamp) against engine `fills` rows.
5. Decision:
   - **Verified** (all clauses match + timing correct + exchange agrees + no anomaly on this item): **delete the entire YAML block** from the checklist using `Edit` tool. Remove from the leading `- id:` line through the line before the next `- id:` (or end of file). Leave no placeholder.
   - **Not yet observed**: leave the item unchanged.
   - **Failed / anomaly**: leave the item, record the anomaly in the Issues section of the report. Do **not** delete.

Be strict: if unsure, do not delete.

---

## Step 4 — Trade-quality audit

Independent of checklist deletions. For every trade intent in the window, flag in Issues if:

- Entry placed > 100 ms off `next_funding_ts - entryOffsetSeconds*1000`.
- Exit placed > 100 ms off planned `exit_at`.
- Fill price diverges > 0.5% from mark price at fill time.
- Any `ops_events` row with `event_type` starting `recovery.` or `risk.killSwitch.`.
- Any `persistence.wal.discarded` log event.
- Engine view of fill (qty, price, time) disagrees with exchange-side fetch.
- `intent_lifecycle_events.latency_ms` > 2000 ms on any hot transition.
- Status sequence violates the FSM: `decided → submitted → acked → working → {partially_filled, filled} → monitoring → exiting → exited`.

Only flag what is **actually seen** in the window. No hypotheticals, no noise. Each flag becomes a structured issue entry in Step 5 — collect all raw evidence (row ids, timestamps, field values) at this step so the report entry is complete.

---

## Step 5 — Write report

Path: `reports/live-verification/<exchange>__<strategy>/<YYYY-MM-DDTHH-MM-SSZ>.md`

Create parent directories if absent. Replace colons in the timestamp with hyphens for filename safety.

```markdown
# Live verification — <exchange>/<strategy> — <utc-ts>
Window: <last_checked_utc> → <now_utc>
Sub-account: <sub_account_id>
Data sources used: postgres, journald[, exchange-skill][, clickhouse]

## Trades (<N>)
| intent_id (short) | symbol | side | entry_at | exit_at | filled_qty | entry_px | exit_px | pnl_usd | status |
|---|---|---|---|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

## Checklist progress
- Items at window start: <X>
- Items verified and removed this run: <Y> (list ids)
- Items remaining: <X - Y>

## Issues

Each issue **must** be written with enough detail to be handed directly to a coding agent as a self-contained fix task. Omit the Issues section entirely if none found.

For every issue (from Step 3 anomalies and Step 4 audit flags):

### Issue: <short-tag>
- **Severity**: critical | high | medium | low
- **Category**: ORDER_LIFECYCLE | TIMING | OCO | WEBSOCKET | FUNDING_GATE | RECOVERY | WAL_DURABILITY | TRADE_QUALITY
- **Description**: One sentence — what failed and why it matters.
- **Observed at**: `<UTC timestamp of first occurrence>`
- **Combo**: `<combo_id>` — exchange: `<exchange>`, strategy: `<strategy>`, sub-account: `<sub_account_id>`
- **Intent**: `<intent_id>` — symbol: `<symbol>`, side: `<side>`, status at failure: `<status>`
- **Evidence**:
  - Postgres: table `<table>`, row `id=<uuid>` — field `<field>=<actual_value>` (expected: `<expected_value>`)
  - Journald: event `<event_name>` at `<ts>` — raw: `<paste relevant JSON fields>`
  - Exchange-side: order `<exchange_order_id>` — `<field>=<value>` (source: exchange skill)
  - *(include every data point that demonstrates the problem — raw values, not paraphrases)*
- **Expected behavior** (from checklist `<checklist_item_id>` or trade-quality rule):
  - `<exact observability_contract clause or audit rule that was violated>`
- **Code refs**:
  - `<file>:<line>` — `<what this line does, why it's relevant>`
  - *(cite all `code_refs` from the checklist item; add extra refs if anomaly tracing revealed more)*
- **Spec ref**: `<docs-strategy/strategies/strategy_N.md — section>`
- **Reproduction window**: `<last_checked_utc>` → `<now_utc>`
- **Hypothesis**: `<one-sentence root cause if obvious from evidence; omit if speculative>`

## Notes
<one paragraph max, only if non-trivial context — omit section if nothing to add>
```

If no trades **and** no issues, write a 3-line "no activity" report instead:

```markdown
# Live verification — <exchange>/<strategy> — <utc-ts>
Window: <last_checked_utc> → <now_utc> — no activity.
Sub-account: <sub_account_id>
```

Keep the Trades table and Checklist progress sections concise. Issues section has no line limit — completeness beats brevity there.

---

## Step 6 — Advance cursor

After the report is written, update `checklists/_cursors.yaml`. If file exists, edit the single line for this key. If file does not exist, create it with all known pair keys (alphabetical order).

```yaml
<exchange>__<strategy>: <now_utc>  # ISO-8601 UTC, e.g. 2026-05-15T14:32:00Z
```

Do **not** advance the cursor if the run aborted (SSH failure, no active combo, etc.).

---

## Step 7 — Stop

End with one sentence: `Verified N/M items, removed K, found J issues. Report: <path>.`

Nothing else.

---

## Hard rules

1. **No broad exploration.** Only read files listed in Step 1. No Glob/Grep across `src/` unless an anomaly requires tracing a specific line cited in `code_refs`.
2. **Read only the files listed in Step 1.** No arbitrary docs, READMEs, or sibling checklists.
3. **Deletion is irreversible.** Verify all observability-contract clauses + timing + exchange agreement before deleting.
5. **Reports contain only real, observed facts.** No "consider monitoring X". No "could improve Y".
7. **Cursor advances only on success.** Abort → no cursor update.
