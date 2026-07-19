import { ccxtIdMap } from '../../markets/ccxtIdMap.js'
import type { CcxtOrder } from '../../../exchanges/types.js'
import type { OrderRequest, OrderRef } from './types.js'
import { createCcxtRestAdapter, type CcxtAdapterSpec, type BaseRestAdapterOptions } from './ccxt-base.js'

interface JsonParserHost {
  parseJson?: (text: string) => unknown
  onJsonResponse?: (text: string) => string
}

const MAX_SAFE_INTEGER_TEXT = String(Number.MAX_SAFE_INTEGER)

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isUnsafeIntegerLiteral(raw: string): boolean {
  const abs = raw.startsWith('-') ? raw.slice(1) : raw
  const normalized = abs.replace(/^0+/, '') || '0'
  return (
    normalized.length > MAX_SAFE_INTEGER_TEXT.length ||
    (normalized.length === MAX_SAFE_INTEGER_TEXT.length && normalized > MAX_SAFE_INTEGER_TEXT)
  )
}

function quoteLargeIntegersInJson(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  let escaped = false

  while (i < text.length) {
    const ch = text.charAt(i)

    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      i += 1
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }

    if (ch === '-' || isDigit(ch)) {
      const start = i
      if (ch === '-') i += 1
      while (isDigit(text[i])) i += 1

      let isInteger = true
      if (text[i] === '.') {
        isInteger = false
        i += 1
        while (isDigit(text[i])) i += 1
      }
      if (text[i] === 'e' || text[i] === 'E') {
        isInteger = false
        i += 1
        if (text[i] === '+' || text[i] === '-') i += 1
        while (isDigit(text[i])) i += 1
      }

      const raw = text.slice(start, i)
      out += isInteger && isUnsafeIntegerLiteral(raw) ? `"${raw}"` : raw
      continue
    }

    out += ch
    i += 1
  }

  return out
}

const gateioSpec: CcxtAdapterSpec = {
  exchange: 'gateio',
  ccxtId: ccxtIdMap.gateio,
  ccxtOptions: { defaultType: 'swap' },
  // Gate.io rejects duplicate text fields with TEXT_DUPLICATED (verify on live smoke run)
  duplicateOrderCodes: new Set(['TEXT_DUPLICATED']),
  // Gate.io returns TEXT_DUPLICATED/ORDER_NOT_FOUND/ORDER_FINISHED when an order is already gone;
  // treat all three as cancel-success so callers see the order as absent, not as an error.
  // INVALID_PARAM_VALUE is NOT in this set: cancel-by-text on stop_market orders returns
  // INVALID_PARAM_VALUE because Gate.io does not associate text with trigger orders.
  // The caller (cancelSiblingExit) must fall through to cancel-by-exchangeOrderId (Strategy B).
  cancelIgnoreCodes: new Set(['TEXT_DUPLICATED', 'ORDER_NOT_FOUND', 'ORDER_FINISHED']),
  setLeverage: async (ccxtEx, unified, leverage) => {
    if (!ccxtEx.setLeverage) return
    try {
      await ccxtEx.setLeverage(leverage, unified)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // CCXT throws "not support this market type" for Gate.io perps; leverage is
      // set per-position via the order request instead — safe to skip here.
      if (msg.includes('not support this market type') || msg.includes('NotSupported')) return
      throw err
    }
  },
  setPositionMode: async (ccxtEx, hedged) => {
    if (!ccxtEx.setPositionMode) return
    try {
      await ccxtEx.setPositionMode(hedged, undefined, { settle: 'usdt' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('NO_CHANGE') || msg.includes('no change')) return
      throw err
    }
  },
  postBuildCcxt: ccxtEx => {
    const host = ccxtEx as JsonParserHost
    host.parseJson = (text: string): unknown => {
      try {
        const trimmed = text.trim()
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
        const responseText = host.onJsonResponse ? host.onJsonResponse(trimmed) : trimmed
        return JSON.parse(quoteLargeIntegersInJson(responseText)) as unknown
      } catch {
        return undefined
      }
    }
  },
  // CCXT does not expose setMarginMode for Gate.io perps; margin mode is injected
  // per-order via marginMode:'cross' in buildCreateOrderParams instead.
  setMarginMode: async () => {
    /* no-op */
  },
  // Gate.io's CCXT path for perp triggers only recognises 'market' and 'limit'.
  // 'stop_market' is unknown → CCXT skips the isMarketOrder branch → initial.price
  // becomes priceToPrecision(symbol, undefined) which is rejected. Map to 'market'
  // so CCXT sets initial.price = '0' and routes to the price-triggered endpoint.
  mapCcxtOrderType: (req: OrderRequest) => (req.type === 'stop_market' ? 'market' : req.type),
  buildCreateOrderParams: (req: OrderRequest) => {
    const p: Record<string, unknown> = {
      // Gate.io CCXT does not expose setMarginMode; inject cross margin per-order as a defensive measure.
      marginMode: 'cross',
    }
    // For price-triggered orders (SL), CCXT cannot relay `text` into initial.text;
    // it would land at the top level of the price_orders body which Gate.io rejects.
    if (req.stopPrice === undefined) p.text = req.clientOrderId
    if (req.leverage !== undefined) p.leverage = req.leverage
    // Use CCXT's unified camelCase key so it's placed inside initial.reduce_only for
    // trigger orders (CCXT omits `reduceOnly` and sets request['initial']['reduce_only']).
    if (req.reduceOnly) p.reduceOnly = true
    // Pass as `timeInForce` so CCXT maps it through options['timeInForce'] → lowercase value
    // ('GTC'→'gtc', 'IOC'→'ioc', …). Passing `tif` directly bypasses the mapping and
    // leaves the raw uppercase string in the request, which Gate.io rejects.
    if (req.timeInForce) p.timeInForce = req.timeInForce
    if (req.stopPrice !== undefined) p.stopPrice = req.stopPrice
    return p
  },
  buildCancelOrderParams: (ref: OrderRef) => {
    const p: Record<string, unknown> = {}
    // Gate.io cancel requires the exchange order_id; text-based cancel is unreliable.
    // cancelOrder is always called with exchangeOrderId when available (set in s.exitOrderRefs).
    // For cancels with only clientOrderId, pass text — but WS-placed orders use 't-' prefix.
    if (ref.clientOrderId) p.text = ref.clientOrderId
    return p
  },
  buildFetchOrderParams: (ref: OrderRef) => ({
    text: ref.clientOrderId ?? '',
  }),
  // Gate.io WS-placed orders use text = 't-' + clientOrderId. When only clientOrderId is
  // known (exchangeOrderId unavailable), try plain text first then t-prefixed fallback.
  getOrder: async (ccxtEx, ref, unified) => {
    if (ref.exchangeOrderId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const raw = (await (ccxtEx as any).fetchOrder(ref.exchangeOrderId, unified)) as CcxtOrder
        return raw
      } catch {
        return undefined
      }
    }
    const clientId = ref.clientOrderId ?? ''
    // Try plain clientOrderId first (REST-placed orders), then 't-' prefixed (WS-placed orders).
    for (const text of [clientId, `t-${clientId}`]) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const raw = (await (ccxtEx as any).fetchOrder('', unified, { text })) as CcxtOrder | undefined
        if (raw) return raw
      } catch {
        // try next
      }
    }
    return undefined
  },
}

export type GateioRestAdapterOptions = BaseRestAdapterOptions

export function createGateioRestAdapter(opts: GateioRestAdapterOptions): ReturnType<typeof createCcxtRestAdapter> {
  return createCcxtRestAdapter(gateioSpec, opts)
}
