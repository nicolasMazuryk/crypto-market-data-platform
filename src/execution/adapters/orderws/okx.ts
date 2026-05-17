import type { ExchangeCredentials } from '../../config/types.js'
import type { OrderAck, OrderAmendPatch, OrderRef, OrderRequest } from '../rest/types.js'
import type { ExchangeOrderWsAdapter } from './types.js'

const ACK_TIMEOUT_MS = 5_000

export interface OkxOrderWsAdapterOptions {
  credentials?: ExchangeCredentials
  wsBaseUrl?: string
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => { reject(new Error('WS_TIMEOUT')); }, ACK_TIMEOUT_MS)),
  ])
}

function rejectAck(clientOrderId: string, err: unknown): OrderAck {
  return {
    clientOrderId,
    exchangeOrderId: '',
    status: 'rejected',
    rejectReason: err instanceof Error ? err.message : String(err),
    submittedAt: Date.now(),
    ackedAt: Date.now(),
  }
}

export function createOkxOrderWsAdapter(opts: OkxOrderWsAdapterOptions): ExchangeOrderWsAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null

  return {
    exchange: 'okx',

    async connect(): Promise<void> {
      if (!opts.credentials?.apiKey || !opts.credentials?.apiSecret) {
        throw new Error('OKX order WS adapter: missing credentials (apiKey/apiSecret required)')
      }
      const { WebsocketAPIClient } = await import('okx-api')
      const market = opts.wsBaseUrl?.includes('demo') ? 'demoTrading' : 'prod'
      const clientOpts: Record<string, unknown> = {
        market,
        attachEventListeners: false,
        accounts: [
          {
            apiKey: opts.credentials.apiKey,
            apiSecret: opts.credentials.apiSecret,
            apiPass: opts.credentials.apiPassphrase ?? '',
          },
        ],
      }
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
          instId: req.symbol,
          tdMode: 'cross',
          side: req.side,
          ordType: req.type === 'limit' ? 'limit' : 'market',
          sz: String(req.qty),
          clOrdId: req.clientOrderId,
          ...(req.price !== undefined ? { px: String(req.price) } : {}),
          ...(req.reduceOnly ? { reduceOnly: true } : {}),
        }) as Promise<unknown>
        const response = await withTimeout(sdkCall)
        // OKX WS API returns data as an array — first element is our order result
         
        const item = (response as { data: { sCode: string; sMsg: string; clOrdId: string; ordId: string }[] }).data[0]
        if (item?.sCode !== '0') {
          return rejectAck(req.clientOrderId, new Error(item?.sMsg ?? 'order rejected'))
        }
        return {
          clientOrderId: item.clOrdId || req.clientOrderId,
          exchangeOrderId: item.ordId,
          status: 'accepted',
          submittedAt: Date.now(),
          ackedAt: Date.now(),
        }
      } catch (err) {
        return rejectAck(req.clientOrderId, err)
      }
    },

    async cancelOrder(ref: OrderRef): Promise<void> {
      const params: Record<string, unknown> = { instId: ref.symbol }
      if (ref.clientOrderId) params.clOrdId = ref.clientOrderId
      else if (ref.exchangeOrderId) params.ordId = ref.exchangeOrderId
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
      await withTimeout(sdkClient!.cancelOrder(params) as Promise<unknown>)
    },

    async amendOrder(
      ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>,
      patch: OrderAmendPatch
    ): Promise<OrderAck> {
      const params: Record<string, unknown> = {
        instId: ref.symbol,
        clOrdId: ref.clientOrderId,
      }
      if (patch.price !== undefined) params.newPx = String(patch.price)
      if (patch.qty !== undefined) params.newSz = String(patch.qty)
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
        const response = await withTimeout(sdkClient!.amendOrder(params) as Promise<unknown>)
         
        const item = (response as { data: { sCode: string; sMsg: string; clOrdId: string; ordId: string }[] }).data[0]
        if (item?.sCode !== '0') {
          return rejectAck(ref.clientOrderId, new Error(item?.sMsg ?? 'amend rejected'))
        }
        return {
          clientOrderId: item.clOrdId || ref.clientOrderId,
          exchangeOrderId: item.ordId,
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
