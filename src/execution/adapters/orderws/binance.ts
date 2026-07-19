import type { ExchangeCredentials } from '../../config/types.js'
import type { OrderAck, OrderAmendPatch, OrderRef, OrderRequest } from '../rest/types.js'
import type { ExchangeOrderWsAdapter } from './types.js'

const ACK_TIMEOUT_MS = 5_000

export interface BinanceOrderWsAdapterOptions {
  credentials?: ExchangeCredentials
  wsBaseUrl?: string
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error('WS_TIMEOUT'))
      }, ACK_TIMEOUT_MS)
    ),
  ])
}

function toAck(_clientOrderId: string, result: { orderId: number | string; clientOrderId: string }): OrderAck {
  return {
    clientOrderId: result.clientOrderId,
    exchangeOrderId: String(result.orderId),
    status: 'accepted',
    submittedAt: Date.now(),
    ackedAt: Date.now(),
  }
}

function rejectAck(clientOrderId: string, err: unknown): OrderAck {
  const rejectReason =
    err instanceof Error ? err.message : typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err)
  return {
    clientOrderId,
    exchangeOrderId: '',
    status: 'rejected',
    rejectReason,
    submittedAt: Date.now(),
    ackedAt: Date.now(),
  }
}

export function createBinanceOrderWsAdapter(opts: BinanceOrderWsAdapterOptions): ExchangeOrderWsAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null

  return {
    exchange: 'binance',

    async connect(): Promise<void> {
      const { WebsocketAPIClient } = await import('binance')
      const clientOpts: Record<string, unknown> = {
        attachEventListeners: false,
        muteLatencyWarning: true,
      }
      if (opts.credentials) {
        clientOpts.api_key = opts.credentials.apiKey
        clientOpts.api_secret = opts.credentials.apiSecret
      }
      if (opts.wsBaseUrl) clientOpts.wsURL = opts.wsBaseUrl
      sdkClient = new WebsocketAPIClient(clientOpts as never)
    },

    async disconnect(): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const c = sdkClient
      sdkClient = null
      if (c) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          await c.disconnectAll()
        } catch {
          // ignore
        }
      }
    },

    async createOrder(req: OrderRequest): Promise<OrderAck> {
      // Binance WS API requires newClientOrderId prefixed with 'x-r1wQQsTn' (10 chars).
      // We truncate our internal ID to 22 chars to stay within the 32-char limit.
      const BINANCE_WS_PREFIX = 'x-r1wQQsTn'
      const binanceClientOrderId = BINANCE_WS_PREFIX + req.clientOrderId.slice(0, 22)
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
        const sdkCall = sdkClient!.submitNewFuturesOrder('usdm', {
          symbol: req.symbol,
          side: req.side.toUpperCase(),
          type: req.type === 'limit' ? 'LIMIT' : 'MARKET',
          quantity: req.qty,
          newClientOrderId: binanceClientOrderId,
          timestamp: Date.now(),
          ...(req.price !== undefined ? { price: req.price, timeInForce: 'GTC' } : {}),
          ...(req.reduceOnly ? { reduceOnly: 'true' } : {}),
        }) as Promise<unknown>
        const response = await withTimeout(sdkCall)
        return toAck(req.clientOrderId, (response as { result: { orderId: number; clientOrderId: string } }).result)
      } catch (err) {
        return rejectAck(req.clientOrderId, err)
      }
    },

    async cancelOrder(ref: OrderRef): Promise<void> {
      const params: Record<string, unknown> = { symbol: ref.symbol, timestamp: Date.now() }
      if (ref.clientOrderId) params.origClientOrderId = ref.clientOrderId
      else if (ref.exchangeOrderId) params.orderId = Number(ref.exchangeOrderId)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
      await withTimeout(sdkClient!.cancelFuturesOrder('usdm', params) as Promise<unknown>)
    },

    async amendOrder(
      ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>,
      patch: OrderAmendPatch
    ): Promise<OrderAck> {
      const params: Record<string, unknown> = {
        symbol: ref.symbol,
        origClientOrderId: ref.clientOrderId,
        timestamp: Date.now(),
      }
      if (patch.price !== undefined) params.price = patch.price
      if (patch.qty !== undefined) params.quantity = patch.qty
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
        const response = await withTimeout(sdkClient!.modifyFuturesOrder('usdm', params) as Promise<unknown>)
        return toAck(ref.clientOrderId, (response as { result: { orderId: number; clientOrderId: string } }).result)
      } catch (err) {
        return rejectAck(ref.clientOrderId, err)
      }
    },
  }
}
