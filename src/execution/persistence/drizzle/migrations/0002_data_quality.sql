-- Migration 0002: data quality improvements
--
-- trade_intents: drop redundant columns (decision_reason, funding_snapshot),
--   add exit_at for tracking when an intent transitions to exited.
-- orders: drop unused raw_snapshot, add stop_price for stop-market exits.
-- balances_history: add wallet balance, reason, intent_id linkage, unrealized_pnl.
-- funding_attributions: add unique constraint to deduplicate WS + REST paths.
-- positions_history: replaced by the new positions table (one row per closed position,
--   full P&L breakdown).

-- 1. trade_intents
ALTER TABLE trade_intents
  DROP COLUMN IF EXISTS decision_reason,
  DROP COLUMN IF EXISTS funding_snapshot,
  ADD COLUMN IF NOT EXISTS exit_at TIMESTAMPTZ;

-- 2. orders
ALTER TABLE orders
  DROP COLUMN IF EXISTS raw_snapshot,
  ADD COLUMN IF NOT EXISTS stop_price TEXT;

-- 3. balances_history
ALTER TABLE balances_history
  ADD COLUMN IF NOT EXISTS balance       TEXT,
  ADD COLUMN IF NOT EXISTS reason        TEXT,
  ADD COLUMN IF NOT EXISTS intent_id     TEXT,
  ADD COLUMN IF NOT EXISTS unrealized_pnl TEXT;

-- 4. funding_attributions: unique constraint enables ON CONFLICT deduplication
DO $$ BEGIN
  ALTER TABLE funding_attributions
    ADD CONSTRAINT uq_funding_attr UNIQUE (exchange, symbol, funding_time);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. Replace positions_history with positions (one row per closed-position lifecycle)
DROP TABLE IF EXISTS positions_history;

CREATE TABLE IF NOT EXISTS positions (
  id                TEXT        PRIMARY KEY,
  intent_id         TEXT        NOT NULL REFERENCES trade_intents(id),
  exchange          TEXT        NOT NULL,
  symbol            TEXT        NOT NULL,
  side              TEXT        NOT NULL,
  leverage          INTEGER     NOT NULL,
  margin_mode       TEXT,
  qty               TEXT        NOT NULL,
  entry_price       TEXT        NOT NULL,
  exit_price        TEXT,
  closed_volume     TEXT,
  max_notional_usd  TEXT,
  closing_pnl       TEXT,
  trading_fee_usd   TEXT,
  funding_fee_usd   TEXT,
  realized_pnl_usd  TEXT,
  roi_pct           TEXT,
  opened_at         TIMESTAMPTZ NOT NULL,
  closed_at         TIMESTAMPTZ,
  status            TEXT        NOT NULL DEFAULT 'open'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_positions_intent_id
  ON positions(intent_id);

CREATE INDEX IF NOT EXISTS idx_positions_exchange_symbol
  ON positions(exchange, symbol);
