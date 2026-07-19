import type { ExchangeCredentials } from '../../config/types.js'
import type { OrderAck, OrderAmendPatch, OrderRef, OrderRequest } from '../rest/types.js'
import type { ExchangeOrderWsAdapter } from './types.js'

const ACK_TIMEOUT_MS = 5_000

export interface BybitOrderWsAdapterOptions {
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

export function createBybitOrderWsAdapter(opts: BybitOrderWsAdapterOptions): ExchangeOrderWsAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null

  return {
    exchange: 'bybit',

    async connect(): Promise<void> {
      const { WebsocketAPIClient } = await import('bybit-api')
      const clientOpts: Record<string, unknown> = { attachEventListeners: false }
      if (opts.credentials) {
        clientOpts.key = opts.credentials.apiKey
        clientOpts.secret = opts.credentials.apiSecret
      }
      if (opts.wsBaseUrl) clientOpts.wsUrl = opts.wsBaseUrl
      sdkClient = new WebsocketAPIClient(clientOpts as never)
    },

    disconnect(): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const c = sdkClient
      sdkClient = null
      if (c) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          c.getWSClient().closeAll(true)
        } catch {
          // ignore
        }
      }
      return Promise.resolve()
    },

    async createOrder(req: OrderRequest): Promise<OrderAck> {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
        const sdkCall = sdkClient!.submitNewOrder({
          category: 'linear',
          symbol: req.symbol,
          side: req.side === 'buy' ? 'Buy' : 'Sell',
          orderType: req.type === 'limit' ? 'Limit' : 'Market',
          qty: String(req.qty),
          orderLinkId: req.clientOrderId,
          ...(req.price !== undefined ? { price: String(req.price) } : {}),
          ...(req.reduceOnly ? { reduceOnly: true } : {}),
        }) as Promise<unknown>
        const response = await withTimeout(sdkCall)

        const retCode = Number((response as { retCode: unknown }).retCode ?? -1)
        if (retCode !== 0) {
          const retMsg = (response as { retMsg?: string }).retMsg ?? 'order rejected'
          return rejectAck(req.clientOrderId, new Error(retMsg))
        }

        const data = (response as { data: { orderId: string; orderLinkId: string } }).data
        return {
          clientOrderId: data.orderLinkId,
          exchangeOrderId: data.orderId,
          status: 'accepted',
          submittedAt: Date.now(),
          ackedAt: Date.now(),
        }
      } catch (err) {
        return rejectAck(req.clientOrderId, err)
      }
    },

    async cancelOrder(ref: OrderRef): Promise<void> {
      const params: Record<string, unknown> = { category: 'linear', symbol: ref.symbol }
      if (ref.clientOrderId) params.orderLinkId = ref.clientOrderId
      else if (ref.exchangeOrderId) params.orderId = ref.exchangeOrderId
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
      await withTimeout(sdkClient!.cancelOrder(params) as Promise<unknown>)
    },

    async amendOrder(
      ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>,
      patch: OrderAmendPatch
    ): Promise<OrderAck> {
      const params: Record<string, unknown> = {
        category: 'linear',
        symbol: ref.symbol,
        orderLinkId: ref.clientOrderId,
      }
      if (patch.price !== undefined) params.price = String(patch.price)
      if (patch.qty !== undefined) params.qty = String(patch.qty)
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
        const response = await withTimeout(sdkClient!.amendOrder(params) as Promise<unknown>)

        const retCode = Number((response as { retCode: unknown }).retCode ?? -1)
        if (retCode !== 0) {
          const retMsg = (response as { retMsg?: string }).retMsg ?? 'amend rejected'
          return rejectAck(ref.clientOrderId, new Error(retMsg))
        }

        const data = (response as { data: { orderId: string; orderLinkId: string } }).data
        return {
          clientOrderId: data.orderLinkId,
          exchangeOrderId: data.orderId,
          status: 'accepted',
          submittedAt: Date.now(),
          ackedAt: Date.now(),
        }
      } catch (err) {
        return rejectAck(ref.clientOrderId, err)
      }
    },
  }
}
