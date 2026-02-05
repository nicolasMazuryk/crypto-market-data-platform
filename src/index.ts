import { DATA_PERIOD_END, DATA_PERIOD_START } from './config/index.js'
import { closeClickHouseClient } from './db/client.js'
import { insertMarkets } from './db/queries/markets.js'
import { toClickHouseDateTime, type MarketRow } from './db/types.js'
import { syncMarkets } from './sync/markets-sync.js'
import { config } from './config.js'
import { logger } from './logger.js'

async function main(): Promise<void> {
  try {
    const periodEnd = DATA_PERIOD_END ? DATA_PERIOD_END.toISOString() : 'present'

    logger.info({ env: config.env }, 'Application starting')
    logger.info(
      { periodStart: DATA_PERIOD_START.toISOString(), periodEnd },
      'Starting markets sync'
    )

    const markets = await syncMarkets()
    const now = new Date()
    const rows: MarketRow[] = markets.map((market) => ({
      exchange: market.exchange,
      symbol: market.symbol,
      exchange_symbol: market.exchange_symbol,
      type: market.type,
      listing_date: market.listing_date
        ? toClickHouseDateTime(market.listing_date)
        : null,
      delisting_date: market.delisting_date
        ? toClickHouseDateTime(market.delisting_date)
        : null,
      is_active: market.is_active,
      created_at: toClickHouseDateTime(now),
      updated_at: toClickHouseDateTime(now),
    }))

    await insertMarkets(rows)
    logger.info({ count: rows.length }, 'Saved markets to ClickHouse')
  } finally {
    try {
      await closeClickHouseClient()
    } catch (error) {
      logger.error({ err: error }, 'Failed to close ClickHouse client')
    }
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'markets-sync fatal error')
  process.exitCode = 1
})
