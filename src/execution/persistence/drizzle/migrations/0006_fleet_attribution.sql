-- Fleet attribution: add sub_account_id (+ denormalized strategy) to all execution tables.
-- Existing rows receive DEFAULT 'legacy' so NOT NULL constraints are satisfied without backfill.

-- runs: full container identity
ALTER TABLE runs ADD COLUMN IF NOT EXISTS strategy       TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS exchange       TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS sub_account_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS combination_id TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS idx_runs_identity       ON runs (strategy, exchange, sub_account_id);
CREATE INDEX IF NOT EXISTS idx_runs_combination_id ON runs (combination_id);

-- trade_intents: sub_account_id + updated composite index
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS sub_account_id TEXT NOT NULL DEFAULT 'legacy';
DROP INDEX IF EXISTS idx_ti_run_exchange_status;
CREATE INDEX IF NOT EXISTS idx_ti_run_exchange_status ON trade_intents (run_id, exchange, sub_account_id, status);

-- orders: denormalized identity
ALTER TABLE orders ADD COLUMN IF NOT EXISTS strategy       TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sub_account_id TEXT NOT NULL DEFAULT 'legacy';

-- fills: denormalized identity
ALTER TABLE fills ADD COLUMN IF NOT EXISTS strategy       TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE fills ADD COLUMN IF NOT EXISTS sub_account_id TEXT NOT NULL DEFAULT 'legacy';

-- positions: denormalized identity
ALTER TABLE positions ADD COLUMN IF NOT EXISTS strategy       TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS sub_account_id TEXT NOT NULL DEFAULT 'legacy';

-- balances_history: denormalized identity
ALTER TABLE balances_history ADD COLUMN IF NOT EXISTS strategy       TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE balances_history ADD COLUMN IF NOT EXISTS sub_account_id TEXT NOT NULL DEFAULT 'legacy';

-- funding_attributions: denormalized identity
ALTER TABLE funding_attributions ADD COLUMN IF NOT EXISTS strategy       TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE funding_attributions ADD COLUMN IF NOT EXISTS sub_account_id TEXT NOT NULL DEFAULT 'legacy';

-- realized_pnl: denormalized identity
ALTER TABLE realized_pnl ADD COLUMN IF NOT EXISTS strategy       TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE realized_pnl ADD COLUMN IF NOT EXISTS sub_account_id TEXT NOT NULL DEFAULT 'legacy';

-- ops_events: nullable (may be emitted before intent context is known)
ALTER TABLE ops_events ADD COLUMN IF NOT EXISTS sub_account_id TEXT;

-- fills_dead_letter: nullable (fill arrived before order was matched)
ALTER TABLE fills_dead_letter ADD COLUMN IF NOT EXISTS sub_account_id TEXT;
