-- Funding rates table using ReplacingMergeTree for automatic deduplication
--
-- UNIQUENESS SEMANTICS:
-- - (exchange, symbol, funding_time) forms a logical unique key
-- - ClickHouse does NOT enforce uniqueness at INSERT time
-- - Deduplication occurs during background merge operations
-- - Row with highest created_at is kept during merges
-- - Use FINAL clause in SELECT queries to force immediate deduplication
--
-- DUPLICATE PREVENTION:
-- 1. Application-level in-batch deduplication in insertFundingRates()
-- 2. ReplacingMergeTree eventual deduplication (background)
-- 3. Query-time FINAL clause for consistent reads
--
-- PARTITIONING: Data partitioned by month (toYYYYMM(funding_time))
--
-- Note: Duplicates can temporarily exist until merges complete!

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
