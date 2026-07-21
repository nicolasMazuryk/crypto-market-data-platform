import type { Logger } from 'pino'
import ccxt from 'ccxt'

import type { Clock, ClientOrderIdDeriver, RateLimiter } from '../../core/types.js'
import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { RestMetrics } from '../../observability/metrics.js'
import type { Tracer } from '../../observability/types.js'
import type { CcxtExchange, CcxtOrder, CcxtPosition } from '../../../exchanges/types.js'
import type { MarketMetadataProvider } from '../../markets/types.js'
import type { Exchange } from '../../types/exchange.js'
import { normalizeSymbol } from '../../../utils/symbol-normalizer.js'
import { mapCcxtError, sleepWithJitter, withRateLimit, withMetrics, type EndpointClass } from './base.js'
import type {
  ExchangeRestAdapter,
  MarginMode,
  OrderRequest,
  OrderAck,
  Order,
  OrderSide,
  OrderStatus,
  Position,
  Balance,
  OrderRef,
  OrderAmendPatch,
} from './types.js'

type ExchangeConfigWithCreds = ExchangeConfig & { credentials?: ExchangeCredentials }

const BACKOFF_MS = 500

export interface CcxtAdapterSpec {
  exchange: Exchange
  ccxtId: string
  ccxtOptions: Record<string, unknown>
  duplicateOrderCodes: Set<string>
  cancelIgnoreCodes?: Set<string> // treat these like OrderNotFound when cancelling
  leverageAlreadySetCode?: string
  canonicalizeClientOrderId?(id: string): string
  buildCreateOrderParams(req: OrderRequest): Record<string, unknown>
  /** Override the type string passed to CCXT createOrder (2nd arg). Defaults to req.type. */
  mapCcxtOrderType?(req: OrderRequest): string
  buildCancelOrderParams(ref: OrderRef): Record<string, unknown>
  buildFetchOrderParams(ref: OrderRef): Record<string, unknown>
  buildAmendOrderParams?(ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>): Record<string, unknown>
  setLeverage?(ccxtEx: CcxtExchange, unified: string, leverage: number): Promise<void>
  setMarginMode?(ccxtEx: CcxtExchange, unified: string, mode: 'cross' | 'isolated'): Promise<void>
  setPositionMode?(ccxtEx: CcxtExchange, hedged: boolean, unified?: string): Promise<void>
  /** Hook called once on the freshly-built CCXT instance, before any request. */
  postBuildCcxt?(ccxtEx: CcxtExchange): void
  /** Optional extra methods to add to the returned adapter (e.g. exchange-specific APIs). */
  buildExtras?(ccxtEx: CcxtExchange): Partial<ExchangeRestAdapter>
  /** Override the default fetchOrder-based lookup. Return undefined when the order is not found. */
  getOrder?(ccxtEx: CcxtExchange, ref: OrderRef, unified: string): Promise<CcxtOrder | undefined>
  defaultBalanceAsset?: string
}

export interface BaseRestAdapterOptions {
  config: ExchangeConfig
  limiter: RateLimiter
  clock: Clock
  ids: ClientOrderIdDeriver
  logger: Logger
  metrics: RestMetrics
  marketMetadataProvider?: MarketMetadataProvider // optional — falls back to loadMarkets-based resolution
  ccxtFactory?: () => CcxtExchange
  tracer?: Tracer
}

function buildCcxtClient(spec: CcxtAdapterSpec, config: ExchangeConfigWithCreds): CcxtExchange {
  const ccxtCfg: Record<string, unknown> = {
    enableRateLimit: false,
    options: spec.ccxtOptions,
  }
  if (config.credentials) {
    ccxtCfg.apiKey = config.credentials.apiKey
    ccxtCfg.secret = config.credentials.apiSecret
    if (config.credentials.apiPassphrase) ccxtCfg.password = config.credentials.apiPassphrase
  }
  if (config.restBaseUrl) {
    ccxtCfg.urls = { api: { public: config.restBaseUrl, private: config.restBaseUrl } }
  }
  const reg = ccxt as unknown as Record<string, new (cfg?: Record<string, unknown>) => CcxtExchange>
  const Cls = reg[spec.ccxtId]
  if (!Cls) throw new Error(`CCXT class not found: ${spec.ccxtId}`)
  return new Cls(ccxtCfg)
}

function mapOrderStatus(s: string): OrderStatus {
  switch (s.toLowerCase()) {
    case 'open':
    case 'new':
      return 'new'
    case 'partially_filled':
      return 'partially_filled'
    case 'closed':
    case 'filled':
      return 'filled'
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    case 'rejected':
      return 'rejected'
    case 'expired':
      return 'expired'
    default:
      return 'new'
  }
}

function mapCcxtOrder(raw: CcxtOrder, exchange: Exchange): Order {
  const order: Order = {
    exchange,
    symbol: raw.symbol,
    clientOrderId: raw.clientOrderId ?? '',
    exchangeOrderId: raw.id,
    side: (raw.side as OrderSide | undefined) ?? 'buy',
    type: raw.type as Order['type'],
    qty: raw.amount ?? 0,
    filledQty: raw.filled ?? 0,
    reduceOnly: raw.reduceOnly ?? false,
    status: mapOrderStatus(raw.status ?? ''),
    submittedAt: raw.timestamp ?? Date.now(),
    updatedAt: raw.lastUpdateTimestamp ?? raw.timestamp ?? Date.now(),
  }
  if (raw.price !== undefined) order.price = raw.price
  if (raw.average !== undefined) order.avgFillPrice = raw.average
  if (raw.stopPrice !== undefined) order.stopPrice = raw.stopPrice
  return order
}

function mapCcxtPosition(p: CcxtPosition, exchange: Exchange): Position {
  const contracts = p.contracts ?? 0
  const pos: Position = {
    exchange,
    symbol: p.symbol,
    qty: Math.abs(contracts),
    side: p.side === 'short' ? 'short' : p.side === 'long' ? 'long' : 'flat',
    leverage: p.leverage ?? 1,
    updatedAt: p.timestamp ?? Date.now(),
  }
  if (p.entryPrice !== undefined) pos.entryPrice = p.entryPrice
  if (p.markPrice !== undefined) pos.markPrice = p.markPrice
  if (p.unrealizedPnl !== undefined) pos.unrealizedPnl = p.unrealizedPnl
  if (p.liquidationPrice !== undefined) pos.liquidationPrice = p.liquidationPrice
  return pos
}

export function createCcxtRestAdapter(
  spec: CcxtAdapterSpec,
  opts: BaseRestAdapterOptions
): ExchangeRestAdapter & { dispose(): Promise<void> } {
  const { config, limiter, clock, logger, metrics, tracer } = opts
  const exchange = spec.exchange
  const ccxtExchange = opts.ccxtFactory?.() ?? buildCcxtClient(spec, config as ExchangeConfigWithCreds)
  spec.postBuildCcxt?.(ccxtExchange)

  function requireCcxtMethod<K extends keyof CcxtExchange>(name: K): NonNullable<CcxtExchange[K]> {
    const method = ccxtExchange[name]
    if (method === undefined) {
      throw new Error(`CCXT method not implemented for ${exchange}: ${name as string}`)
    }
    return method as NonNullable<CcxtExchange[K]>
  }

  // Fallback symbol map for when no marketMetadataProvider is given (keeps backward compat with tests)
  let marketsLoaded = false
  const fallbackSymbolMap = new Map<string, string>()
  const leverageCache = new Map<string, number>()

  async function ensureMarketsIfNeeded(): Promise<void> {
    if (opts.marketMetadataProvider) return // provider handles resolution
    if (marketsLoaded) return
    await ccxtExchange.loadMarkets()
    marketsLoaded = true
    for (const [unified, market] of Object.entries(ccxtExchange.markets)) {
      if (market.id) fallbackSymbolMap.set(market.id, unified)
      // Index by normalized symbol only for perpetual swap markets (never options or spot).
      // Bybit options are linear too, so check market.swap explicitly to exclude them.
      if (market.swap === true && market.option !== true) {
        fallbackSymbolMap.set(normalizeSymbol(unified), unified)
      }
    }
  }

  function resolve(normalized: string): string {
    if (opts.marketMetadataProvider) {
      return opts.marketMetadataProvider.resolve(exchange, normalized) ?? normalized
    }
    return fallbackSymbolMap.get(normalized) ?? normalized
  }

  function call<T>(
    cls: EndpointClass,
    priority: 'critical' | 'normal' | 'background',
    method: string,
    fn: () => Promise<T>
  ): Promise<T> {
    return withRateLimit(limiter, cls, priority, () => withMetrics(metrics, exchange, method, fn))
  }

  async function setLeverageInternal(unified: string, leverage: number): Promise<void> {
    const current = leverageCache.get(unified)
    if (current === leverage) return
    try {
      if (spec.setLeverage) {
        await spec.setLeverage(ccxtExchange, unified, leverage)
      } else {
        await requireCcxtMethod('setLeverage').call(ccxtExchange, leverage, unified)
      }
      leverageCache.set(unified, leverage)
    } catch (err) {
      const mapped = mapCcxtError(err)
      if (spec.leverageAlreadySetCode && mapped.code === spec.leverageAlreadySetCode) {
        leverageCache.set(unified, leverage)
        return
      }
      throw err
    }
  }

  function isDuplicateOrderCode(code: string): boolean {
    return spec.duplicateOrderCodes.has(code)
  }

  async function fetchByClientId(unified: string, clientOrderId: string): Promise<CcxtOrder | undefined> {
    return call('order_read', 'critical', 'fetchByClientId', async () => {
      try {
        const params = spec.buildFetchOrderParams({ symbol: unified, clientOrderId })
        return await requireCcxtMethod('fetchOrder').call(ccxtExchange, '', unified, params)
      } catch (err) {
        const mapped = mapCcxtError(err)
        if (mapped.code === 'OrderNotFound') return undefined
        throw err
      }
    })
  }

  async function fetchOpenByClientId(unified: string, clientOrderId: string): Promise<CcxtOrder | undefined> {
    return call('order_read', 'critical', 'fetchOpenByClientId', async () => {
      try {
        const raws = await requireCcxtMethod('fetchOpenOrders').call(ccxtExchange, unified)
        return raws.find(o => o.clientOrderId === clientOrderId)
      } catch {
        return undefined
      }
    })
  }

  async function fetchClosedByClientId(unified: string, clientOrderId: string): Promise<CcxtOrder | undefined> {
    return call('order_read', 'critical', 'fetchClosedByClientId', async () => {
      try {
        const raws = await requireCcxtMethod('fetchClosedOrders').call(ccxtExchange, unified, undefined, 50)
        return raws.find(o => o.clientOrderId === clientOrderId)
      } catch {
        return undefined
      }
    })
  }

  async function fetchPositionQty(unified: string): Promise<number> {
    try {
      const raws = await call('account_read', 'critical', 'fetchPositionForRetry', () =>
        requireCcxtMethod('fetchPositions').call(ccxtExchange, [unified])
      )
      let total = 0
      for (const p of raws) {
        const c = p.contracts ?? 0
        if (Math.abs(c) > 0) total += Math.abs(c)
      }
      return total
    } catch {
      return Number.NaN
    }
  }

  return {
    exchange,

    ...(spec.canonicalizeClientOrderId
      ? {
          // eslint-disable-next-line @typescript-eslint/unbound-method
          canonicalizeClientOrderId: spec.canonicalizeClientOrderId,
        }
      : {}),

    async warm(): Promise<void> {
      await ensureMarketsIfNeeded()
    },

    async setLeverage(symbol: string, leverage: number): Promise<void> {
      await ensureMarketsIfNeeded()
      return call('order_write', 'normal', 'setLeverage', () => setLeverageInternal(resolve(symbol), leverage))
    },

    async setMarginMode(symbol: string, mode: MarginMode): Promise<void> {
      await ensureMarketsIfNeeded()
      const unified = resolve(symbol)
      return call('account_write', 'background', 'setMarginMode', async () => {
        if (spec.setMarginMode) {
          await spec.setMarginMode(ccxtExchange, unified, mode)
        } else if (ccxtExchange.setMarginMode) {
          await ccxtExchange.setMarginMode(mode, unified)
        }
      })
    },

    async setPositionMode(hedged: boolean, symbol?: string): Promise<void> {
      if (symbol) await ensureMarketsIfNeeded()
      const unified = symbol ? resolve(symbol) : undefined
      return call('account_write', 'background', 'setPositionMode', async () => {
        if (spec.setPositionMode) {
          await spec.setPositionMode(ccxtExchange, hedged, unified)
        } else if (ccxtExchange.setPositionMode) {
          await ccxtExchange.setPositionMode(hedged, unified)
        }
      })
    },

    async createOrder(req: OrderRequest): Promise<OrderAck> {
      const span = tracer?.startSpan('rest.createOrder', {
        exchange,
        symbol: req.symbol,
        side: req.side,
        type: req.type,
      })
      const t0 = clock.now()
      await ensureMarketsIfNeeded()
      const unified = resolve(req.symbol)

      const leverage = req.leverage
      if (leverage !== undefined) {
        const t1 = clock.now()
        await call('order_write', 'critical', 'setLeverage', () => setLeverageInternal(unified, leverage))
        logger.debug(
          { event: 'submit.timing', intentId: req.intentId, exchange, phase: 'setLeverage', ms: clock.now() - t1 },
          'submit.timing'
        )
      }

      const submittedAt = clock.now()
      logger.debug(
        { event: 'submit.timing', intentId: req.intentId, exchange, phase: 'enter', ms: submittedAt - t0 },
        'submit.timing'
      )
      const params = spec.buildCreateOrderParams(req)

      const createOrderFn = requireCcxtMethod('createOrder')
      const ccxtOrderType = spec.mapCcxtOrderType ? spec.mapCcxtOrderType(req) : req.type
      const doPost = (): Promise<CcxtOrder> =>
        createOrderFn.call(ccxtExchange, unified, ccxtOrderType, req.side, req.qty, req.price, params)

      // Pre-flight position snapshot for market orders: lets the retry path
      // detect "the original POST actually landed but the response failed" by observing a
      // position delta. Critical on Binance Futures, where clientOrderId can be reused once
      // the prior order with the same id reaches a terminal state — naïve retry duplicates fills.
      const positionCheckEligible = req.type === 'market'
      const positionQtyBefore = positionCheckEligible ? await fetchPositionQty(unified) : Number.NaN

      const positionLandedAck = async (origin: string): Promise<OrderAck | undefined> => {
        if (!positionCheckEligible || Number.isNaN(positionQtyBefore)) return undefined
        const after = await fetchPositionQty(unified)
        if (Number.isNaN(after)) return undefined
        const delta = req.reduceOnly === true ? positionQtyBefore - after : after - positionQtyBefore
        // Half the requested qty is enough to confirm the order landed (covers partials).
        if (delta >= req.qty * 0.5) {
          metrics.idempotencyHits.inc(1, { exchange })
          logger.warn(
            {
              exchange,
              intentId: req.intentId,
              clientOrderId: req.clientOrderId,
              symbol: req.symbol,
              positionQtyBefore,
              positionQtyAfter: after,
              requestQty: req.qty,
              origin,
            },
            'createOrder: original POST appears to have landed (position moved) — skipping retry to avoid duplicate'
          )
          return {
            clientOrderId: req.clientOrderId,
            exchangeOrderId: '',
            status: 'accepted',
            submittedAt,
            ackedAt: clock.now(),
          }
        }
        return undefined
      }

      const existingOrderAck = async (origin: string): Promise<OrderAck | undefined> => {
        const existing =
          (await fetchByClientId(unified, req.clientOrderId)) ??
          (await fetchOpenByClientId(unified, req.clientOrderId)) ??
          (await fetchClosedByClientId(unified, req.clientOrderId))
        if (existing) {
          metrics.idempotencyHits.inc(1, { exchange })
          logger.warn(
            { exchange, intentId: req.intentId, clientOrderId: req.clientOrderId, origin },
            'createOrder: original POST found by clientOrderId/open/history lookup — skipping retry'
          )
          return {
            clientOrderId: req.clientOrderId,
            exchangeOrderId: existing.id,
            status: 'accepted',
            submittedAt,
            ackedAt: clock.now(),
          }
        }
        return positionLandedAck(origin)
      }

      const ack = await call('order_write', 'critical', 'createOrder', async (): Promise<OrderAck> => {
        const tCreate = clock.now()
        try {
          const raw = await doPost()
          logger.debug(
            {
              event: 'submit.timing',
              intentId: req.intentId,
              exchange,
              phase: 'createOrder',
              ms: clock.now() - tCreate,
            },
            'submit.timing'
          )
          metrics.ordersTotal.inc(1, { exchange, side: req.side, type: req.type, status: 'accepted' })
          return {
            clientOrderId: req.clientOrderId,
            exchangeOrderId: raw.id,
            status: 'accepted',
            submittedAt,
            ackedAt: clock.now(),
          }
        } catch (err) {
          const mapped = mapCcxtError(err)
          const ackedAt = clock.now()
          const errAny = err as Record<string, unknown>

          if (mapped.isReject) {
            logger.warn(
              {
                exchange,
                intentId: req.intentId,
                code: mapped.code,
                message: mapped.message,
                body: typeof errAny.body === 'string' ? errAny.body.slice(0, 500) : undefined,
                httpStatus: (errAny.response as Record<string, unknown> | undefined)?.status,
              },
              'createOrder.rejected'
            )
            if (isDuplicateOrderCode(mapped.code)) {
              await sleepWithJitter(BACKOFF_MS)
              const landed = await existingOrderAck('duplicate_code')
              if (landed) return landed
            }
            metrics.ordersTotal.inc(1, { exchange, side: req.side, type: req.type, status: 'rejected' })
            metrics.rejectionsByCode.inc(1, { exchange, code: mapped.code })
            return {
              clientOrderId: req.clientOrderId,
              exchangeOrderId: '',
              status: 'rejected',
              rejectReason: `${mapped.code}: ${mapped.message}`,
              submittedAt,
              ackedAt,
            }
          }

          if (mapped.isRetryable) {
            await sleepWithJitter(BACKOFF_MS)
            const landed = await existingOrderAck('retryable_error')
            if (landed) return landed
            try {
              const raw = await call('order_write', 'critical', 'createOrder.retry', () => doPost())
              metrics.ordersTotal.inc(1, { exchange, side: req.side, type: req.type, status: 'accepted' })
              return {
                clientOrderId: req.clientOrderId,
                exchangeOrderId: raw.id,
                status: 'accepted',
                submittedAt,
                ackedAt: clock.now(),
              }
            } catch (retryErr) {
              const retryMapped = mapCcxtError(retryErr)
              if (isDuplicateOrderCode(retryMapped.code)) {
                await sleepWithJitter(BACKOFF_MS)
                const landedAfterRetry = await existingOrderAck('duplicate_code_after_retry')
                if (landedAfterRetry) return landedAfterRetry
              }
              throw retryErr
            }
          }

          throw err
        }
      })
      span?.setAttribute('ack_status', ack.status)
      span?.end()
      return ack
    },

    async cancelOrder(ref: OrderRef): Promise<void> {
      await ensureMarketsIfNeeded()
      const unified = resolve(ref.symbol)
      // Priority classes are the §8 realization of the "10% reservation" intent: cancels
      // must not queue behind normal traffic, so they get protective 'critical' priority.
      return call('order_write', 'critical', 'cancelOrder', async () => {
        try {
          const params = spec.buildCancelOrderParams(ref)
          await requireCcxtMethod('cancelOrder').call(ccxtExchange, ref.exchangeOrderId ?? '', unified, params)
        } catch (err) {
          const mapped = mapCcxtError(err)
          if (mapped.code === 'OrderNotFound' || (spec.cancelIgnoreCodes?.has(mapped.code) ?? false)) {
            logger.debug({ ref }, 'cancelOrder: order already gone')
            return
          }
          throw err
        }
      })
    },

    async amendOrder(
      ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>,
      patch: OrderAmendPatch
    ): Promise<OrderAck> {
      await ensureMarketsIfNeeded()
      const unified = resolve(ref.symbol)
      const submittedAt = clock.now()
      return call('order_write', 'normal', 'amendOrder', async () => {
        const params = spec.buildAmendOrderParams ? spec.buildAmendOrderParams(ref) : spec.buildCancelOrderParams(ref)
        const raw = await requireCcxtMethod('editOrder').call(
          ccxtExchange,
          '',
          unified,
          '',
          '',
          patch.qty,
          patch.price,
          params
        )
        return {
          clientOrderId: ref.clientOrderId,
          exchangeOrderId: raw.id,
          status: 'accepted',
          submittedAt,
          ackedAt: clock.now(),
        }
      })
    },

    async getOpenOrders(symbol?: string): Promise<Order[]> {
      await ensureMarketsIfNeeded()
      const unified = symbol ? resolve(symbol) : undefined
      return call('order_read', 'normal', 'getOpenOrders', async () => {
        const raws = await requireCcxtMethod('fetchOpenOrders').call(ccxtExchange, unified)
        return raws.map(r => mapCcxtOrder(r, exchange))
      })
    },

    async getOrder(ref: OrderRef): Promise<Order | undefined> {
      await ensureMarketsIfNeeded()
      const unified = resolve(ref.symbol)
      return call('order_read', 'normal', 'getOrder', async () => {
        try {
          if (spec.getOrder) {
            const raw = await spec.getOrder(ccxtExchange, ref, unified)
            return raw ? mapCcxtOrder(raw, exchange) : undefined
          }
          const params = spec.buildFetchOrderParams(ref)
          const raw = await requireCcxtMethod('fetchOrder').call(
            ccxtExchange,
            ref.exchangeOrderId ?? '',
            unified,
            params
          )
          return mapCcxtOrder(raw, exchange)
        } catch (err) {
          const mapped = mapCcxtError(err)
          if (mapped.code === 'OrderNotFound') return undefined
          throw err
        }
      })
    },

    async getPositions(symbol?: string): Promise<Position[]> {
      await ensureMarketsIfNeeded()
      return call('account_read', 'normal', 'getPositions', async () => {
        const syms = symbol ? [resolve(symbol)] : undefined
        const raws = await requireCcxtMethod('fetchPositions').call(ccxtExchange, syms)
        return raws.filter(p => Math.abs(p.contracts ?? 0) > 0).map(p => mapCcxtPosition(p, exchange))
      })
    },

    async getBalance(asset?: string): Promise<Balance[]> {
      return call('account_read', 'normal', 'getBalance', async () => {
        const resp = await requireCcxtMethod('fetchBalance').call(ccxtExchange)
        const target = asset ?? spec.defaultBalanceAsset ?? 'USDT'
        const free = resp.free ?? {}
        const used = resp.used ?? {}
        const result: Balance[] = []
        for (const [a, avail] of Object.entries(free)) {
          if (a !== target) continue
          result.push({
            exchange,
            asset: a,
            available: avail ?? 0,
            locked: used[a] ?? 0,
            updatedAt: clock.now(),
          })
        }
        return result
      })
    },

    async getServerTime(): Promise<number> {
      return call('time', 'normal', 'getServerTime', async () => {
        const serverTime = await requireCcxtMethod('fetchTime').call(ccxtExchange)
        clock.recordSkew(exchange, serverTime, Date.now())
        return serverTime
      })
    },

    async dispose(): Promise<void> {
      await ccxtExchange.close?.()
    },

    ...spec.buildExtras?.(ccxtExchange),
  }
}
