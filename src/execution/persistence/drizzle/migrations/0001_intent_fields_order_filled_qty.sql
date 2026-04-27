-- Migration 0001: add missing columns for full crash-recovery correctness
--
-- trade_intents gains exchange_symbol, exit_policy, and entry_at so that a
-- recovered intent can be fully reconstructed without hardcoding defaults.
--
-- orders gains filled_qty so that IntentState.filledQty can be restored on
-- restart instead of being reset to 0.

ALTER TABLE trade_intents
  ADD COLUMN exchange_symbol TEXT    NOT NULL DEFAULT '',
  ADD COLUMN exit_policy     JSONB   NOT NULL DEFAULT '{}',
  ADD COLUMN entry_at        TIMESTAMPTZ;

ALTER TABLE orders
  ADD COLUMN filled_qty TEXT NOT NULL DEFAULT '0';
