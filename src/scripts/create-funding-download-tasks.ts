import { pathToFileURL } from 'node:url'

import { closeClickHouseClient } from '../db/client.js'
import { insertDownloadTasks, listCompletedTaskKeys } from '../db/queries/downloadTasks.js'
import {
  queryFundingEventsBelowThreshold,
  queryThresholdAnalysis,
  type FundingTriggerEvent,
} from '../db/queries/fundingRates.js'
import { listExchangesBySymbol } from '../db/queries/markets.js'
import type { DownloadTaskRow, MarketRow } from '../db/types.js'
import { logger } from '../logger.js'

export interface TaskKey {
  exchange: string
  symbol: string
  date: string
}

type ScriptMode = 'analyze' | 'create'

interface ScriptConfig {
  mode: ScriptMode
  fundingThreshold: number | null
  dateRangeStart: string
  dateRangeEnd: string
  excludedExchanges: string[]
  dryRun: boolean
}

export function parseConfig(): ScriptConfig {
  const rawMode = process.env.MODE ?? 'create'
  if (rawMode !== 'analyze' && rawMode !== 'create') {
    throw new Error(`Invalid MODE: ${rawMode}. Must be 'analyze' or 'create'`)
  }
  const mode: ScriptMode = rawMode

  const dateRangeStart = process.env.FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START
  if (!dateRangeStart) {
    throw new Error('Missing required env var: FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START')
  }

  const dateRangeEnd = process.env.FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END
  if (!dateRangeEnd) {
    throw new Error('Missing required env var: FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END')
  }

  let fundingThreshold: number | null = null
  if (mode === 'create') {
    const raw = process.env.FUNDING_DOWNLOAD_TASKS_THRESHOLD
    if (!raw) {
      throw new Error('Missing required env var: FUNDING_DOWNLOAD_TASKS_THRESHOLD (required for create mode)')
    }
    fundingThreshold = Number.parseFloat(raw)
    if (Number.isNaN(fundingThreshold)) {
      throw new Error(`Invalid FUNDING_DOWNLOAD_TASKS_THRESHOLD: ${raw}`)
    }
  }

  const excludedExchanges = (process.env.FUNDING_DOWNLOAD_TASKS_EXCLUDED_EXCHANGES ?? 'mexc')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean)

  const dryRun = process.env.FUNDING_DOWNLOAD_TASKS_DRY_RUN === 'true'

  return { mode, fundingThreshold, dateRangeStart, dateRangeEnd, excludedExchanges, dryRun }
}

export function previousDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function isListedOnDate(market: MarketRow, date: string): boolean {
  const dateMs = Date.parse(date + 'T00:00:00Z')

  if (market.listing_date) {
    const listingStr = market.listing_date.includes('T')
      ? market.listing_date
      : market.listing_date.replace(' ', 'T') + 'Z'
    const listingMs = Date.parse(listingStr)
    if (!Number.isNaN(listingMs) && dateMs < listingMs) {
      return false
    }
  }

  if (market.delisting_date) {
    const delistingStr = market.delisting_date.includes('T')
      ? market.delisting_date
      : market.delisting_date.replace(' ', 'T') + 'Z'
    const delistingMs = Date.parse(delistingStr)
    if (!Number.isNaN(delistingMs) && dateMs > delistingMs) {
      return false
    }
  }

  return true
}

function addTask(taskSet: Map<string, TaskKey>, exchange: string, symbol: string, date: string): void {
  const key = `${exchange}:${symbol}:${date}`
  if (!taskSet.has(key)) {
    taskSet.set(key, { exchange, symbol, date })
  }
}

/**
 * Builds the exact (exchange, symbol, date) task set that `create` would produce for a given
 * set of below-threshold funding events: S1-4 direct tasks, midnight previous-day expansion, and
 * S5 cross-exchange expansion. Shared with the coverage audit so its notion of "in scope" never
 * drifts from what this script actually creates tasks for.
 */
export async function buildExpandedTaskSet(
  events: FundingTriggerEvent[],
  dateRangeStart: string,
  excludedExchanges: string[]
): Promise<{ taskSet: Map<string, TaskKey>; directTaskCount: number }> {
  const taskSet = new Map<string, TaskKey>()

  for (const event of events) {
    addTask(taskSet, event.exchange, event.symbol, event.funding_date)

    if (event.is_midnight) {
      const prevDay = previousDay(event.funding_date)
      if (prevDay >= dateRangeStart) {
        addTask(taskSet, event.exchange, event.symbol, prevDay)
      }
    }
  }

  const directTaskCount = taskSet.size

  const symbolDatePairs = new Set<string>()
  for (const task of taskSet.values()) {
    symbolDatePairs.add(`${task.symbol}:${task.date}`)
  }

  const exchangesBySymbol = new Map<string, MarketRow[]>()
  const uniqueSymbols = new Set<string>()
  for (const pair of symbolDatePairs) {
    const [symbol] = pair.split(':')
    if (symbol) {
      uniqueSymbols.add(symbol)
    }
  }

  for (const symbol of uniqueSymbols) {
    exchangesBySymbol.set(symbol, await listExchangesBySymbol(symbol, true))
  }

  for (const pair of symbolDatePairs) {
    const [symbol, date] = pair.split(':')
    if (!symbol || !date) {
      continue
    }
    const markets = exchangesBySymbol.get(symbol) ?? []

    for (const market of markets) {
      if (excludedExchanges.includes(market.exchange)) {
        continue
      }
      if (!isListedOnDate(market, date)) {
        continue
      }
      addTask(taskSet, market.exchange, symbol, date)
    }
  }

  return { taskSet, directTaskCount }
}

async function runAnalyze(config: ScriptConfig): Promise<void> {
  const thresholds = [-0.002, -0.003, -0.004, -0.005, -0.006, -0.007, -0.008]

  logger.info(
    {
      dateStart: config.dateRangeStart,
      dateEnd: config.dateRangeEnd,
      excludedExchanges: config.excludedExchanges,
    },
    'Running threshold analysis'
  )

  const header = `${'Threshold'.padEnd(12)}${'Symbols'.padEnd(10)}${'E-S-Days'.padEnd(12)}${'Sym-Days'.padEnd(12)}${'Midnight'.padEnd(12)}`
  console.log('')
  console.log(header)
  console.log('-'.repeat(header.length))

  for (const threshold of thresholds) {
    const stats = await queryThresholdAnalysis(
      threshold,
      config.dateRangeStart,
      config.dateRangeEnd,
      config.excludedExchanges
    )

    const pct = `${(threshold * 100).toFixed(1)}%`
    console.log(
      `${pct.padEnd(12)}${String(stats.unique_symbols).padEnd(10)}${String(stats.exchange_symbol_days).padEnd(12)}${String(stats.symbol_days).padEnd(12)}${String(stats.midnight_events).padEnd(12)}`
    )
  }

  console.log('')
}

async function runCreate(config: ScriptConfig): Promise<void> {
  if (config.fundingThreshold === null) {
    throw new Error('fundingThreshold is required for create mode')
  }
  const threshold = config.fundingThreshold

  logger.info(
    {
      threshold,
      dateStart: config.dateRangeStart,
      dateEnd: config.dateRangeEnd,
      excludedExchanges: config.excludedExchanges,
      dryRun: config.dryRun,
    },
    'Creating funding download tasks'
  )

  // Step 1: Query funding events below threshold
  const events = await queryFundingEventsBelowThreshold(
    threshold,
    config.dateRangeStart,
    config.dateRangeEnd,
    config.excludedExchanges
  )

  logger.info({ eventCount: events.length }, 'Found funding trigger events')

  // Step 2: Build task set (S1-4 direct + midnight previous-day + S5 cross-exchange expansion)
  const { taskSet, directTaskCount } = await buildExpandedTaskSet(
    events,
    config.dateRangeStart,
    config.excludedExchanges
  )
  logger.info({ directTasks: directTaskCount }, 'Built direct task set (S1-4 + midnight)')

  const expandedTaskCount = taskSet.size
  logger.info(
    {
      totalTasks: expandedTaskCount,
      expandedBy: expandedTaskCount - directTaskCount,
    },
    'After S5 cross-exchange expansion'
  )

  // Step 3: Exclude already-completed tasks
  const completedKeys = await listCompletedTaskKeys()
  const newTasks: { exchange: string; symbol: string; date: string }[] = []
  let skippedCount = 0

  for (const task of taskSet.values()) {
    const key = `${task.exchange}:${task.symbol}:${task.date}`
    if (completedKeys.has(key)) {
      skippedCount++
    } else {
      newTasks.push(task)
    }
  }

  logger.info({ newTasks: newTasks.length, skippedCompleted: skippedCount }, 'Filtered out completed tasks')

  // Step 4: Build rows
  const rows: DownloadTaskRow[] = newTasks.map(task => ({
    exchange: task.exchange,
    symbol: task.symbol,
    date: task.date,
    status: 'pending' as const,
    error_message: null,
    file_size_bytes: null,
    rows_written: null,
    quality_score: null,
  }))

  // Step 5: Summary
  const byExchange = new Map<string, number>()
  for (const row of rows) {
    byExchange.set(row.exchange, (byExchange.get(row.exchange) ?? 0) + 1)
  }

  console.log('')
  console.log('=== Summary ===')
  console.log(`Threshold: ${String(threshold * 100)}%`)
  console.log(`Date range: ${config.dateRangeStart} to ${config.dateRangeEnd}`)
  console.log(`Excluded exchanges: ${config.excludedExchanges.join(', ')}`)
  console.log(`Direct tasks (S1-4 + midnight): ${String(directTaskCount)}`)
  console.log(`After S5 expansion: ${String(expandedTaskCount)}`)
  console.log(`Already completed (skipped): ${String(skippedCount)}`)
  console.log(`New tasks to insert: ${String(rows.length)}`)
  console.log('')
  console.log('By exchange:')
  for (const [exchange, count] of Array.from(byExchange.entries()).sort()) {
    console.log(`  ${exchange}: ${String(count)}`)
  }
  console.log('')

  // Step 6: Insert or dry run
  if (config.dryRun) {
    logger.info('DRY RUN — no tasks inserted')
  } else {
    // Insert in batches of 10000
    const BATCH_SIZE = 10_000
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      await insertDownloadTasks(batch)
      logger.info({ batch: Math.floor(i / BATCH_SIZE) + 1, size: batch.length }, 'Inserted task batch')
    }
    logger.info({ totalInserted: rows.length }, 'All tasks inserted')
  }
}

export async function runCreateFundingDownloadTasks(): Promise<void> {
  const scriptConfig = parseConfig()

  if (scriptConfig.mode === 'analyze') {
    await runAnalyze(scriptConfig)
  } else {
    await runCreate(scriptConfig)
  }
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false

if (isMain) {
  runCreateFundingDownloadTasks()
    .catch((error: unknown) => {
      logger.error({ err: error }, 'create-funding-download-tasks fatal error')
      process.exitCode = 1
    })
    .finally(async () => {
      await closeClickHouseClient()
    })
}
