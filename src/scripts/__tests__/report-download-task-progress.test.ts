import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listExchangeTaskProgressMock = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>())

vi.mock('../../db/queries/downloadTasks.js', () => ({
  listExchangeTaskProgress: listExchangeTaskProgressMock,
}))

interface ReportDownloadTaskProgressModule {
  runReportDownloadTaskProgress: () => Promise<void>
}

async function loadModule(): Promise<ReportDownloadTaskProgressModule> {
  vi.resetModules()
  return import('../report-download-task-progress.js')
}

describe('report-download-task-progress script', () => {
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
    process.exitCode = undefined
    listExchangeTaskProgressMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('prints the exchange progress report as JSON', async () => {
    listExchangeTaskProgressMock.mockResolvedValue([
      {
        exchange: 'binance',
        completed_tasks: 1,
        pending_tasks: 2,
        failed_tasks: 0,
        error_breakdown: [],
      },
    ])

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { runReportDownloadTaskProgress } = await loadModule()
    await runReportDownloadTaskProgress()

    expect(listExchangeTaskProgressMock).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        [
          {
            exchange: 'binance',
            completed_tasks: 1,
            pending_tasks: 2,
            failed_tasks: 0,
            error_breakdown: [],
          },
        ],
        null,
        2
      )
    )
  })

  it('propagates query failures', async () => {
    listExchangeTaskProgressMock.mockRejectedValue(new Error('query failed'))

    const { runReportDownloadTaskProgress } = await loadModule()
    await expect(runReportDownloadTaskProgress()).rejects.toThrow('query failed')
  })
})
