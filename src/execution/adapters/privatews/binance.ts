import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { ExchangePrivateWsAdapter } from './types.js'
import {
  createPrivateWsAdapterFromSpec,
  makeTypedEmitter,
  type PrivateWsAdapterOptions,
  type PrivateWsAdapterSpec,
  type PrivateWsClient,
  type PrivateWsClientEvents,
} from './private-ws-base.js'
import { createBinanceWsClient } from './binance-client.js'
import type { BinanceWsClientFactory } from './binance-client.js'
import type { BinanceAccountUpdateRaw, BinanceOrderUpdateRaw } from './mapping.js'
import { mapAccountUpdate, mapFillFromOrderTradeUpdate, mapFundingFee, mapOrderTradeUpdate } from './mapping.js'
import { FundingRateCache } from './funding-rate-cache.js'

export interface BinancePrivateWsAdapterOptions extends PrivateWsAdapterOptions {
  wsClientFactory?: BinanceWsClientFactory
}

interface BinanceRaw {
  e: string
  E: number
  [key: string]: unknown
}

function wrapBinanceClient(inner: ReturnType<typeof createBinanceWsClient>): PrivateWsClient {
  const ev = makeTypedEmitter<PrivateWsClientEvents>()
  inner.events.on('close', reason => {
    ev.emit('close', reason)
  })
  inner.events.on('error', err => {
    ev.emit('error', err)
  })
  inner.events.on('message', msg => {
    ev.emit('message', msg as unknown)
  })
  inner.events.on('listenKeyExpired', () => {
    ev.emit('authExpired')
  })
  return {
    connect: () => inner.connect(),
    disconnect: () => inner.disconnect(),
    events: ev,
  }
}

export function createBinancePrivateWsAdapter(opts: BinancePrivateWsAdapterOptions): ExchangePrivateWsAdapter {
  const rateCache = new FundingRateCache()

  const parseBinanceMessage = (raw: BinanceRaw, receivedAt: number, seq: number) => {
    // Binance USDM user data stream may push MARK_PRICE_UPDATE events for held positions.
    // Cache the funding rate for stamping on subsequent FUNDING_FEE ACCOUNT_UPDATE events.
    // These carry 'r' (funding rate) and 'T' (next funding time); cache them for stamping.
    if (raw.e === 'MARK_PRICE_UPDATE') {
      const symbol = String(raw['s'] ?? '')
      const rate = parseFloat(String(raw['r'] ?? '0'))
      const nextFundingTime = typeof raw['T'] === 'number' ? raw['T'] : 0
      if (symbol && rate !== 0 && nextFundingTime > 0) {
        rateCache.set(symbol, rate, nextFundingTime)
      }
      return { eventType: raw.e, eventTimestampMs: raw.E }
    }
    if (raw.e === 'ORDER_TRADE_UPDATE') {
      const binanceRaw = raw as unknown as BinanceOrderUpdateRaw
      const orderEv = mapOrderTradeUpdate(binanceRaw, receivedAt, seq)
      const fillEv = mapFillFromOrderTradeUpdate(binanceRaw, receivedAt)
      return {
        orders: [orderEv],
        ...(fillEv ? { fills: [fillEv] } : {}),
        eventType: raw.e,
        eventTimestampMs: raw.E,
      }
    }
    if (raw.e === 'ACCOUNT_UPDATE') {
      const acctRaw = raw as unknown as BinanceAccountUpdateRaw
      const { balances, positions } = mapAccountUpdate(acctRaw, receivedAt, seq)
      const fee = mapFundingFee(acctRaw, receivedAt, seq, 'binance', rateCache)
      return {
        balances,
        positions,
        fundingFees: fee ? [fee] : undefined,
        eventType: raw.e,
        eventTimestampMs: raw.E,
      }
    }
    return { eventType: raw.e, eventTimestampMs: raw.E }
  }

  const wsClientFactory = opts.wsClientFactory
  const createClientFn: PrivateWsAdapterSpec<BinanceRaw>['createClient'] = wsClientFactory
    ? () => wrapBinanceClient(wsClientFactory())
    : (config: ExchangeConfig & { credentials?: ExchangeCredentials }) => {
        const clientOpts: Parameters<typeof createBinanceWsClient>[0] = {}
        if (config.credentials) clientOpts.credentials = config.credentials
        if (config.privateWsUrl) clientOpts.wsBaseUrl = config.privateWsUrl
        return wrapBinanceClient(createBinanceWsClient(clientOpts))
      }

  const binanceSpec: PrivateWsAdapterSpec<BinanceRaw> = {
    exchange: 'binance',
    createClient: createClientFn,
    parseMessage: parseBinanceMessage,
  }

  return createPrivateWsAdapterFromSpec(binanceSpec, opts)
}
