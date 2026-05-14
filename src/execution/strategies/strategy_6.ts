import type { Exchange } from '../types/exchange.js'
import type { ExecutionIds } from '../core/ids.js'
import { computeOrderQty, computeMinOrderQty } from './shared/sizing.js'
import type { EvalContext, Side, StrategyRule, TradeIntent } from './types.js'

/**
 * Strategy 6: Post-funding directional (LONG or SHORT), WS-gated entry. Live-only.
 *
 * A tiny PRE_FUNDING_ORDER (opposite direction, minimum size) is placed before T_funding to
 * subscribe the symbol into the private WS funding-fee event stream. The MAIN order (mainSide,
 * mainAmountUsd) is placed on the ws.funding_fee event. Net position = mainVolume − preFundingVolume.
 * TP/SL/deadline manage exit.
 */
export function createStrategy6Rule(opts: {
  ids: ExecutionIds
  refPrice: (exchange: Exchange, symbol: string) => number | undefined
}): StrategyRule {
  const { ids, refPrice } = opts

  return {
    id: 'strategy_6',
    evaluate(ctx: EvalContext): TradeIntent[] {
      if (ctx.config.id !== 'strategy_6') return []
      const config = ctx.config

      const snap = ctx.snapshots.get(ctx.fundingEvent.symbol)
      if (!snap) return []

      const t = config.funding_threshold
      if (t > 0 && snap.fundingRatePercent < t) return []
      if (t < 0 && snap.fundingRatePercent > t) return []

      const market = ctx.markets(ctx.fundingEvent.symbol)
      if (market?.status !== 'trading') return []

      const price = refPrice(ctx.exchange, ctx.fundingEvent.symbol)
      if (price === undefined) return []

      const mainQty = computeOrderQty(config.mainAmountUsd, price, config.leverage, market)
      if (mainQty === null) return []

      const preFundingQty = computeMinOrderQty(market, price)
      if (preFundingQty === null) return []

      // Skip if pre-funding volume would consume the entire main volume (no net exposure)
      if (preFundingQty >= mainQty) return []

      const { nextFundingTimestamp, fundingInterval } = ctx.fundingEvent
      const preFundingSide: Side = config.mainSide === 'long' ? 'short' : 'long'

      return [
        {
          id: ids.intentId('strategy_6', ctx.exchange, snap.symbol, nextFundingTimestamp),
          strategy: 'strategy_6',
          exchange: ctx.exchange,
          symbol: snap.symbol,
          exchangeSymbol: snap.exchangeSymbol,
          side: config.mainSide,
          amountUsd: config.mainAmountUsd,
          leverage: config.leverage,
          volume: mainQty,
          fundingRate: snap.fundingRate,
          fundingRatePercent: snap.fundingRatePercent,
          fundingInterval,
          nextFundingTimestamp,
          nextFundingDatetime: snap.nextFundingDatetime,
          decidedAt: ctx.now,
          entryAt: nextFundingTimestamp - config.entryOffsetSeconds * 1000,
          entryPolicy: {
            kind: 'pre_funding_then_main',
            preFundingSide,
            preFundingVolume: preFundingQty,
            mainSide: config.mainSide,
            mainVolume: mainQty,
          },
          exitPolicy: {
            kind: 'sl_tp_deadline_post_funding_event',
            tpMultiplier: config.tpMultiplier,
            slMultiplier: config.slMultiplier,
            fundingTs: nextFundingTimestamp,
            timeoutAt: nextFundingTimestamp + config.fundingFeeTimeoutSeconds * 1000,
            deadlineAt: nextFundingTimestamp + config.deadlineSeconds * 1000,
          },
        },
      ]
    },
  }
}
