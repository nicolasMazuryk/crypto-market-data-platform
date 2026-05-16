# Data Pipeline - Crypto Exchange Markets

Collects active + delisted USDT-margined perpetual markets and stores them in ClickHouse. Funding rates schema is in place for future ingestion.

## Data Period

- Start: **2025-01-01 UTC** (see `src/config/index.ts`)
- End: **open-ended** (`SYNC_DATA_PERIOD_END = null`)

Funding rates should be collected backwards (newest -> oldest) and filtered to the period start.

## Quick Start

1. **Prerequisites**: Node.js 18+, Docker Desktop
2. **Install dependencies**: `npm install`
3. **Set up environment**: `cp .env.example .env`
4. **Start ClickHouse**: `npm run db:up`
5. **Wait 10s for DB to be ready**, then verify: `npm run db:verify`
6. **Run market sync**: `npm run sync:markets`
7. **Check data**: `npm run db:shell` → `SELECT count() FROM arbinet.markets;`

## Tech Stack

### Core
- TypeScript 5.7 (ESM) + tsx
- ClickHouse (Docker Compose for local, Hetzner server for production)
- CCXT (exchange REST API)
- Vitest (testing)
- ESLint + Prettier
- Pino logger

### Infrastructure & Deployment
- Terraform (Hetzner Cloud provider)
- Ansible (server provisioning and deployment)
- Docker Compose (ClickHouse persistent, workers one-shot)
- systemd timers (worker scheduling)
- Hetzner Cloud (single server)

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
npm run logs:tail        # Tail combined logs
npm run logs:errors      # Tail error logs only
npm run logs:clean       # Remove all log files
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
npm run sync:funding         # Run funding rates sync locally
npm run validate:funding     # Validate funding rates locally
npm run validate:quotes      # Validate quotes locally
```

### Infrastructure & Deployment
```bash
npm run infra:init           # Initialize Terraform
npm run infra:plan           # Preview infrastructure changes
npm run infra:apply          # Apply infrastructure changes + auto-generate hosts.ini
npm run infra:inventory      # (Re)generate ansible/inventory/hosts.ini from Terraform output
npm run setup                # Full server provisioning (Ansible) — auto-generates hosts.ini first
npm run deploy               # Deploy latest code (git pull + build + restart) — auto-generates hosts.ini first
npm run deploy:migrate       # Run database migrations on server
npm run remote:ssh           # SSH into server
npm run remote:status        # Show Docker containers + timer status
npm run remote:logs:markets  # Tail market sync logs
npm run remote:logs:funding  # Tail funding rates logs
npm run remote:logs:quotes   # Tail quote sync logs
```

Code agents can SSH directly to the remote server (which hosts ClickHouse database) with:

```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10
```

### Remote Workflow (canonical sequence)
```bash
npm run remote:run:markets                  # 1. Sync market listings
npm run remote:funding-backfill             # 2. Backfill historical funding rates
npm run remote:run:funding                  # 3. Run incremental funding sync
npm run remote:validate:funding             # 4. Validate funding data on server
npm run remote:analyze:funding-download-tasks  # 5. Analyze funding download candidates
npm run remote:create:funding-download-tasks   # 6. Create funding download tasks
npm run remote:quote-sync                   # 7. Run quote sync
npm run remote:validate:quotes              # 8. Validate quotes on server
npm run backtest                            # 9. Run backtest locally
```

### Remote Timer Management
```bash
npm run remote:timer:add:markets     # Enable + start market sync timer
npm run remote:timer:add:funding     # Enable + start funding sync timer
npm run remote:timer:remove:markets  # Disable + stop market sync timer
npm run remote:timer:remove:funding  # Disable + stop funding sync timer
```

### Autoresearch

See [AUTORESEARCH.md](../AUTORESEARCH.md) for full architecture, flow, and flag reference.

```bash
npm run autoresearch                        # Run all matrix rows (full tuning)
npm run autoresearch -- --run <tag>         # Run a single tag (e.g. strategy_1-binance)
npm run autoresearch -- --baseline-only     # Iter 0 only (no agent), all rows
npm run autoresearch -- --reset             # Wipe state + worktrees, then run
npm run autoresearch:list                   # Print all tags and iteration counts
npm run autoresearch:dashboard              # Rebuild .autoresearch/dashboard.json
```

Matrix config: `autoresearch/matrix.yaml` — strategy/exchange pairs, iteration counts, parallelism.
Agent instructions: `autoresearch/program.md` — stable prompt prefix telling the agent what to edit.

## Environment

Uses `.env` (see `.env.example`) for local configuration. Production `.env` is templated by Ansible on the server.

### Core Application
- `NODE_ENV` - Environment (development/production)
- `LOG_LEVEL` - Logging level (debug/info/warn/error)
- `SYNC_DATA_PERIOD_START` - Shared sync start date for markets and funding rates (ISO 8601)
- `SYNC_DATA_PERIOD_END` - Shared sync end date (null for open-ended)

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

### Funding Rate Sync Tuning
- `FUNDING_RATE_MAX_RETRIES` - Retry attempts for failed requests (default: 5)
- `FUNDING_RATE_BACKOFF_BASE_MS` - Initial backoff delay (default: 750ms)
- `FUNDING_RATE_BACKOFF_MAX_MS` - Maximum backoff delay (default: 30s)
- `FUNDING_RATE_PAGE_SIZE` - Records per API call (default: 100)
- `FUNDING_RATE_SYMBOL_CONCURRENCY` - Parallel symbol fetches (default: 5)

### Funding Download Tasks
- `FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START` - Inclusive start date (`YYYY-MM-DD`)
- `FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END` - Inclusive end date (`YYYY-MM-DD`)
- `FUNDING_DOWNLOAD_TASKS_THRESHOLD` - Funding-rate cutoff used in create mode
- `FUNDING_DOWNLOAD_TASKS_DRY_RUN` - `true` to preview without inserts
- `FUNDING_DOWNLOAD_TASKS_EXCLUDED_EXCHANGES` - Comma-separated exchanges to skip

### Alerting
- `SLACK_WEBHOOK_URL` - Slack webhook for alerts

## Development Workflow

- Define types for API responses, DB rows, and CCXT symbols.
- Keep symbol normalization consistent; store both `symbol` (normalized) and
  `exchange_symbol` (raw).
- Run tests/lint/format before finishing work.

## Testing Notes

- Tests use in-memory ClickHouse mocks (no real DB needed)
- Run `npm test` without starting `db:up`
- Coverage reports in `coverage/` directory
- Use `describe.concurrent` for parallel test suites

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

terraform/
├── main.tf                  # Provider + terraform block
├── variables.tf             # Input variables
├── server.tf                # Hetzner server + cloud-init
├── volume.tf                # Hetzner volume + attachment
├── firewall.tf              # SSH-only firewall
├── network.tf               # Private network
├── ssh.tf                   # SSH key
├── outputs.tf               # server_ip, volume_linux_device
└── cloud-init.yml.tpl       # Cloud-init template

ansible/
├── ansible.cfg              # SSH settings, inventory path
├── inventory/hosts.ini      # Server IP (from TF output)
├── group_vars/all.yml       # Shared variables
├── playbooks/
│   ├── setup.yml            # Full provisioning
│   └── deploy.yml           # Fast redeploy
└── roles/
    ├── base/                # Packages, timezone, volume mount
    ├── docker/              # Docker Engine + Compose
    ├── hardening/           # UFW firewall rules
    ├── app/                 # Clone repo, build image, deploy
    ├── workers/             # systemd service + timer units
    └── monitoring/          # Health check script + timer

docker/
└── docker-compose.yml       # Local development compose
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

## Sub-Account API Access (all exchanges)

All sub-account API keys live in `live-configs/registry.yaml` (one row per exchange+strategy combo).

**Universal loader** — works for all 6 exchanges, parallel-safe:

```bash
source <(bash scripts/exchange-subkey.sh <exchange> <strategy>)
```

Examples:
```bash
source <(bash scripts/exchange-subkey.sh gateio strategy_1)
gate-cli cex futures account get              # uses GATE_API_KEY/GATE_API_SECRET

source <(bash scripts/exchange-subkey.sh binance strategy_2)
binance-cli futures-usds account info         # uses BINANCE_API_KEY/BINANCE_SECRET_KEY

source <(bash scripts/exchange-subkey.sh okx strategy_1_ws)
okx account balance                           # uses OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE

source <(bash scripts/exchange-subkey.sh bybit strategy_1)
# BYBIT_API_KEY/BYBIT_API_SECRET set for bybit-trading skill (curl-based)
```

Env vars emitted per exchange:
| Exchange | Vars |
|---|---|
| `gateio` | `GATE_API_KEY`, `GATE_API_SECRET` |
| `binance` | `BINANCE_API_KEY`, `BINANCE_SECRET_KEY` |
| `bybit` | `BYBIT_API_KEY`, `BYBIT_API_SECRET` |
| `okx` | `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` |
| `bitget` | `BITGET_API_KEY`, `BITGET_API_SECRET`, `BITGET_API_PASSPHRASE` |
| `kucoin` | `KUCOIN_API_KEY`, `KUCOIN_API_SECRET`, `KUCOIN_API_PASSPHRASE` |

**Parallel safety**: each `claude -p` subprocess spawned by `run-live-verification.sh` has its own env — env vars set in one agent never leak to another. Safe to run 30 agents simultaneously.

**Never use `--profile`, `binance-cli profile create`, or `okx config init` in parallel contexts** — those write to shared config files and will race. Always use env vars.

**Never hardcode keys. Always source from registry via the script.**

Available strategies per exchange (active — verify in registry.yaml):
- `strategy_1`, `strategy_1_ws`, `strategy_2`, `strategy_4_1a`, `strategy_6`

## Development Notes

Progress tracked in GitHub Issues. See `RUNBOOK.md` for operational procedures.

## Execution Engine Config

See `src/execution/docs/configuration.md` for: directory layout, precedence order, secrets guide, parameter reference, and `npm run config:validate` usage.

## Execution Engine Deployment

See `src/execution/docs/runbook.md` for: normal deploy, hotfix deploy, rollback, on-call alert responses, state recovery, and pre-flight checklist.
