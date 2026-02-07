# Data Pipeline - Crypto Exchange Markets

Collects active + delisted USDT-margined perpetual markets and stores them in ClickHouse. Funding rates schema is in place for future ingestion.

## Data Period

- Start: **2025-01-01 UTC** (see `src/config/index.ts`)
- End: **open-ended** (`DATA_PERIOD_END = null`)

Funding rates should be collected backwards (newest -> oldest) and filtered to the period start.

## Tech Stack

### Core
- TypeScript 5.7 (ESM) + tsx
- ClickHouse (Docker Compose for local, EC2 for production)
- CCXT (exchange REST API)
- Vitest (testing)
- ESLint + Prettier
- Pino logger

### Infrastructure & Deployment
- SST (Serverless Stack) for AWS deployment
- Pulumi for infrastructure as code
- Docker for containerization
- AWS Services:
  - ECS Fargate (scheduled workers)
  - EC2 (ClickHouse database)
  - EventBridge (cron scheduling)
  - CloudWatch (logging and monitoring)
  - SNS + Lambda (Slack alerting)

## Commands

### Development
```bash
npm start                # Run src/index.ts (markets sync)
npm test                 # Run tests
npm run test:coverage    # Tests with coverage
npm run lint             # Lint
npm run lint:fix         # Lint + autofix
npm run format           # Format
npm run format:check     # Check formatting
```

### Local Database
```bash
npm run db:up            # Start ClickHouse
npm run db:down          # Stop + remove containers
npm run db:stop          # Stop containers
npm run db:logs          # Tail ClickHouse logs
npm run db:reset         # Recreate ClickHouse with volumes
npm run db:verify        # Run ClickHouse health script
npm run db:shell         # ClickHouse client shell
```

### Local Sync Operations
```bash
npm run sync:markets         # Run market sync locally
npm run sync:funding-rates   # Run funding rates sync locally
```

### AWS Deployment
```bash
npm run deploy:dev           # Deploy to dev environment
npm run deploy:prod          # Deploy to prod environment
npm run deploy:migrate:dev   # Run migrations on dev
npm run deploy:migrate:prod  # Run migrations on prod
npm run deploy:migrate       # Run migrations (uses current stage)
npm run deploy:remove:dev    # Remove dev environment
npm run deploy:remove:prod   # Remove prod environment
```

## Environment

Uses `.env` (see `.env.example`) for configuration. Stage-specific configs available in `.env.dev` and `.env.prod`.

### Core Application
- `NODE_ENV` - Environment (development/production)
- `LOG_LEVEL` - Logging level (debug/info/warn/error)
- `DATA_PERIOD_START` - Data collection start date (ISO 8601)
- `DATA_PERIOD_END` - Data collection end date (null for open-ended)

### ClickHouse Database
- `CLICKHOUSE_HOST` - Database host
- `CLICKHOUSE_HTTP_PORT` - HTTP port (8123)
- `CLICKHOUSE_NATIVE_PORT` - Native protocol port (9000)
- `CLICKHOUSE_DATABASE` - Database name (arbinet)
- `CLICKHOUSE_USER` - Database user
- `CLICKHOUSE_PASSWORD` - Database password (can be empty for local)

### Application Paths
- `DELISTINGS_DIR` - Directory for delisting JSON files (e.g., `src/markets/delistings`)
- `MIGRATIONS_DIR` - Directory for SQL migration files (e.g., `src/db/migrations`)

### AWS Deployment (required for production)
- `AWS_REGION` - AWS region (e.g., us-east-1)
- `CLICKHOUSE_INSTANCE_TYPE` - EC2 instance type (e.g., t3.medium)
- `CLICKHOUSE_VOLUME_SIZE_GB` - EBS volume size
- `CLICKHOUSE_ALLOWED_CIDR` - IP range for database access (restrict in production)
- `MARKET_SYNC_SCHEDULE` - Cron schedule for market sync worker
- `FUNDING_RATES_SCHEDULE` - Cron schedule for funding rates worker
- `WORKER_LOG_LEVEL` - Log level for ECS workers
- `SLACK_WEBHOOK_URL` - Slack webhook for alerts

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
│   └── delistings/          # JSON delisting data + Playwright prompts
├── scripts/                 # Operational scripts (db verification, sync)
├── sync/                    # Market sync orchestration
├── utils/                   # Shared helpers (symbol normalization)
├── index.ts                 # App entry (markets sync -> ClickHouse)
└── logger.ts                # Pino logger

infra/
├── clickhouse.ts            # EC2 instance for ClickHouse
├── cluster.ts               # ECS cluster configuration
├── monitoring.ts            # CloudWatch alarms + SNS alerts
├── network.ts               # VPC configuration
├── slack-notifier/          # Lambda for Slack notifications
├── workers/                 # ECS task definitions
│   ├── funding-rates.ts     # Funding rates sync worker
│   ├── market-sync.ts       # Market sync worker
│   ├── migration-runner.ts  # Database migration worker
│   └── shared.ts            # Shared worker configuration
├── deploy-migrate.sh        # Migration deployment script
├── deploy-remove.sh         # Environment teardown script
├── sst-with-env.sh          # SST environment loader
└── RUNBOOK.md               # Operational procedures

docker/
└── clickhouse/
    └── user-data.sh         # EC2 instance initialization script
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
- Output JSON to the directory specified by `DELISTINGS_DIR` environment variable (default: `src/markets/delistings/{exchange}.json`).
- Prompts live in `${DELISTINGS_DIR}/prompts/{exchange}.md`.

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
