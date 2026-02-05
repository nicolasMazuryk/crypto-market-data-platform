# Data Pipeline - Crypto Exchange Markets

Collects active + delisted USDT-margined perpetual markets and stores them in ClickHouse. Funding rates schema is in place for future ingestion.

## Data Period

- Start: **2025-01-01 UTC** (see `src/config/index.ts`)
- End: **open-ended** (`DATA_PERIOD_END = null`)

Funding rates should be collected backwards (newest -> oldest) and filtered to the period start.

## Tech Stack

- TypeScript 5.7 (ESM) + tsx
- ClickHouse (Docker Compose)
- CCXT (exchange REST API)
- Vitest (testing)
- ESLint + Prettier
- Pino logger

## Commands

```bash
npm start                # Run src/index.ts (markets sync)
npm test                 # Run tests
npm run test:coverage    # Tests with coverage
npm run lint             # Lint
npm run lint:fix          # Lint + autofix
npm run format           # Format
npm run format:check     # Check formatting

npm run db:up            # Start ClickHouse
npm run db:down          # Stop + remove containers
npm run db:stop          # Stop containers
npm run db:logs          # Tail ClickHouse logs
npm run db:reset         # Recreate ClickHouse with volumes
npm run db:verify        # Run ClickHouse health script
npm run db:shell         # ClickHouse client shell
```

## Environment

- Uses `.env` (see `.env.example`) for ClickHouse + logging.
- Required: `NODE_ENV`, `LOG_LEVEL`, `CLICKHOUSE_HOST`, `CLICKHOUSE_HTTP_PORT`,
  `CLICKHOUSE_NATIVE_PORT`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`,
  `CLICKHOUSE_PASSWORD` (can be empty).

## Development Workflow

- Define types for API responses, DB rows, and CCXT symbols.
- Keep symbol normalization consistent; store both `symbol` (normalized) and
  `exchange_symbol` (raw).
- Run tests/lint/format before finishing work.

## Project Structure

```
src/
├── config/                  # Data period + exchange config
├── db/                      # ClickHouse client, migrations, queries, tests
├── exchanges/               # CCXT fetchers + symbol/listing helpers
├── markets/
│   └── delistings/           # JSON delisting data + Playwright prompts
├── scripts/                 # Operational scripts (db verification)
├── sync/                    # Market sync orchestration
├── utils/                   # Shared helpers (symbol normalization)
├── index.ts                 # App entry (markets sync -> ClickHouse)
└── logger.ts                # Pino logger
```

## Database Schema

### `arbinet.markets`
```sql
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
```

### `arbinet.funding_rates`
```sql
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
ENGINE = MergeTree
PARTITION BY toYYYYMM(funding_time)
ORDER BY (exchange, symbol, funding_time);
```

## Symbol Normalization

Normalization removes separators and suffixes while preserving the USDT quote.
Always store both the raw exchange symbol and the normalized symbol.

Examples:
- Binance: `BTCUSDT` -> `BTCUSDT`
- OKX: `BTC-USDT-SWAP` -> `BTCUSDT`
- Bybit: `BTCUSDT` -> `BTCUSDT`
- MEXC: `BTC_USDT` -> `BTCUSDT`
- Bitget: `BTCUSDT_UMCBL` -> `BTCUSDT`
- Gate.io: `BTC_USDT` -> `BTCUSDT`
- KuCoin: `BTC/USDT:USDT` -> `BTCUSDT`

## Supported Exchanges

Configured in `src/config/index.ts`:
- Binance (binanceusdm)
- Bybit (bybit)
- OKX (okx)
- MEXC (mexc)
- Bitget (bitget)
- Gate.io (gateio)
- KuCoin Futures (kucoinfutures)

## Playwright Automation (Delisting Collection)

- Use Playwright tools directly (browser_navigate, browser_snapshot, browser_click).
- Do not create scripts; use interactive automation.
- Output JSON to `src/markets/delistings/{exchange}.json`.
- Prompts live in `src/markets/delistings/prompts/{exchange}.md`.

## CCXT Integration Notes

- Prefer CCXT for all exchange REST calls.
- Rate limits: adjust `exchange.rateLimit` when batching requests.
- Timestamps are UTC; filter out records before 2025-01-01.
- Active markets: fetch from CCXT, then merge with delisted markets.
- Delisted markets: load from JSON and reconcile symbols with active data.

## Current Status

- Delisting JSON collected: Binance, Bybit, OKX, MEXC, Bitget.
- In progress: Gate.io, KuCoin delisting collection.
- Next: funding rates ingestion.
