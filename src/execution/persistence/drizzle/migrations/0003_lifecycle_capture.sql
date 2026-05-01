-- Migration 0003: lifecycle capture
--
-- Adds structured tables and columns for full intent/order/fill/exit lifecycle tracking
-- so later analysis phases (execution-quality, PnL, risk) can query a single accurate source.

-- 1. Extend orders: kind, intended price, rejection details, granular timestamps
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS kind                 TEXT,
  ADD COLUMN IF NOT EXISTS intended_price       TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason     TEXT,
  ADD COLUMN IF NOT EXISTS exchange_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_fill_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS working_at           TIMESTAMPTZ;

-- 2. Extend fills: fee detail, transaction time, mark price, denormalized routing keys
ALTER TABLE fills
  ADD COLUMN IF NOT EXISTS commission_asset   TEXT,
  ADD COLUMN IF NOT EXISTS commission_amount  TEXT,
  ADD COLUMN IF NOT EXISTS transaction_time   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mark_price         TEXT,
  ADD COLUMN IF NOT EXISTS intent_id          TEXT,
  ADD COLUMN IF NOT EXISTS order_kind         TEXT;

-- 3. Extend positions: snapshot-quality risk fields
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS unrealized_pnl    TEXT,
  ADD COLUMN IF NOT EXISTS liquidation_price TEXT,
  ADD COLUMN IF NOT EXISTS effective_leverage TEXT,
  ADD COLUMN IF NOT EXISTS margin_used       TEXT,
  ADD COLUMN IF NOT EXISTS index_price       TEXT;

-- 4. Extend balances_history: full equity picture
ALTER TABLE balances_history
  ADD COLUMN IF NOT EXISTS margin_balance       TEXT,
  ADD COLUMN IF NOT EXISTS equity               TEXT,
  ADD COLUMN IF NOT EXISTS cross_unrealized_pnl TEXT;

-- 5. Extend trade_intents: realized prices, exit context, fill timestamps
ALTER TABLE trade_intents
  ADD COLUMN IF NOT EXISTS avg_entry_price  TEXT,
  ADD COLUMN IF NOT EXISTS avg_exit_price   TEXT,
  ADD COLUMN IF NOT EXISTS exit_reason      TEXT,
  ADD COLUMN IF NOT EXISTS entry_filled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exit_filled_at   TIMESTAMPTZ;

-- 6. intent_lifecycle_events: one row per state-machine transition
CREATE TABLE IF NOT EXISTS intent_lifecycle_events (
  id          TEXT        PRIMARY KEY,
  intent_id   TEXT        NOT NULL REFERENCES trade_intents(id),
  from_status TEXT,
  to_status   TEXT        NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  latency_ms  INTEGER,
  context     JSONB
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_intent_ts
  ON intent_lifecycle_events(intent_id, ts);

-- 7. exit_triggers: one row per exit decision with full trigger context
CREATE TABLE IF NOT EXISTS exit_triggers (
  id                   TEXT        PRIMARY KEY,
  intent_id            TEXT        NOT NULL REFERENCES trade_intents(id),
  reason               TEXT        NOT NULL,
  trigger_price        TEXT,
  trigger_ts           TIMESTAMPTZ NOT NULL,
  source               TEXT        NOT NULL,
  exit_order_client_id TEXT,
  latency_ms           INTEGER,
  context              JSONB
);

CREATE INDEX IF NOT EXISTS idx_exit_triggers_intent_id
  ON exit_triggers(intent_id);

-- 8. realized_pnl: per-intent roll-up computed at exited transition
CREATE TABLE IF NOT EXISTS realized_pnl (
  intent_id       TEXT        PRIMARY KEY REFERENCES trade_intents(id),
  exchange        TEXT        NOT NULL,
  symbol          TEXT        NOT NULL,
  qty             TEXT        NOT NULL,
  avg_entry_price TEXT,
  avg_exit_price  TEXT,
  gross_pnl       TEXT,
  entry_fees      TEXT        NOT NULL DEFAULT '0',
  exit_fees       TEXT        NOT NULL DEFAULT '0',
  funding_total   TEXT        NOT NULL DEFAULT '0',
  net_pnl         TEXT,
  hold_duration_ms BIGINT,
  exit_reason     TEXT,
  computed_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_realized_pnl_exchange_symbol
  ON realized_pnl(exchange, symbol);
