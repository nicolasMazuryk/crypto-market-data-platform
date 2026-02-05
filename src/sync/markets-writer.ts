import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { MARKETS_OUTPUT_DIR } from '../config/index.js'
import type { ExchangeName, Market } from '../exchanges/types.js'

export interface MarketSnapshot {
  exchange: ExchangeName
  symbol: string
  exchange_symbol: string
  type: 'perpetual'
  listing_date: string | null
  delisting_date: string | null
  is_active: boolean
}

function serializeMarket(market: Market): MarketSnapshot {
  return {
    exchange: market.exchange,
    symbol: market.symbol,
    exchange_symbol: market.exchange_symbol,
    type: market.type,
    listing_date: market.listing_date ? market.listing_date.toISOString() : null,
    delisting_date: market.delisting_date
      ? market.delisting_date.toISOString()
      : null,
    is_active: market.is_active
  }
}

function compareSnapshots(a: MarketSnapshot, b: MarketSnapshot): number {
  const symbolCompare = a.symbol.localeCompare(b.symbol)
  if (symbolCompare !== 0) {
    return symbolCompare
  }

  return a.exchange_symbol.localeCompare(b.exchange_symbol)
}

export async function writeMarketsForExchange(
  exchange: ExchangeName,
  markets: Market[],
  outputDir: string = MARKETS_OUTPUT_DIR
): Promise<string> {
  const outputPath = path.resolve(process.cwd(), outputDir)
  await mkdir(outputPath, { recursive: true })

  const snapshots = markets.map(serializeMarket).sort(compareSnapshots)
  const filePath = path.join(outputPath, `${exchange}.json`)

  await writeFile(filePath, JSON.stringify(snapshots, null, 2))

  return filePath
}

export async function writeMarketsSnapshot(
  markets: Market[],
  outputDir: string = MARKETS_OUTPUT_DIR
): Promise<string[]> {
  const grouped = new Map<ExchangeName, Market[]>()

  for (const market of markets) {
    const current = grouped.get(market.exchange)
    if (current) {
      current.push(market)
    } else {
      grouped.set(market.exchange, [market])
    }
  }

  const tasks = Array.from(grouped.entries()).map(([exchange, list]) => {
    return writeMarketsForExchange(exchange, list, outputDir)
  })

  return Promise.all(tasks)
}
