import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DownloadTaskRow } from '../../db/types.js'
import type { ProcessedTask } from '../../quotes/types.js'

interface SyncQuotesOptions {
  onInfo?: (message: string) => void
}

const listPendingTasksMock = vi.hoisted(() => vi.fn<() => Promise<DownloadTaskRow[]>>())
const optimizeDownloadTasksTableMock = vi.hoisted(() => vi.fn<() => Promise<void>>())
const resetStaleTasksMock = vi.hoisted(() => vi.fn<() => Promise<number>>())
const syncQuotesMock = vi.hoisted(() =>
  vi.fn<(tasks: DownloadTaskRow[], options?: SyncQuotesOptions) => Promise<ProcessedTask[]>>()
)

vi.mock('../../db/queries/downloadTasks.js', () => ({
  listPendingTasks: listPendingTasksMock,
  optimizeDownloadTasksTable: optimizeDownloadTasksTableMock,
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

  beforeEach(() => {
    originalExitCode = process.exitCode
    process.exitCode = undefined
    listPendingTasksMock.mockReset()
    optimizeDownloadTasksTableMock.mockReset()
    resetStaleTasksMock.mockReset()
    resetStaleTasksMock.mockResolvedValue(0)
    syncQuotesMock.mockReset()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('compacts download_tasks after a successful sync run', async () => {
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
    optimizeDownloadTasksTableMock.mockResolvedValue(undefined)

    const { runSyncQuotes } = await loadModule()
    await runSyncQuotes()

    expect(syncQuotesMock).toHaveBeenCalledTimes(1)
    const firstCall = syncQuotesMock.mock.calls[0]
    if (!firstCall) {
      throw new Error('Expected syncQuotes to be called once')
    }

    expect(firstCall[0]).toEqual(tasks)
    expect(typeof firstCall[1]?.onInfo).toBe('function')
    expect(optimizeDownloadTasksTableMock).toHaveBeenCalledTimes(1)
  })

  it('still compacts download_tasks when sync throws and rethrows the original error', async () => {
    const tasks = [sampleTask()]
    const syncError = new Error('sync failed')

    listPendingTasksMock.mockResolvedValue(tasks)
    syncQuotesMock.mockRejectedValue(syncError)
    optimizeDownloadTasksTableMock.mockResolvedValue(undefined)

    const { runSyncQuotes } = await loadModule()
    await expect(runSyncQuotes()).rejects.toThrow('sync failed')
    expect(optimizeDownloadTasksTableMock).toHaveBeenCalledTimes(1)
  })

  it('fails the run when download_tasks compaction fails', async () => {
    const tasks = [sampleTask()]
    listPendingTasksMock.mockResolvedValue(tasks)
    syncQuotesMock.mockResolvedValue([
      {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        date: '2026-01-01',
        rowsWritten: 1,
      },
    ])
    optimizeDownloadTasksTableMock.mockRejectedValue(new Error('optimize failed'))

    const { runSyncQuotes } = await loadModule()
    await expect(runSyncQuotes()).rejects.toThrow('optimize failed')
    expect(process.exitCode).toBe(1)
  })
})
