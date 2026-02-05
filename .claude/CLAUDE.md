# Data Pipeline - Crypto Exchange Data Collection

Historical data collection for trading algorithm backtesting. Collects actual and historical (delisted) trading markets and funding rates from crypto exchanges.

## Data Period

**2025-01-01 to present** - All data collection (markets, funding rates) targets this period.
Funding rates collected **backward** (from most recent to oldest).

## Tech Stack

- TypeScript 5.7 + tsx (no compilation)
- ClickHouse (database)
- Vitest (testing)
- ESLint + Prettier

## Commands

```bash
npm start              # Run src/index.ts
npm test               # Run tests
npm run lint           # Check linting
npm run lint:fix       # Fix lint issues
npm run format         # Format code
```

## Project Structure

```
src/
├── index.ts                    # Entry point
└── markets/
    ├── delistings/            # JSON files with delisting dates
    │   ├── binance.json
    │   ├── bybit.json
    │   ├── okx.json
    │   ├── mexc.json
    │   └── bitget.json
    ├── delistings/prompts/    # Playwright automation prompts
    └── listings/              # Listing data
```

## Database Schema

### markets table
```sql
CREATE TABLE markets (
    exchange String,
    symbol String,           -- Normalized: BTCUSDT
    exchange_symbol String,  -- Original: BTC-USDT-SWAP
    type String,
    listing_date Nullable(DateTime),
    delisting_date Nullable(DateTime),
    is_active Boolean
) ENGINE = MergeTree() ORDER BY (exchange, symbol);
```

### funding_rates table
```sql
CREATE TABLE funding_rates (
    exchange String,
    symbol String,
    exchange_symbol String,
    funding_time DateTime,
    funding_rate Decimal(18, 8),  -- 0.0001 = 0.01%
    mark_price Nullable(Decimal(18, 8))
) ENGINE = MergeTree() ORDER BY (exchange, symbol, funding_time);
```

## Symbol Normalization

**Critical**: Always normalize symbols and store both formats.

| Exchange | Raw Format | Normalized |
|----------|-----------|------------|
| Binance  | BTCUSDT | BTCUSDT |
| Bybit    | BTCUSDT | BTCUSDT |
| OKX      | BTC-USDT-SWAP | BTCUSDT |
| MEXC     | BTC_USDT | BTCUSDT |
| Bitget   | BTCUSDT_UMCBL | BTCUSDT |
| Gate.io  | BTC_USDT | BTCUSDT |

## Supported Exchanges

All use USDT-margined perpetual futures:
- Binance, Bybit, OKX, MEXC, Bitget, Gate.io, KuCoin

## Playwright Automation (Delisting Collection)

- Use Playwright tools directly (browser_navigate, browser_snapshot, browser_click, etc.)
- **Never create scripts** - use browser automation tools interactively
- Save data frequently to avoid losing progress
- Output to `src/markets/delistings/{exchange}.json`
- Prompts are in `src/markets/delistings/prompts/{exchange}.md`

## API Integration Notes

- **Rate limits**: Binance 2400/min, Bybit 120/min, OKX 20/2s, MEXC/Bitget 20/s
- **Timestamps**: Always UTC, filter records before 2025-01-01
- **Funding rates**: Store as decimal (0.0001), not percentage (0.01%)
- **Active markets**: Collect from today backward
- **Delisted markets**: Collect from delisting_date backward

## Current Status

**Completed**: Delisting collection for Binance, Bybit, OKX, MEXC, Bitget
**In Progress**: Gate.io, KuCoin delisting collection
**Next**: Markets table population script, funding rates API integration
