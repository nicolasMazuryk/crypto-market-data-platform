import { DATA_PERIOD_END, DATA_PERIOD_START } from './config/index.js'
import { syncMarkets } from './sync/markets-sync.js'
import { writeMarketsSnapshot } from './sync/markets-writer.js'
import { config } from './config.js'
import { logger } from './logger.js'

async function main(): Promise<void> {
  const periodEnd = DATA_PERIOD_END ? DATA_PERIOD_END.toISOString() : 'present'

  logger.info({ env: config.env }, 'Application starting')
  logger.info(
    { periodStart: DATA_PERIOD_START.toISOString(), periodEnd },
    'Starting markets sync'
  )

  const markets = await syncMarkets()
  await writeMarketsSnapshot(markets)

  console.log(JSON.stringify(markets, null, 2))
}

main().catch((error) => {
  logger.error({ err: error }, 'markets-sync fatal error')
  process.exitCode = 1
})
