-- Relax funding_attributions unique constraint to allow per-intent rows.
-- Replaces the global (exchange, symbol, funding_time) constraint with two partial indexes:
-- one for attributed rows (with intent_id) and one for unattributed rows (intent_id IS NULL).

ALTER TABLE funding_attributions DROP CONSTRAINT IF EXISTS uq_funding_attr;

-- Attributed rows: unique per (exchange, symbol, funding_time, intent_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_funding_attr_intent
  ON funding_attributions (exchange, symbol, funding_time, intent_id)
  WHERE intent_id IS NOT NULL;

-- Unattributed fallback rows: at most one per (exchange, symbol, funding_time)
CREATE UNIQUE INDEX IF NOT EXISTS uq_funding_attr_null
  ON funding_attributions (exchange, symbol, funding_time)
  WHERE intent_id IS NULL;
