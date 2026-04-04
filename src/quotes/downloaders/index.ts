import { binanceDownloader } from './binance.js'
import { bitgetDownloader } from './bitget.js'
import { bybitDownloader } from './bybit.js'
import { gateioDownloader } from './gateio.js'
import { kucoinDownloader } from './kucoin.js'
import { downloadFile, downloadFiles } from './download.js'
import { okxDownloader } from './okx.js'
import type { ExchangeDownloader } from './types.js'

const registry: Record<string, ExchangeDownloader> = {
  binance: binanceDownloader,
  okx: okxDownloader,
  bitget: bitgetDownloader,
  gateio: gateioDownloader,
  kucoin: kucoinDownloader,
  bybit: bybitDownloader,
}

export function getDownloader(exchange: string): ExchangeDownloader {
  const downloader = registry[exchange]
  if (!downloader) {
    throw new Error(`No downloader available for exchange: ${exchange}`)
  }

  return downloader
}

export { downloadFile, downloadFiles, registry as downloaderRegistry }
export type { DownloadResult, ExchangeDownloader } from './types.js'
