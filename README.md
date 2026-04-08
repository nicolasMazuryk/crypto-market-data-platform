# Data Pipeline

TypeScript data pipeline for ClickHouse-backed market, funding-rate, and quote workers deployed to a single Hetzner host.

## Tech Stack

- **TypeScript 5.7** - Latest TypeScript version
- **tsx** - Fast TypeScript execution
- **ESLint** - Code linting
- **Prettier** - Code formatting
- **Vitest** - Modern testing framework

## Getting Started

### Installation

```bash
npm install
```

### Run

```bash
npm start
npm run sync:markets
npm run sync:funding-rates
npm run sync:quotes
```

### Testing

Run tests:

```bash
npm test
```

Run tests with coverage:

```bash
npm run test:coverage
```

### Linting & Formatting

Lint code:

```bash
npm run lint
```

Fix linting issues:

```bash
npm run lint:fix
```

Format code:

```bash
npm run format
```

Check formatting:

```bash
npm run format:check
```

## Remote Operations

```bash
npm run remote:ssh
npm run remote:status
npm run remote:logs:markets
npm run remote:logs:funding
npm run remote:logs:quotes
npm run remote:quote-sync
npm run remote:funding-backfill
```

The scheduled `worker-funding-rates` unit runs incremental sync only. Use `worker-funding-rates-backfill` through `npm run remote:funding-backfill` when historical coverage still needs to be seeded.

## Environment

Funding-rate behavior is controlled by:

- `SYNC_DATA_PERIOD_START` / `SYNC_DATA_PERIOD_END` - shared sync window for `sync:markets` and `sync:funding-rates`
- `FUNDING_RATE_SYNC_MODE` - `incremental` for scheduled runs, `backfill` for manual history loads
- `FUNDING_RATE_SYMBOL_CONCURRENCY` - parallel symbol fetches
- `FUNDING_RATE_PAGE_SIZE` - per-request page size

Funding download tasks read their date range and task options from `.env*`:

- `FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START`
- `FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END`
- `FUNDING_DOWNLOAD_TASKS_THRESHOLD`
- `FUNDING_DOWNLOAD_TASKS_DRY_RUN`
- `FUNDING_DOWNLOAD_TASKS_EXCLUDED_EXCHANGES`

Run them with:

```bash
npm run analyze:funding-download-tasks
npm run create:funding-download-tasks
```

## Project Structure

```
.
├── src/           # Source files
├── dist/          # Compiled output (generated)
├── tsconfig.json  # TypeScript configuration
└── package.json   # Dependencies and scripts
```

## License

MIT
