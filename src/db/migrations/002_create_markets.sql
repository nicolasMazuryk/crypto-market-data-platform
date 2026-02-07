-- Markets table using ReplacingMergeTree for automatic deduplication
--
-- UNIQUENESS SEMANTICS:
-- - (exchange, symbol) forms a logical unique key
-- - ClickHouse does NOT enforce uniqueness at INSERT time
-- - Deduplication occurs during background merge operations
-- - Row with highest updated_at is kept during merges
-- - Use FINAL clause in SELECT queries to force immediate deduplication
--
-- DUPLICATE PREVENTION:
-- 1. Application-level in-batch deduplication in insertMarkets()
-- 2. ReplacingMergeTree eventual deduplication (background)
-- 3. Query-time FINAL clause for consistent reads
--
-- Note: Duplicates can temporarily exist until merges complete!

CREATE TABLE IF NOT EXISTS arbinet.markets
(
    exchange LowCardinality(String),
    symbol String,
    exchange_symbol String,
    type LowCardinality(String),
    listing_date Nullable(DateTime),
    delisting_date Nullable(DateTime),
    is_active Bool,
    created_at DateTime DEFAULT now(),
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (exchange, symbol);
