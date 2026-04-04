import { describe, expect, it } from 'vitest'

import { binanceDownloader } from '../downloaders/binance.js'
import { bitgetDownloader } from '../downloaders/bitget.js'
import { bybitDownloader } from '../downloaders/bybit.js'
import { gateioDownloader } from '../downloaders/gateio.js'
import { getDownloader } from '../downloaders/index.js'
import { kucoinDownloader } from '../downloaders/kucoin.js'
import { okxDownloader } from '../downloaders/okx.js'

describe('quote downloaders', () => {
  const date = new Date('2026-01-02T00:00:00.000Z')

  it('builds expected binance URL', () => {
    expect(binanceDownloader.constructUrls('BTCUSDT', date)).toEqual([
      'https://data.binance.vision/data/futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-01-02.zip',
    ])
  })

  it('builds expected okx URL and symbol mapping', () => {
    expect(okxDownloader.toUrlSymbol('BTCUSDT')).toBe('BTC-USDT-SWAP')
    expect(okxDownloader.constructUrls('BTCUSDT', date)).toEqual([
      'https://static.okx.com/cdn/okx/match/orderbook/L2/400lv/daily/20260102/BTC-USDT-SWAP-L2orderbook-400lv-2026-01-02.tar.gz',
    ])
  })

  it('builds expected bitget URLs for UTC day stitching', () => {
    expect(bitgetDownloader.constructUrls('BTCUSDT', date)).toEqual([
      'https://img.bitgetimg.com/online/depth/BTCUSDT/2/20260102.zip',
      'https://img.bitgetimg.com/online/depth/BTCUSDT/2/20260103.zip',
    ])
  })

  it('builds 24 hourly gate URLs with expected mapping', () => {
    expect(gateioDownloader.toUrlSymbol('BTCUSDT')).toBe('BTC_USDT')
    const urls = gateioDownloader.constructUrls('BTCUSDT', date)

    expect(urls).toHaveLength(24)
    expect(urls[0]).toBe('https://download.gatedata.org/futures_usdt/orderbooks/202601/BTC_USDT-2026010200.csv.gz')
    expect(urls[23]).toBe('https://download.gatedata.org/futures_usdt/orderbooks/202601/BTC_USDT-2026010223.csv.gz')
  })

  it('builds expected kucoin URL and symbol mapping', () => {
    expect(kucoinDownloader.toUrlSymbol('BTCUSDT')).toBe('BTCUSDTM')
    expect(kucoinDownloader.constructUrls('BTCUSDT', date)).toEqual([
      'https://historical-data.kucoin.com/data/futures/daily/depth/orderbooklv50/BTCUSDTM/BTCUSDTM-orderbooklv50-2026-01-02.zip',
    ])
  })

  it('builds expected bybit URL', () => {
    expect(bybitDownloader.constructUrls('BTCUSDT', date)).toEqual([
      'https://quote-saver.bycsi.com/orderbook/linear/BTCUSDT/2026-01-02_BTCUSDT_ob200.data.zip',
    ])
  })

  it('resolves downloader registry entries', () => {
    expect(getDownloader('gateio').exchange).toBe('gateio')
    expect(getDownloader('binance').parserKey).toBe('binance-trades')
    expect(() => getDownloader('mexc')).toThrow('No downloader available for exchange: mexc')
  })
})
