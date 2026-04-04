import { pathToFileURL } from 'node:url'

import { closeClickHouseClient } from '../db/client.js'
import { insertDownloadTasks } from '../db/queries/downloadTasks.js'
import { listExchangesBySymbol } from '../db/queries/markets.js'
import type { DownloadTaskRow } from '../db/types.js'
import { logger } from '../logger.js'

const SYMBOL = 'LTCUSDT'
const DATE_FROM = '2026-02-05T00:00:00Z' // inclusive, UTC
const DATE_TO = '2026-02-05T02:00:00Z' // inclusive, UTC
const EXCHANGE: string | undefined = undefined // set to an exchange name (e.g. 'binance') to filter

function enumerateDates(from: string, to: string): string[] {
  const dates: string[] = []
  const current = new Date(from)
  const end = new Date(to)

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return dates
}

export async function runCreateDownloadTasks(): Promise<void> {
  const markets = await listExchangesBySymbol(SYMBOL, true)

  const filtered = EXCHANGE ? markets.filter(m => m.exchange === EXCHANGE) : markets

  if (filtered.length === 0) {
    logger.error({ symbol: SYMBOL, exchange: EXCHANGE ?? null }, 'No markets found for symbol')
    process.exitCode = 1
    return
  }

  const dates = enumerateDates(DATE_FROM, DATE_TO)
  const rows: DownloadTaskRow[] = []

  for (const date of dates) {
    for (const market of filtered) {
      rows.push({
        exchange: market.exchange,
        symbol: market.symbol,
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      })
    }
  }

  await insertDownloadTasks(rows)
  logger.info({ count: rows.length, days: dates.length, exchanges: filtered.length }, 'Created download tasks')
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false

if (isMain) {
  runCreateDownloadTasks()
    .catch((error: unknown) => {
      logger.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await closeClickHouseClient()
    })
}
