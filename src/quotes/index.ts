import fs from 'node:fs/promises'
import path from 'node:path'

import type { DownloadTaskRow } from '../db/types.js'
import { deleteOrderbooksByExchangeSymbolDate } from '../db/queries/orderbooks.js'
import { updateTaskStatus } from '../db/queries/downloadTasks.js'
import { aggregateQuoteEvents } from './aggregator/index.js'
import {
  DOWNLOAD_BACKOFF_BASE_MS,
  DOWNLOAD_BACKOFF_MAX_MS,
  DOWNLOAD_FILE_CONCURRENCY,
  DOWNLOAD_MAX_RETRIES,
  DOWNLOAD_STALE_AGE_MS,
  DOWNLOAD_SYMBOL_CONCURRENCY,
  DOWNLOAD_TEMP_DIR,
  DOWNLOAD_TIMEOUT_MS,
} from './config.js'
import { downloadFiles, getDownloader } from './downloaders/index.js'
import { getParser } from './parsers/index.js'
import { parseGateMultiFile } from './parsers/gate-orderbook-multi.js'
import type { ProcessedTask, QuoteAggregationContext, QuoteCandle1s, QuoteEvent } from './types.js'
import { writeQuoteCandlesToClickHouse } from './writer/index.js'

interface SyncQuotesOptions {
  readonly onInfo?: (message: string) => void
}

interface ProcessTaskOptions extends SyncQuotesOptions {
  readonly step?: string
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${String(durationMs)}ms`
  }

  return `${(durationMs / 1_000).toFixed(2)}s`
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function parseTaskDate(date: string): Date {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid task date: ${date}`)
  }

  return parsed
}

function taskDayBoundsSeconds(taskDate: string): { readonly start: number; readonly end: number } {
  const startMs = parseTaskDate(taskDate).getTime()
  const start = Math.floor(startMs / 1000)
  const end = Math.floor((startMs + 24 * 60 * 60 * 1000) / 1000)
  return { start, end }
}

async function* parseFilesInOrder(
  filePaths: string[],
  parseFile: (filePath: string) => AsyncIterable<QuoteEvent>
): AsyncIterable<QuoteEvent> {
  const sortedFilePaths = [...filePaths].sort((left, right) => left.localeCompare(right))
  for (const filePath of sortedFilePaths) {
    for await (const event of parseFile(filePath)) {
      yield event
    }
  }
}

async function* filterCandlesToTaskDate(
  candles: AsyncIterable<QuoteCandle1s>,
  taskDate: string
): AsyncIterable<QuoteCandle1s> {
  const bounds = taskDayBoundsSeconds(taskDate)

  for await (const candle of candles) {
    if (candle.ts < bounds.start || candle.ts >= bounds.end) {
      continue
    }

    yield candle
  }
}

async function cleanupTaskTempDir(tempDir: string | null): Promise<void> {
  if (!tempDir) {
    return
  }

  await fs.rm(tempDir, { recursive: true, force: true })
}

async function cleanupStaleTempDirs(log?: (message: string) => void): Promise<void> {
  await fs.mkdir(DOWNLOAD_TEMP_DIR, { recursive: true })

  const entries = await fs.readdir(DOWNLOAD_TEMP_DIR, { withFileTypes: true })
  const staleCutoffMs = Date.now() - Math.max(0, DOWNLOAD_STALE_AGE_MS)

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const directoryPath = path.join(DOWNLOAD_TEMP_DIR, entry.name)

    let stats: Awaited<ReturnType<typeof fs.stat>>
    try {
      stats = await fs.stat(directoryPath)
    } catch {
      continue
    }

    if (stats.mtimeMs > staleCutoffMs) {
      continue
    }

    await fs.rm(directoryPath, { recursive: true, force: true })
    log?.(`Removed stale temp dir: ${entry.name}`)
  }
}

function buildTaskPrefix(task: DownloadTaskRow, step?: string): string {
  const base = `${task.exchange}/${task.symbol}/${task.date}`
  return step ? `${step} ${base}` : base
}

export async function processDownloadTask(
  task: DownloadTaskRow,
  options: ProcessTaskOptions = {}
): Promise<ProcessedTask> {
  const startedAtMs = Date.now()
  const log = options.onInfo
  const taskLabel = buildTaskPrefix(task, options.step)
  let tempDir: string | null = null
  let totalSizeBytes = 0

  try {
    await updateTaskStatus(task.exchange, task.symbol, task.date, 'downloading', { error_message: null })
    const downloader = getDownloader(task.exchange)

    await fs.mkdir(DOWNLOAD_TEMP_DIR, { recursive: true })
    tempDir = await fs.mkdtemp(path.join(DOWNLOAD_TEMP_DIR, `${task.exchange}-${task.symbol}-${task.date}-`))

    const date = parseTaskDate(task.date)
    const urls = await (downloader.listUrls?.(task.symbol, date, {
      onInfo: message => {
        log?.(`${taskLabel}: ${message}`)
      },
    }) ?? Promise.resolve(downloader.constructUrls(task.symbol, date)))
    log?.(`${taskLabel}: downloading ${String(urls.length)} file(s)`)

    const downloadResult = await downloadFiles(urls, tempDir, {
      maxRetries: DOWNLOAD_MAX_RETRIES,
      backoffBaseMs: DOWNLOAD_BACKOFF_BASE_MS,
      backoffMaxMs: DOWNLOAD_BACKOFF_MAX_MS,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      concurrency: DOWNLOAD_FILE_CONCURRENCY,
      skipNotFound: task.exchange === 'gateio',
      onInfo: message => {
        log?.(`${taskLabel}: ${message}`)
      },
    })

    totalSizeBytes = downloadResult.totalSizeBytes
    await updateTaskStatus(task.exchange, task.symbol, task.date, 'processing', {
      file_size_bytes: totalSizeBytes,
      error_message: null,
    })

    if (downloadResult.filePaths.length === 0) {
      throw new Error(`No downloaded file available for ${taskLabel}`)
    }

    let events: AsyncIterable<QuoteEvent>
    if (task.exchange === 'gateio') {
      events = parseGateMultiFile(downloadResult.filePaths)
    } else {
      const parser = getParser(downloader.parserKey)
      events = parseFilesInOrder(downloadResult.filePaths, filePath => parser.parse(filePath))
    }

    const context: QuoteAggregationContext = {
      exchange: task.exchange,
      symbol: task.symbol,
      sourceType: downloader.sourceType,
      confidenceScore: downloader.confidenceScore,
    }

    const candles = filterCandlesToTaskDate(aggregateQuoteEvents(events, context), task.date)

    await deleteOrderbooksByExchangeSymbolDate(task.exchange, task.symbol, task.date)
    const rowsWritten = await writeQuoteCandlesToClickHouse(candles)

    await updateTaskStatus(task.exchange, task.symbol, task.date, 'completed', {
      rows_written: rowsWritten,
      file_size_bytes: totalSizeBytes,
      error_message: null,
    })

    const durationMs = Date.now() - startedAtMs
    log?.(`${taskLabel}: completed ${String(rowsWritten)} rows in ${formatDurationMs(durationMs)}`)

    return {
      exchange: task.exchange,
      symbol: task.symbol,
      date: task.date,
      rowsWritten,
    }
  } catch (error: unknown) {
    const errorMessage = toErrorMessage(error)

    try {
      await updateTaskStatus(task.exchange, task.symbol, task.date, 'failed', {
        error_message: errorMessage,
        file_size_bytes: totalSizeBytes === 0 ? null : totalSizeBytes,
      })
    } catch (statusError: unknown) {
      log?.(`${taskLabel}: failed to update task status - ${toErrorMessage(statusError)}`)
    }

    const durationMs = Date.now() - startedAtMs
    log?.(`${taskLabel}: failed in ${formatDurationMs(durationMs)} - ${errorMessage}`)

    return {
      exchange: task.exchange,
      symbol: task.symbol,
      date: task.date,
      rowsWritten: 0,
      errorMessage,
    }
  } finally {
    try {
      await cleanupTaskTempDir(tempDir)
    } catch (cleanupError: unknown) {
      log?.(`${taskLabel}: temp cleanup warning - ${toErrorMessage(cleanupError)}`)
    }
  }
}

export async function syncQuotes(tasks: DownloadTaskRow[], options: SyncQuotesOptions = {}): Promise<ProcessedTask[]> {
  const log = options.onInfo

  try {
    await cleanupStaleTempDirs(log)
  } catch (error: unknown) {
    log?.(`Stale temp cleanup warning - ${toErrorMessage(error)}`)
  }

  if (tasks.length === 0) {
    return []
  }

  const startedAtMs = Date.now()
  const results: (ProcessedTask | undefined)[] = Array.from({ length: tasks.length })
  let nextIndex = 0

  const workerCount = Math.max(1, Math.min(DOWNLOAD_SYMBOL_CONCURRENCY, tasks.length))
  log?.(`Processing ${String(tasks.length)} download task(s) with concurrency=${String(workerCount)}`)

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const currentIndex = nextIndex
      nextIndex += 1

      if (currentIndex >= tasks.length) {
        return
      }

      const task = tasks[currentIndex]
      if (!task) {
        throw new Error(`Task missing for index ${String(currentIndex)}`)
      }

      const step = `[${String(currentIndex + 1)}/${String(tasks.length)}]`
      results[currentIndex] = await processDownloadTask(task, {
        ...(log ? { onInfo: log } : {}),
        step,
      })
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  const finalizedResults = results.map((result, index) => {
    if (!result) {
      throw new Error(`Task result was not produced for index ${String(index)}`)
    }

    return result
  })

  const failures = finalizedResults.filter(result => result.errorMessage !== undefined)
  const totalDurationMs = Date.now() - startedAtMs

  if (failures.length > 0) {
    log?.(
      `Finished ${String(tasks.length)} task(s) in ${formatDurationMs(totalDurationMs)} with ${String(failures.length)} failure(s)`
    )
  } else {
    log?.(`Finished ${String(tasks.length)} task(s) in ${formatDurationMs(totalDurationMs)}`)
  }

  return finalizedResults
}

export * from './types.js'
