import type { ExchangeCredentials } from '../../config/types.js'
import type { OrderAck, OrderAmendPatch, OrderRef, OrderRequest } from '../rest/types.js'
import type { ExchangeOrderWsAdapter } from './types.js'

const ACK_TIMEOUT_MS = 5_000

export interface BitgetOrderWsAdapterOptions {
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
  return {
    clientOrderId,
    exchangeOrderId: '',
    status: 'rejected',
    rejectReason: err instanceof Error ? err.message : String(err),
    submittedAt: Date.now(),
    ackedAt: Date.now(),
  }
}

export function createBitgetOrderWsAdapter(opts: BitgetOrderWsAdapterOptions): ExchangeOrderWsAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null

  return {
    exchange: 'bitget',

    async connect(): Promise<void> {
      const { WebsocketAPIClient } = await import('bitget-api')
      const clientOpts: Record<string, unknown> = { attachEventListeners: false }
      if (opts.credentials) {
        clientOpts.apiKey = opts.credentials.apiKey
        clientOpts.apiSecret = opts.credentials.apiSecret
        clientOpts.apiPass = opts.credentials.apiPassphrase ?? ''
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
        const sdkCall = sdkClient!.submitNewOrder('usdt-futures', {
          symbol: req.symbol,
          orderType: req.type === 'limit' ? 'limit' : 'market',
          qty: String(req.qty),
          side: req.side,
          clientOid: req.clientOrderId,
          ...(req.price !== undefined ? { price: String(req.price) } : {}),
          ...(req.reduceOnly ? { reduceOnly: 'YES' } : {}),
        }) as Promise<unknown>
        const response = await withTimeout(sdkCall)

        const code = String((response as { code?: string | number }).code ?? '-1')
        if (code !== '0') {
          const msg = (response as { msg?: string }).msg ?? 'order rejected'
          return rejectAck(req.clientOrderId, new Error(msg))
        }

        const item = (response as { args: { orderId: string; clientOid: string }[] }).args[0]
        return {
          clientOrderId: item?.clientOid ?? req.clientOrderId,
          exchangeOrderId: item?.orderId ?? '',
          status: 'accepted',
          submittedAt: Date.now(),
          ackedAt: Date.now(),
        }
      } catch (err) {
        return rejectAck(req.clientOrderId, err)
      }
    },

    async cancelOrder(ref: OrderRef): Promise<void> {
      const params: Record<string, unknown> = {}
      if (ref.clientOrderId) params.clientOid = ref.clientOrderId
      else if (ref.exchangeOrderId) params.orderId = ref.exchangeOrderId
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
      await withTimeout(sdkClient!.cancelOrder('usdt-futures', params) as Promise<unknown>)
    },

    // Bitget v3 WS API does not expose an amend-order channel; cancel+replace is required
    amendOrder(ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>, _patch: OrderAmendPatch): Promise<OrderAck> {
      void ref
      return Promise.resolve(rejectAck(ref.clientOrderId, new Error('amendOrder not supported via Bitget WS')))
    },
  }
}
