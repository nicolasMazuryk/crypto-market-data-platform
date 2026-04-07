import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../queries/downloadTasks.js', () => ({
  deleteDownloadTasksByExchange: vi.fn(),
}))

vi.mock('../queries/fundingRates.js', () => ({
  deleteFundingRatesByExchange: vi.fn(),
}))

vi.mock('../queries/markets.js', () => ({
  deleteMarketsByExchange: vi.fn(),
}))

vi.mock('../queries/orderbooks.js', () => ({
  deleteOrderbooksByExchange: vi.fn(),
}))

import { createClickHouseFixtureCleanupRegistry } from '../fixtureCleanup.js'
import { deleteDownloadTasksByExchange } from '../queries/downloadTasks.js'
import { deleteFundingRatesByExchange } from '../queries/fundingRates.js'
import { deleteMarketsByExchange } from '../queries/markets.js'
import { deleteOrderbooksByExchange } from '../queries/orderbooks.js'

describe('createClickHouseFixtureCleanupRegistry', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('deduplicates tracked table and exchange pairs and cleans in deterministic order', async () => {
    const calls: string[] = []

    vi.mocked(deleteDownloadTasksByExchange).mockImplementation(async exchange => {
      calls.push(`download_tasks:${exchange}`)
    })
    vi.mocked(deleteFundingRatesByExchange).mockImplementation(async exchange => {
      calls.push(`funding_rates:${exchange}`)
    })
    vi.mocked(deleteMarketsByExchange).mockImplementation(async exchange => {
      calls.push(`markets:${exchange}`)
    })
    vi.mocked(deleteOrderbooksByExchange).mockImplementation(async exchange => {
      calls.push(`orderbooks:${exchange}`)
    })

    const registry = createClickHouseFixtureCleanupRegistry()
    registry.track('markets', 'exchange-b')
    registry.track('download_tasks', 'exchange-a')
    registry.track('download_tasks', 'exchange-a')
    registry.track('funding_rates', 'exchange-c')
    registry.track('orderbooks', 'exchange-d')

    await registry.cleanup()

    expect(calls).toEqual([
      'download_tasks:exchange-a',
      'funding_rates:exchange-c',
      'markets:exchange-b',
      'orderbooks:exchange-d',
    ])
    expect(deleteDownloadTasksByExchange).toHaveBeenCalledTimes(1)
  })

  it('is a no-op on repeated cleanup after success', async () => {
    const registry = createClickHouseFixtureCleanupRegistry()
    registry.track('markets', 'exchange-a')

    await registry.cleanup()
    await registry.cleanup()

    expect(deleteMarketsByExchange).toHaveBeenCalledTimes(1)
  })

  it('continues cleanup across failures and throws AggregateError', async () => {
    vi.mocked(deleteDownloadTasksByExchange).mockRejectedValueOnce(new Error('download task cleanup failed'))

    const registry = createClickHouseFixtureCleanupRegistry()
    registry.track('download_tasks', 'exchange-a')
    registry.track('funding_rates', 'exchange-b')
    registry.track('markets', 'exchange-c')

    let thrown: unknown
    try {
      await registry.cleanup()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    const aggregate = thrown as AggregateError
    expect(aggregate.errors).toHaveLength(1)
    expect(deleteFundingRatesByExchange).toHaveBeenCalledWith('exchange-b')
    expect(deleteMarketsByExchange).toHaveBeenCalledWith('exchange-c')

    await registry.cleanup()

    expect(deleteDownloadTasksByExchange).toHaveBeenCalledTimes(2)
    expect(deleteFundingRatesByExchange).toHaveBeenCalledTimes(1)
    expect(deleteMarketsByExchange).toHaveBeenCalledTimes(1)
  })
})
