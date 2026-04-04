CREATE TABLE IF NOT EXISTS arbinet.orderbooks
(
    exchange LowCardinality(String),
    symbol String,
    ts DateTime,
    bid_open Nullable(Float64),
    bid_high Nullable(Float64),
    bid_low Nullable(Float64),
    bid_close Nullable(Float64),
    ask_open Nullable(Float64),
    ask_high Nullable(Float64),
    ask_low Nullable(Float64),
    ask_close Nullable(Float64),
    source_type LowCardinality(String),
    is_interpolated Bool DEFAULT false,
    confidence_score LowCardinality(String),
    missing_reason Nullable(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (exchange, symbol, ts)
SETTINGS index_granularity = 8192;
