CREATE TABLE IF NOT EXISTS arbinet.download_tasks
(
    exchange LowCardinality(String),
    symbol String,
    date Date,
    status Enum8('pending' = 0, 'downloading' = 1, 'processing' = 2, 'completed' = 3, 'failed' = 4),
    error_message Nullable(String),
    file_size_bytes Nullable(UInt64),
    rows_written Nullable(UInt32),
    quality_score Nullable(Float32),
    created_at DateTime DEFAULT now(),
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (exchange, symbol, date);
