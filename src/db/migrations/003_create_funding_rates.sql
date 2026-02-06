-- ReplacingMergeTree deduplicates rows with the same ORDER BY key (exchange, symbol, funding_time).
-- This allows safe re-runs of the sync process without creating duplicate funding rate records.
-- The latest version (by created_at) is kept during merges, enabling idempotent backfill operations.
CREATE TABLE IF NOT EXISTS arbinet.funding_rates
(
    exchange LowCardinality(String),
    symbol String,
    exchange_symbol String,
    funding_time DateTime,
    funding_rate Decimal(18, 8),
    mark_price Nullable(Decimal(18, 8)),
    created_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(funding_time)
ORDER BY (exchange, symbol, funding_time);
