import type { ExchangeCredentials } from '../../config/types.js'
import type { OrderAck, OrderAmendPatch, OrderRef, OrderRequest } from '../rest/types.js'
import type { ExchangeOrderWsAdapter } from './types.js'

const ACK_TIMEOUT_MS = 5_000
// Max attempts × delay to resolve exchange order ID after WS ack.
// Gate.io IOC market orders fill instantly but can take 1-2s to appear in REST.
// 15 × 500ms = 7.5s total window covers typical propagation delays.
const REST_FALLBACK_ATTEMPTS = 15
const REST_FALLBACK_DELAY_MS = 500

export interface GateioOrderWsAdapterOptions {
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

export function createGateioOrderWsAdapter(opts: GateioOrderWsAdapterOptions): ExchangeOrderWsAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let restClient: any = null

  return {
    exchange: 'gateio',

    async connect(): Promise<void> {
      const { WebsocketAPIClient, RestClient } = await import('gateio-api')
      const clientOpts: Record<string, unknown> = { attachEventListeners: false }
      if (opts.credentials) {
        clientOpts.apiKey = opts.credentials.apiKey
        clientOpts.apiSecret = opts.credentials.apiSecret
      }
      if (opts.wsBaseUrl) clientOpts.wsUrl = opts.wsBaseUrl
      sdkClient = new WebsocketAPIClient(clientOpts as never)
      if (opts.credentials) {
        restClient = new RestClient({
          apiKey: opts.credentials.apiKey,
          apiSecret: opts.credentials.apiSecret,
        })
      }
    },

    disconnect(): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const c = sdkClient
      sdkClient = null
      restClient = null
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
      // Gate.io futures: positive size = long/buy, negative size = short/sell
      const size = req.side === 'buy' ? req.qty : -req.qty
      const wsText = `t-${req.clientOrderId}`
      const submittedAt = Date.now()
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
        const sdkCall = sdkClient!.submitNewFuturesOrder({
          contract: req.symbol,
          size,
          text: wsText,
          reduce_only: req.reduceOnly ?? false,
          ...(req.type === 'limit' && req.price !== undefined
            ? { price: String(req.price), tif: 'gtc' }
            : { price: '0', tif: 'ioc' }),
        }) as Promise<unknown>
        const response = await withTimeout(sdkCall)

        // Gate.io WS API sends two responses for order_place:
        //   1. Ack (ack:true): echoes request params, no order ID
        //   2. Order result push: contains actual order ID (not captured by SDK)
        // The SDK resolves on the ack (first response), so result.id is undefined.
        // Fall back to REST lookup by text field to obtain the exchangeOrderId.
        const result = (response as { ack?: boolean; data: { result: { id?: number; text?: string } } }).data.result

        if (result.id !== undefined) {
          const rawText = result.text
          return {
            clientOrderId: rawText?.replace(/^t-/, '') ?? req.clientOrderId,
            exchangeOrderId: String(result.id),
            status: 'accepted',
            submittedAt,
            ackedAt: Date.now(),
          }
        }

        // Ack-only response: poll REST to resolve the actual order ID
        if (restClient) {
          for (let attempt = 0; attempt < REST_FALLBACK_ATTEMPTS; attempt++) {
            await new Promise<void>(r => setTimeout(r, REST_FALLBACK_DELAY_MS))
            try {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
              const orders = (await restClient.getFuturesOrders({
                settle: 'usdt',
                contract: req.symbol,
                status: 'finished',
                text: wsText,
                limit: 5,
              })) as { id: number; text?: string }[]
              const match = orders.find(o => o.text === wsText)
              if (match?.id !== undefined) {
                return {
                  clientOrderId: req.clientOrderId,
                  exchangeOrderId: String(match.id),
                  status: 'accepted',
                  submittedAt,
                  ackedAt: Date.now(),
                }
              }
              // Order may still be open (limit) — also check open orders
              // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
              const openOrders = (await restClient.getFuturesOrders({
                settle: 'usdt',
                contract: req.symbol,
                status: 'open',
                text: wsText,
                limit: 5,
              })) as { id: number; text?: string }[]
              const openMatch = openOrders.find(o => o.text === wsText)
              if (openMatch?.id !== undefined) {
                return {
                  clientOrderId: req.clientOrderId,
                  exchangeOrderId: String(openMatch.id),
                  status: 'accepted',
                  submittedAt,
                  ackedAt: Date.now(),
                }
              }
            } catch {
              // ignore REST lookup errors, retry
            }
          }
        }

        // REST fallback exhausted — return accepted with empty exchangeOrderId so
        // fill detection falls back to clientOrderId-based lookup
        return {
          clientOrderId: req.clientOrderId,
          exchangeOrderId: '',
          status: 'accepted',
          submittedAt,
          ackedAt: Date.now(),
        }
      } catch (err) {
        return rejectAck(req.clientOrderId, err)
      }
    },

    async cancelOrder(ref: OrderRef): Promise<void> {
      if (!ref.exchangeOrderId) {
        throw new Error(
          `gateio cancelOrder requires exchangeOrderId (got clientOrderId=${ref.clientOrderId ?? 'none'})`
        )
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
      await withTimeout(sdkClient!.cancelFuturesOrder({ order_id: ref.exchangeOrderId }) as Promise<unknown>)
    },

    async amendOrder(
      ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>,
      patch: OrderAmendPatch
    ): Promise<OrderAck> {
      // updateFuturesOrder requires the exchange order_id; fall back to client order text lookup not supported
      // If exchangeOrderId is unavailable this will throw and surface as rejected
      const params: Record<string, unknown> = {}
      if (patch.price !== undefined) params.price = String(patch.price)
      if (patch.qty !== undefined) params.size = patch.qty
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion
        const response = await withTimeout(sdkClient!.updateFuturesOrder(params) as Promise<unknown>)

        const result = (response as { data: { result: { id?: number; text?: string } } }).data.result
        const rawText = result.text
        return {
          clientOrderId: rawText?.replace(/^t-/, '') ?? ref.clientOrderId,
          exchangeOrderId: result.id !== undefined ? String(result.id) : '',
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
