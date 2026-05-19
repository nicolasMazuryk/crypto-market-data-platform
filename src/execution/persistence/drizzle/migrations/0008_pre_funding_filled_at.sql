-- Add pre_funding_filled_at to trade_intents for strategy_6 funding attribution.
-- strategy_6 holds the pre-funding position through the funding event; the MAIN fill
-- arrives 3–9 s after. Using pre_funding_filled_at (which predates fundingTime) as the
-- attribution anchor fixes the entryFilledAt > fundingTime false-negative.
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS pre_funding_filled_at TIMESTAMPTZ;
