import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

import { closeClickHouseClient } from '../db/client.js'
import { getTaskStatusesForKeys, insertDownloadTasks, type DownloadTaskStatus } from '../db/queries/downloadTasks.js'
import {
  listFundingIntervalViolations,
  queryFundingEventsBelowThreshold,
  queryFundingEventTimesBelowThreshold,
  type FundingIntervalViolation,
} from '../db/queries/fundingRates.js'
import {
  listOrderbookSymbolsUnknownToMarkets,
  listOrphanOrderbookDays,
  queryOrderbookDaySweep,
  queryOrderbookRowsInEnvelope,
  type OrderbookDaySweepRow,
  type OrderbookOrphanDayRow,
} from '../db/queries/orderbooks.js'
import type { OrderbookPair } from '../db/queries/orderbooks.js'
import type { DownloadTaskRow } from '../db/types.js'
import { logger } from '../logger.js'

import { buildExpandedTaskSet, type TaskKey } from './create-funding-download-tasks.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AuditConfig {
  dateRangeStart: string
  dateRangeEnd: string
  threshold: number
  excludedExchanges: string[]
  reportPath: string
  fix: boolean
  preFundingSeconds: number
  postFundingSeconds: number
}

export function loadWindowSecondsFromBaseConfig(baseConfigPath: string): {
  preFundingSeconds: number
  postFundingSeconds: number
} {
  const content = fs.readFileSync(baseConfigPath, 'utf-8')
  const parsed = parse(content) as { window?: { pre_funding_seconds?: number; post_funding_seconds?: number } }
  const pre = parsed.window?.pre_funding_seconds
  const post = parsed.window?.post_funding_seconds
  if (typeof pre !== 'number' || typeof post !== 'number') {
    throw new Error(`${baseConfigPath}: 'window.pre_funding_seconds' and 'window.post_funding_seconds' are required`)
  }
  return { preFundingSeconds: pre, postFundingSeconds: post }
}

export function parseAuditConfig(): AuditConfig {
  const dateRangeStart = process.env.AUDIT_DATE_RANGE_START
  if (!dateRangeStart) {
    throw new Error('Missing required env var: AUDIT_DATE_RANGE_START')
  }

  const dateRangeEnd = process.env.AUDIT_DATE_RANGE_END
  if (!dateRangeEnd) {
    throw new Error('Missing required env var: AUDIT_DATE_RANGE_END')
  }

  const rawThreshold = process.env.FUNDING_DOWNLOAD_TASKS_THRESHOLD
  if (!rawThreshold) {
    throw new Error('Missing required env var: FUNDING_DOWNLOAD_TASKS_THRESHOLD')
  }
  const threshold = Number.parseFloat(rawThreshold)
  if (Number.isNaN(threshold)) {
    throw new Error(`Invalid FUNDING_DOWNLOAD_TASKS_THRESHOLD: ${rawThreshold}`)
  }

  const excludedExchanges = (process.env.FUNDING_DOWNLOAD_TASKS_EXCLUDED_EXCHANGES ?? 'mexc')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean)

  const trimmedReportPath = process.env.AUDIT_REPORT_PATH?.trim()
  const reportPath =
    trimmedReportPath && trimmedReportPath.length > 0
      ? trimmedReportPath
      : '/reports/quotes-validation/coverage-audit.json'

  const baseConfigPath = process.env.BASE_CONFIG_PATH ?? path.join(process.cwd(), 'config', 'base_config.yaml')
  const { preFundingSeconds, postFundingSeconds } = loadWindowSecondsFromBaseConfig(baseConfigPath)

  const fix = process.argv.includes('--fix')

  return {
    dateRangeStart,
    dateRangeEnd,
    threshold,
    excludedExchanges,
    reportPath,
    fix,
    preFundingSeconds,
    postFundingSeconds,
  }
}

// ---------------------------------------------------------------------------
// Pure logic: event window + verdict classification
// ---------------------------------------------------------------------------

export interface EventWindow {
  startMs: number
  endMs: number
}

/** [T-pre, T+post+1) — e.g. pre=60, post=120 -> 181-second window. */
export function computeEventWindow(
  fundingTimeMs: number,
  preFundingSeconds: number,
  postFundingSeconds: number
): EventWindow {
  return {
    startMs: fundingTimeMs - preFundingSeconds * 1000,
    endMs: fundingTimeMs + (postFundingSeconds + 1) * 1000,
  }
}

export function windowLengthSeconds(preFundingSeconds: number, postFundingSeconds: number): number {
  return preFundingSeconds + postFundingSeconds + 1
}

export function isUnobtainableError(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) {
    return false
  }
  const message = errorMessage.toLowerCase()
  return message.includes('404') || message.includes('file not found') || message.includes('not found')
}

export type EventVerdict =
  | 'ok'
  | 'missing_seconds'
  | 'not_yet_downloaded'
  | 'failed_retryable'
  | 'unobtainable'
  | 'task_missing'

export const FAILING_VERDICTS: readonly EventVerdict[] = [
  'missing_seconds',
  'not_yet_downloaded',
  'failed_retryable',
  'task_missing',
]

/**
 * Classifies a single funding event's orderbook coverage. `taskStatuses` covers every calendar
 * date the event's window touches (it can span midnight); the worst status across those dates
 * wins when there is zero second-level coverage.
 */
export function classifyEvent(params: {
  secondsPresent: number
  windowSeconds: number
  hasNullPrice: boolean
  taskStatuses: (DownloadTaskStatus | undefined)[]
}): EventVerdict {
  const { secondsPresent, windowSeconds, hasNullPrice, taskStatuses } = params

  if (secondsPresent >= windowSeconds && !hasNullPrice) {
    return 'ok'
  }

  if (secondsPresent > 0) {
    return 'missing_seconds'
  }

  if (taskStatuses.every(status => status === undefined)) {
    return 'task_missing'
  }

  if (
    taskStatuses.some(
      status => status?.status === 'pending' || status?.status === 'downloading' || status?.status === 'processing'
    )
  ) {
    return 'not_yet_downloaded'
  }

  const failedStatuses = taskStatuses.filter(status => status?.status === 'failed')
  if (failedStatuses.length > 0) {
    const anyRetryable = failedStatuses.some(status => !isUnobtainableError(status?.error_message))
    return anyRetryable ? 'failed_retryable' : 'unobtainable'
  }

  // Task(s) exist and are marked completed, yet no data is present — treat as actionable.
  return 'missing_seconds'
}

function toDateStringUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface EventAuditResult {
  exchange: string
  symbol: string
  date: string
  fundingTimeMs: number
  verdict: EventVerdict
  secondsPresent: number
  windowSeconds: number
  interpolatedSeconds: number
}

export interface CoverageAuditReport {
  generatedAt: string
  dateRangeStart: string
  dateRangeEnd: string
  threshold: number
  windowSeconds: number
  summary: Record<EventVerdict, number>
  worstSymbols: { exchange: string; symbol: string; count: number }[]
  unobtainable: EventAuditResult[]
  actionable: EventAuditResult[]
  orphanOrderbookDays: OrderbookOrphanDayRow[]
  unknownSymbols: OrderbookPair[]
  fundingIntervalViolations: FundingIntervalViolation[]
}

// ---------------------------------------------------------------------------
// Direction A: funding -> orderbook
// ---------------------------------------------------------------------------

export async function auditFundingToOrderbook(config: AuditConfig): Promise<EventAuditResult[]> {
  const windowSeconds = windowLengthSeconds(config.preFundingSeconds, config.postFundingSeconds)

  const dayEvents = await queryFundingEventsBelowThreshold(
    config.threshold,
    config.dateRangeStart,
    config.dateRangeEnd,
    config.excludedExchanges
  )
  const { taskSet } = await buildExpandedTaskSet(dayEvents, config.dateRangeStart, config.excludedExchanges)

  const originEvents = await queryFundingEventTimesBelowThreshold(
    config.threshold,
    config.dateRangeStart,
    config.dateRangeEnd,
    config.excludedExchanges
  )

  const windowsBySymbolDate = new Map<string, Set<number>>()
  for (const event of originEvents) {
    const date = event.funding_time.slice(0, 10)
    const key = `${event.symbol}:${date}`
    const fundingTimeMs = Date.parse(`${event.funding_time.replace(' ', 'T')}Z`)
    let set = windowsBySymbolDate.get(key)
    if (!set) {
      set = new Set()
      windowsBySymbolDate.set(key, set)
    }
    set.add(fundingTimeMs)
  }

  interface AuditEvent {
    exchange: string
    symbol: string
    date: string
    fundingTimeMs: number
  }

  const auditEvents: AuditEvent[] = []
  for (const task of taskSet.values()) {
    const windows = windowsBySymbolDate.get(`${task.symbol}:${task.date}`)
    if (!windows) {
      continue
    }
    for (const fundingTimeMs of windows) {
      auditEvents.push({ exchange: task.exchange, symbol: task.symbol, date: task.date, fundingTimeMs })
    }
  }

  const daySweepRows = await queryOrderbookDaySweep(config.dateRangeStart, config.dateRangeEnd)
  const daySweepMap = new Map<string, OrderbookDaySweepRow>()
  for (const row of daySweepRows) {
    daySweepMap.set(`${row.exchange}:${row.symbol}:${row.d}`, row)
  }

  const isDayComplete = (exchange: string, symbol: string, day: string): boolean => {
    const row = daySweepMap.get(`${exchange}:${symbol}:${day}`)
    if (!row) {
      return false
    }
    return Number(row.rows) === 86_400 && Number(row.nulls) === 0
  }

  const needsSecondLevelCheck: AuditEvent[] = []
  const results: EventAuditResult[] = []

  for (const event of auditEvents) {
    const { startMs, endMs } = computeEventWindow(
      event.fundingTimeMs,
      config.preFundingSeconds,
      config.postFundingSeconds
    )
    const startDay = toDateStringUtc(startMs)
    const endDay = toDateStringUtc(endMs - 1)

    if (isDayComplete(event.exchange, event.symbol, startDay) && isDayComplete(event.exchange, event.symbol, endDay)) {
      results.push({
        exchange: event.exchange,
        symbol: event.symbol,
        date: event.date,
        fundingTimeMs: event.fundingTimeMs,
        verdict: 'ok',
        secondsPresent: windowSeconds,
        windowSeconds,
        interpolatedSeconds: 0,
      })
      continue
    }

    needsSecondLevelCheck.push(event)
  }

  if (needsSecondLevelCheck.length > 0) {
    const taskKeys = new Set<string>()
    const taskKeyList: TaskKey[] = []
    const addTaskKey = (exchange: string, symbol: string, date: string): void => {
      const key = `${exchange}:${symbol}:${date}`
      if (!taskKeys.has(key)) {
        taskKeys.add(key)
        taskKeyList.push({ exchange, symbol, date })
      }
    }

    for (const event of needsSecondLevelCheck) {
      const { startMs, endMs } = computeEventWindow(
        event.fundingTimeMs,
        config.preFundingSeconds,
        config.postFundingSeconds
      )
      addTaskKey(event.exchange, event.symbol, toDateStringUtc(startMs))
      addTaskKey(event.exchange, event.symbol, toDateStringUtc(endMs - 1))
    }

    const taskStatuses = await getTaskStatusesForKeys(taskKeyList)

    for (const event of needsSecondLevelCheck) {
      const { startMs, endMs } = computeEventWindow(
        event.fundingTimeMs,
        config.preFundingSeconds,
        config.postFundingSeconds
      )
      const rows = await queryOrderbookRowsInEnvelope(event.exchange, event.symbol, startMs, endMs)

      const secondsPresent = rows.length
      const hasNullPrice = rows.some(row => row.bid_close === null || row.ask_close === null)
      const interpolatedSeconds = rows.filter(row => Boolean(row.is_interpolated)).length

      const windowDates = [toDateStringUtc(startMs), toDateStringUtc(endMs - 1)]
      const relevantStatuses = windowDates.map(date => taskStatuses.get(`${event.exchange}:${event.symbol}:${date}`))

      const verdict = classifyEvent({
        secondsPresent,
        windowSeconds,
        hasNullPrice,
        taskStatuses: relevantStatuses,
      })

      results.push({
        exchange: event.exchange,
        symbol: event.symbol,
        date: event.date,
        fundingTimeMs: event.fundingTimeMs,
        verdict,
        secondsPresent,
        windowSeconds,
        interpolatedSeconds,
      })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Report assembly + --fix
// ---------------------------------------------------------------------------

function buildSummary(results: EventAuditResult[]): Record<EventVerdict, number> {
  const summary: Record<EventVerdict, number> = {
    ok: 0,
    missing_seconds: 0,
    not_yet_downloaded: 0,
    failed_retryable: 0,
    unobtainable: 0,
    task_missing: 0,
  }
  for (const result of results) {
    summary[result.verdict] += 1
  }
  return summary
}

function buildWorstSymbols(
  results: EventAuditResult[],
  limit = 25
): { exchange: string; symbol: string; count: number }[] {
  const counts = new Map<string, { exchange: string; symbol: string; count: number }>()
  for (const result of results) {
    if (result.verdict === 'ok') {
      continue
    }
    const key = `${result.exchange}:${result.symbol}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
    } else {
      counts.set(key, { exchange: result.exchange, symbol: result.symbol, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit)
}

async function applyFix(results: EventAuditResult[]): Promise<void> {
  const keys = new Map<string, TaskKey>()
  for (const result of results) {
    if (!FAILING_VERDICTS.includes(result.verdict) || result.verdict === 'not_yet_downloaded') {
      continue
    }
    const key = `${result.exchange}:${result.symbol}:${result.date}`
    keys.set(key, { exchange: result.exchange, symbol: result.symbol, date: result.date })
  }

  if (keys.size === 0) {
    return
  }

  const rows: DownloadTaskRow[] = [...keys.values()].map(key => ({
    exchange: key.exchange,
    symbol: key.symbol,
    date: key.date,
    status: 'pending' as const,
    error_message: null,
    file_size_bytes: null,
    rows_written: null,
    quality_score: null,
  }))

  await insertDownloadTasks(rows)
  logger.info({ requeued: rows.length }, 'Re-queued failed/missing keys as pending download tasks')
}

function printSummary(report: CoverageAuditReport): void {
  console.log('')
  console.log('=== Coverage Audit Summary ===')
  console.log(`Date range: ${report.dateRangeStart} to ${report.dateRangeEnd}`)
  console.log(`Threshold: ${String(report.threshold * 100)}%  Window: ${String(report.windowSeconds)}s`)
  console.log('')
  for (const [verdict, count] of Object.entries(report.summary)) {
    console.log(`  ${verdict}: ${String(count)}`)
  }
  console.log('')
  console.log(`Orphan orderbook days: ${String(report.orphanOrderbookDays.length)}`)
  console.log(`Unknown symbols: ${String(report.unknownSymbols.length)}`)
  console.log(`Funding-interval violations: ${String(report.fundingIntervalViolations.length)}`)
  console.log('')
  if (report.worstSymbols.length > 0) {
    console.log('Worst symbols:')
    for (const worst of report.worstSymbols) {
      console.log(`  ${worst.exchange}/${worst.symbol}: ${String(worst.count)}`)
    }
    console.log('')
  }
}

export async function runAuditBacktestCoverage(): Promise<void> {
  const config = parseAuditConfig()

  logger.info(
    {
      dateStart: config.dateRangeStart,
      dateEnd: config.dateRangeEnd,
      threshold: config.threshold,
      excludedExchanges: config.excludedExchanges,
      fix: config.fix,
    },
    'Running backtest coverage audit'
  )

  const eventResults = await auditFundingToOrderbook(config)
  const orphanOrderbookDays = await listOrphanOrderbookDays(config.dateRangeStart, config.dateRangeEnd)
  const unknownSymbols = await listOrderbookSymbolsUnknownToMarkets()
  const fundingIntervalViolations = await listFundingIntervalViolations(
    config.dateRangeStart,
    config.dateRangeEnd,
    config.excludedExchanges
  )

  const report: CoverageAuditReport = {
    generatedAt: new Date().toISOString(),
    dateRangeStart: config.dateRangeStart,
    dateRangeEnd: config.dateRangeEnd,
    threshold: config.threshold,
    windowSeconds: windowLengthSeconds(config.preFundingSeconds, config.postFundingSeconds),
    summary: buildSummary(eventResults),
    worstSymbols: buildWorstSymbols(eventResults),
    unobtainable: eventResults.filter(r => r.verdict === 'unobtainable'),
    actionable: eventResults.filter(r => FAILING_VERDICTS.includes(r.verdict)),
    orphanOrderbookDays,
    unknownSymbols,
    fundingIntervalViolations,
  }

  fs.mkdirSync(path.dirname(config.reportPath), { recursive: true })
  fs.writeFileSync(config.reportPath, JSON.stringify(report, null, 2))
  printSummary(report)

  if (config.fix) {
    await applyFix(eventResults)
  }

  const hasActionableHoles =
    report.actionable.length > 0 || report.orphanOrderbookDays.length > 0 || report.fundingIntervalViolations.length > 0

  process.exitCode = hasActionableHoles ? 1 : 0
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false

if (isMain) {
  runAuditBacktestCoverage()
    .catch((error: unknown) => {
      logger.error({ err: error }, 'audit-backtest-coverage fatal error')
      process.exitCode = 1
    })
    .finally(async () => {
      await closeClickHouseClient()
    })
}
