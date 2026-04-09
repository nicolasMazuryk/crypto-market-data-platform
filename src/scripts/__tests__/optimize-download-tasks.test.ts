import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const optimizeDownloadTasksTableMock = vi.hoisted(() => vi.fn<() => Promise<void>>())

vi.mock('../../db/queries/downloadTasks.js', () => ({
  optimizeDownloadTasksTable: optimizeDownloadTasksTableMock,
}))

interface OptimizeDownloadTasksModule {
  runOptimizeDownloadTasks: () => Promise<void>
}

async function loadModule(): Promise<OptimizeDownloadTasksModule> {
  vi.resetModules()
  return import('../optimize-download-tasks.js')
}

describe('optimize-download-tasks script', () => {
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
    process.exitCode = undefined
    optimizeDownloadTasksTableMock.mockReset()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('compacts download_tasks successfully', async () => {
    optimizeDownloadTasksTableMock.mockResolvedValue(undefined)

    const { runOptimizeDownloadTasks } = await loadModule()
    await runOptimizeDownloadTasks()

    expect(optimizeDownloadTasksTableMock).toHaveBeenCalledTimes(1)
  })

  it('propagates compaction failures', async () => {
    optimizeDownloadTasksTableMock.mockRejectedValue(new Error('optimize failed'))

    const { runOptimizeDownloadTasks } = await loadModule()
    await expect(runOptimizeDownloadTasks()).rejects.toThrow('optimize failed')
  })
})
