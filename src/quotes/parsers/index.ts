import type { QuoteParser } from '../types.js'
import { binanceTradesParser } from './binance-trades.js'
import { bitgetTradesParser } from './bitget-trades.js'
import { bybitOrderbookParser } from './bybit-orderbook.js'
import { gateOrderbookParser } from './gate-orderbook.js'
import { kucoinOrderbookParser } from './kucoin-orderbook.js'
import { okxOrderbookParser } from './okx-orderbook.js'

export type ParserKey =
  | 'binance-trades'
  | 'bitget-trades'
  | 'bybit-orderbook'
  | 'gate-orderbook'
  | 'kucoin-orderbook'
  | 'okx-orderbook'

const parserRegistry: Record<ParserKey, QuoteParser> = {
  'binance-trades': binanceTradesParser,
  'bitget-trades': bitgetTradesParser,
  'bybit-orderbook': bybitOrderbookParser,
  'gate-orderbook': gateOrderbookParser,
  'kucoin-orderbook': kucoinOrderbookParser,
  'okx-orderbook': okxOrderbookParser,
}

export function getParser(parserKey: ParserKey): QuoteParser {
  return parserRegistry[parserKey]
}

export { parserRegistry }
