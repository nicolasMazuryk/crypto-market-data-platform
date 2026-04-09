import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DownloadTaskRow } from '../../db/types.js'
import type { ProcessedTask } from '../../quotes/types.js'

interface SyncQuotesOptions {
  onInfo?: (message: string) => void
}

const listPendingTasksMock = vi.hoisted(() => vi.fn<() => Promise<DownloadTaskRow[]>>())
const resetStaleTasksMock = vi.hoisted(() => vi.fn<() => Promise<number>>())
const syncQuotesMock = vi.hoisted(() =>
  vi.fn<(tasks: DownloadTaskRow[], options?: SyncQuotesOptions) => Promise<ProcessedTask[]>>()
)

vi.mock('../../db/queries/downloadTasks.js', () => ({
  listPendingTasks: listPendingTasksMock,
  resetStaleTasks: resetStaleTasksMock,
}))

vi.mock('../../quotes/index.js', () => ({
  syncQuotes: syncQuotesMock,
}))

interface SyncQuotesModule {
  runSyncQuotes: () => Promise<void>
}

async function loadModule(): Promise<SyncQuotesModule> {
  vi.resetModules()
  return import('../sync-quotes.js')
}

function sampleTask(): DownloadTaskRow {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    date: '2026-01-01',
    status: 'pending',
    error_message: null,
    file_size_bytes: null,
    rows_written: null,
    quality_score: null,
  }
}

describe('sync-quotes script', () => {
  let originalExitCode: typeof process.exitCode
  let originalWorkerIndex: string | undefined
  let originalWorkerCount: string | undefined

  beforeEach(() => {
    originalExitCode = process.exitCode
    originalWorkerIndex = process.env.WORKER_INDEX
    originalWorkerCount = process.env.WORKER_COUNT
    process.exitCode = undefined
    process.env.WORKER_INDEX = '0'
    process.env.WORKER_COUNT = '1'
    listPendingTasksMock.mockReset()
    resetStaleTasksMock.mockReset()
    resetStaleTasksMock.mockResolvedValue(0)
    syncQuotesMock.mockReset()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    if (originalWorkerIndex === undefined) {
      delete process.env.WORKER_INDEX
    } else {
      process.env.WORKER_INDEX = originalWorkerIndex
    }

    if (originalWorkerCount === undefined) {
      delete process.env.WORKER_COUNT
    } else {
      process.env.WORKER_COUNT = originalWorkerCount
    }

    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('runs quote sync successfully for a worker shard', async () => {
    const tasks = [sampleTask()]
    listPendingTasksMock.mockResolvedValue(tasks)
    syncQuotesMock.mockResolvedValue([
      {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        date: '2026-01-01',
        rowsWritten: 42,
      },
    ])

    const { runSyncQuotes } = await loadModule()
    await runSyncQuotes()

    expect(syncQuotesMock).toHaveBeenCalledTimes(1)
    const firstCall = syncQuotesMock.mock.calls[0]
    if (!firstCall) {
      throw new Error('Expected syncQuotes to be called once')
    }

    expect(firstCall[0]).toEqual(tasks)
    expect(typeof firstCall[1]?.onInfo).toBe('function')
  })

  it('runs the same sync path on non-primary workers', async () => {
    process.env.WORKER_INDEX = '1'
    process.env.WORKER_COUNT = '2'

    const tasks = [sampleTask()]
    listPendingTasksMock.mockResolvedValue(tasks)
    syncQuotesMock.mockResolvedValue([
      {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        date: '2026-01-01',
        rowsWritten: 42,
      },
    ])

    const { runSyncQuotes } = await loadModule()
    await runSyncQuotes()

    expect(syncQuotesMock).toHaveBeenCalledTimes(1)
  })

  it('rethrows the original sync error', async () => {
    const tasks = [sampleTask()]
    const syncError = new Error('sync failed')

    listPendingTasksMock.mockResolvedValue(tasks)
    syncQuotesMock.mockRejectedValue(syncError)

    const { runSyncQuotes } = await loadModule()
    await expect(runSyncQuotes()).rejects.toThrow('sync failed')
  })
})
