import { pathToFileURL } from 'url'

import { DATA_PERIOD_END, DATA_PERIOD_START } from '../config/index.js'
import { closeClickHouseClient } from '../db/client.js'
import { syncFundingRates } from '../sync/funding-rates-sync.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

async function main(): Promise<void> {
  try {
    const periodEnd = DATA_PERIOD_END ? DATA_PERIOD_END.toISOString() : 'present'
    logger.info({ env: config.env }, 'Funding rate sync starting')
    logger.info({ periodStart: DATA_PERIOD_START.toISOString(), periodEnd }, 'Starting funding rate sync')

    await syncFundingRates()
  } finally {
    try {
      await closeClickHouseClient()
    } catch (error) {
      logger.error({ err: error }, 'Failed to close ClickHouse client')
    }
  }
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false
if (isMain) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, 'funding-rate-sync fatal error')
    process.exitCode = 1
  })
}
