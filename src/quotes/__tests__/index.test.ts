import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DownloadTaskRow } from '../../db/types.js'
import type { QuoteCandle1s, QuoteEvent } from '../types.js'

const downloadFilesMock = vi.hoisted(() => vi.fn())
const getDownloaderMock = vi.hoisted(() => vi.fn())
const getParserMock = vi.hoisted(() => vi.fn())
const parseGateMultiFileMock = vi.hoisted(() => vi.fn())
const aggregateQuoteEventsMock = vi.hoisted(() => vi.fn())
const writeQuoteCandlesToClickHouseMock = vi.hoisted(() => vi.fn())
const updateTaskStatusMock = vi.hoisted(() => vi.fn())
const deleteOrderbooksByExchangeSymbolDateMock = vi.hoisted(() => vi.fn())

vi.mock('../downloaders/index.js', () => ({
  downloadFiles: downloadFilesMock,
  getDownloader: getDownloaderMock,
}))

vi.mock('../parsers/index.js', () => ({
  getParser: getParserMock,
}))

vi.mock('../parsers/gate-orderbook-multi.js', () => ({
  parseGateMultiFile: parseGateMultiFileMock,
}))

vi.mock('../aggregator/index.js', () => ({
  aggregateQuoteEvents: aggregateQuoteEventsMock,
}))

vi.mock('../writer/index.js', () => ({
  writeQuoteCandlesToClickHouse: writeQuoteCandlesToClickHouseMock,
}))

vi.mock('../../db/queries/downloadTasks.js', () => ({
  updateTaskStatus: updateTaskStatusMock,
}))

vi.mock('../../db/queries/orderbooks.js', () => ({
  deleteOrderbooksByExchangeSymbolDate: deleteOrderbooksByExchangeSymbolDateMock,
}))

const originalDownloadTempDir = process.env.DOWNLOAD_TEMP_DIR
const DEFAULT_TASK_TS = Date.parse('2026-01-01T00:00:00.000Z') / 1000

async function* asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve()
    yield item
  }
}

function sampleTask(overrides: Partial<DownloadTaskRow> = {}): DownloadTaskRow {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    date: '2026-01-01',
    status: 'pending',
    error_message: null,
    file_size_bytes: null,
    rows_written: null,
    quality_score: null,
    ...overrides,
  }
}

async function loadQuotesModule(downloadTempDir: string) {
  process.env.DOWNLOAD_TEMP_DIR = downloadTempDir
  vi.resetModules()
  return import('../index.js')
}

describe('quotes index pipeline', () => {
  const tmpDirs: string[] = []

  beforeEach(() => {
    downloadFilesMock.mockReset()
    getDownloaderMock.mockReset()
    getParserMock.mockReset()
    parseGateMultiFileMock.mockReset()
    aggregateQuoteEventsMock.mockReset()
    writeQuoteCandlesToClickHouseMock.mockReset()
    updateTaskStatusMock.mockReset()
    deleteOrderbooksByExchangeSymbolDateMock.mockReset()

    const parserEvents: QuoteEvent[] = [
      { timestampMs: 1_000, bid: 10, ask: 11, sourceType: 'trades' },
      { timestampMs: 2_000, bid: 10.2, ask: 11.1, sourceType: 'trades' },
    ]

    const candles: QuoteCandle1s[] = [
      {
        ts: DEFAULT_TASK_TS,
        exchange: 'binance',
        symbol: 'BTCUSDT',
        bidOpen: 10,
        bidHigh: 10,
        bidLow: 10,
        bidClose: 10,
        askOpen: 11,
        askHigh: 11,
        askLow: 11,
        askClose: 11,
        sourceType: 'trades',
        isInterpolated: false,
        confidenceScore: 'low',
        missingReason: null,
      },
    ]

    getDownloaderMock.mockReturnValue({
      exchange: 'binance',
      parserKey: 'binance-trades',
      sourceType: 'trades',
      confidenceScore: 'low',
      constructUrls: () => ['https://example.com/file.zip'],
      toUrlSymbol: (symbol: string) => symbol,
    })

    downloadFilesMock.mockResolvedValue({
      filePaths: ['/tmp/file.zip'],
      totalSizeBytes: 123,
    })

    getParserMock.mockReturnValue({
      parse: () => asAsyncIterable(parserEvents),
    })

    parseGateMultiFileMock.mockReturnValue(asAsyncIterable(parserEvents))

    aggregateQuoteEventsMock.mockReturnValue(asAsyncIterable(candles))
    writeQuoteCandlesToClickHouseMock.mockResolvedValue(1)
    updateTaskStatusMock.mockResolvedValue(undefined)
    deleteOrderbooksByExchangeSymbolDateMock.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true })
    }

    tmpDirs.length = 0

    if (originalDownloadTempDir === undefined) {
      delete process.env.DOWNLOAD_TEMP_DIR
    } else {
      process.env.DOWNLOAD_TEMP_DIR = originalDownloadTempDir
    }

    vi.resetModules()
  })

  it('processes a task end-to-end and updates status transitions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quotes-index-'))
    tmpDirs.push(tempDir)

    const { processDownloadTask } = await loadQuotesModule(tempDir)
    const result = await processDownloadTask(sampleTask())

    expect(result).toEqual({
      exchange: 'binance',
      symbol: 'BTCUSDT',
      date: '2026-01-01',
      rowsWritten: 1,
    })

    expect(updateTaskStatusMock).toHaveBeenCalledWith('binance', 'BTCUSDT', '2026-01-01', 'downloading', {
      error_message: null,
    })
    expect(updateTaskStatusMock).toHaveBeenCalledWith('binance', 'BTCUSDT', '2026-01-01', 'processing', {
      file_size_bytes: 123,
      error_message: null,
    })
    expect(updateTaskStatusMock).toHaveBeenCalledWith('binance', 'BTCUSDT', '2026-01-01', 'completed', {
      rows_written: 1,
      file_size_bytes: 123,
      error_message: null,
    })
    expect(downloadFilesMock).toHaveBeenCalledWith(
      ['https://example.com/file.zip'],
      expect.any(String),
      expect.objectContaining({ skipNotFound: false })
    )
    expect(deleteOrderbooksByExchangeSymbolDateMock).toHaveBeenCalledWith('binance', 'BTCUSDT', '2026-01-01')
    expect(writeQuoteCandlesToClickHouseMock).toHaveBeenCalledTimes(1)
  })

  it('filters candles outside the requested UTC task day before writing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quotes-index-day-filter-'))
    tmpDirs.push(tempDir)

    const previousDayTs = Date.parse('2025-12-31T23:59:59.000Z') / 1000
    const inDayTs = Date.parse('2026-01-01T00:00:00.000Z') / 1000
    const nextDayTs = Date.parse('2026-01-02T00:00:00.000Z') / 1000

    aggregateQuoteEventsMock.mockReturnValueOnce(
      asAsyncIterable<QuoteCandle1s>([
        {
          ts: previousDayTs,
          exchange: 'binance',
          symbol: 'BTCUSDT',
          bidOpen: 1,
          bidHigh: 1,
          bidLow: 1,
          bidClose: 1,
          askOpen: 2,
          askHigh: 2,
          askLow: 2,
          askClose: 2,
          sourceType: 'trades',
          isInterpolated: false,
          confidenceScore: 'low',
          missingReason: null,
        },
        {
          ts: inDayTs,
          exchange: 'binance',
          symbol: 'BTCUSDT',
          bidOpen: 3,
          bidHigh: 3,
          bidLow: 3,
          bidClose: 3,
          askOpen: 4,
          askHigh: 4,
          askLow: 4,
          askClose: 4,
          sourceType: 'trades',
          isInterpolated: false,
          confidenceScore: 'low',
          missingReason: null,
        },
        {
          ts: nextDayTs,
          exchange: 'binance',
          symbol: 'BTCUSDT',
          bidOpen: 5,
          bidHigh: 5,
          bidLow: 5,
          bidClose: 5,
          askOpen: 6,
          askHigh: 6,
          askLow: 6,
          askClose: 6,
          sourceType: 'trades',
          isInterpolated: false,
          confidenceScore: 'low',
          missingReason: null,
        },
      ])
    )

    writeQuoteCandlesToClickHouseMock.mockImplementationOnce(async (candles: AsyncIterable<QuoteCandle1s>) => {
      let count = 0
      for await (const candle of candles) {
        void candle
        count += 1
      }

      return count
    })

    const { processDownloadTask } = await loadQuotesModule(tempDir)
    const result = await processDownloadTask(sampleTask())

    expect(result.rowsWritten).toBe(1)
    expect(updateTaskStatusMock).toHaveBeenCalledWith('binance', 'BTCUSDT', '2026-01-01', 'completed', {
      rows_written: 1,
      file_size_bytes: 123,
      error_message: null,
    })
  })

  it('marks task failed when download throws', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quotes-index-error-'))
    tmpDirs.push(tempDir)

    downloadFilesMock.mockRejectedValueOnce(new Error('download failed'))

    const { processDownloadTask } = await loadQuotesModule(tempDir)
    const result = await processDownloadTask(sampleTask())

    expect(result.errorMessage).toContain('download failed')
    expect(result.rowsWritten).toBe(0)
    expect(updateTaskStatusMock).toHaveBeenCalledWith('binance', 'BTCUSDT', '2026-01-01', 'failed', {
      error_message: 'download failed',
      file_size_bytes: null,
    })
  })

  it('uses gate multi-file parser for gateio tasks', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quotes-index-gate-'))
    tmpDirs.push(tempDir)

    getDownloaderMock.mockReturnValueOnce({
      exchange: 'gateio',
      parserKey: 'gate-orderbook',
      sourceType: 'orderbook',
      confidenceScore: 'high',
      constructUrls: () => ['https://example.com/h00.csv.gz', 'https://example.com/h01.csv.gz'],
      toUrlSymbol: (symbol: string) => symbol,
    })

    downloadFilesMock.mockResolvedValueOnce({
      filePaths: ['/tmp/h00.csv.gz', '/tmp/h01.csv.gz'],
      totalSizeBytes: 250,
    })

    const { processDownloadTask } = await loadQuotesModule(tempDir)
    await processDownloadTask(sampleTask({ exchange: 'gateio', symbol: 'BTCUSDT' }))

    expect(downloadFilesMock).toHaveBeenCalledWith(
      ['https://example.com/h00.csv.gz', 'https://example.com/h01.csv.gz'],
      expect.any(String),
      expect.objectContaining({ skipNotFound: true })
    )
    expect(parseGateMultiFileMock).toHaveBeenCalledWith(['/tmp/h00.csv.gz', '/tmp/h01.csv.gz'])
    expect(getParserMock).not.toHaveBeenCalled()
  })

  it('cleans temporary task directories after failures', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quotes-index-cleanup-'))
    tmpDirs.push(tempDir)

    downloadFilesMock.mockRejectedValueOnce(new Error('download failed'))

    const { processDownloadTask } = await loadQuotesModule(tempDir)
    await processDownloadTask(sampleTask())

    const entries = await fs.readdir(tempDir)
    expect(entries).toHaveLength(0)
  })

  it('syncQuotes returns one result per task', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quotes-index-build-'))
    tmpDirs.push(tempDir)

    const { syncQuotes } = await loadQuotesModule(tempDir)
    const results = await syncQuotes([
      sampleTask({ symbol: 'BTCUSDT' }),
      sampleTask({ symbol: 'ETHUSDT', date: '2026-01-02' }),
    ])

    expect(results).toHaveLength(2)
    expect(results[0]?.symbol).toBe('BTCUSDT')
    expect(results[1]?.symbol).toBe('ETHUSDT')
  })
})
