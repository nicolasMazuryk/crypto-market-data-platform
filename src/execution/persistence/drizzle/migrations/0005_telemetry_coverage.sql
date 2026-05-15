-- fills_dead_letter: captures ws.fill events where the matching order was not found or a PG error occurred
CREATE TABLE IF NOT EXISTS fills_dead_letter (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    exchange TEXT NOT NULL,
    symbol TEXT,
    client_order_id TEXT,
    exchange_order_id TEXT,
    reason TEXT NOT NULL,
    raw_fill_event JSONB,
    error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_fills_dead_letter_exchange_ts ON fills_dead_letter (exchange, ts);

-- Add intentId to funding_attributions for P&L join
ALTER TABLE funding_attributions ADD COLUMN IF NOT EXISTS intent_id TEXT;
