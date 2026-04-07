import { deleteDownloadTasksByExchange } from './queries/downloadTasks.js'
import { deleteFundingRatesByExchange } from './queries/fundingRates.js'
import { deleteMarketsByExchange } from './queries/markets.js'
import { deleteOrderbooksByExchange } from './queries/orderbooks.js'

export type ClickHouseFixtureTable = 'download_tasks' | 'funding_rates' | 'markets' | 'orderbooks'

export interface ClickHouseFixtureCleanupRegistry {
  track(table: ClickHouseFixtureTable, exchange: string): void
  cleanup(): Promise<void>
}

const CLEANUP_ORDER: ClickHouseFixtureTable[] = ['download_tasks', 'funding_rates', 'markets', 'orderbooks']

const CLEANUP_HANDLERS: Record<ClickHouseFixtureTable, (exchange: string) => Promise<void>> = {
  download_tasks: deleteDownloadTasksByExchange,
  funding_rates: deleteFundingRatesByExchange,
  markets: deleteMarketsByExchange,
  orderbooks: deleteOrderbooksByExchange,
}

export function createClickHouseFixtureCleanupRegistry(): ClickHouseFixtureCleanupRegistry {
  const tracked = new Map<ClickHouseFixtureTable, Set<string>>()

  return {
    track(table, exchange) {
      const exchanges = tracked.get(table) ?? new Set<string>()
      exchanges.add(exchange)
      tracked.set(table, exchanges)
    },
    async cleanup() {
      const errors: Error[] = []

      for (const table of CLEANUP_ORDER) {
        const exchanges = tracked.get(table)
        if (!exchanges || exchanges.size === 0) {
          continue
        }

        for (const exchange of Array.from(exchanges)) {
          try {
            await CLEANUP_HANDLERS[table](exchange)
            exchanges.delete(exchange)
          } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)))
          }
        }

        if (exchanges.size === 0) {
          tracked.delete(table)
        }
      }

      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to clean ClickHouse fixtures')
      }
    },
  }
}
