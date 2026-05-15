ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS funding_gate_open boolean NOT NULL DEFAULT false;
