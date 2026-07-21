import type { Exchange } from '../types/exchange.js'
import type { ExecutionIds } from '../core/ids.js'
import { computeOrderQty, lotStep, meetsMinNotional, alignToLotStep } from './shared/sizing.js'
import type { EvalContext, StrategyRule, TradeIntent } from './types.js'

/**
 * Strategy 4.1a: Negative Funding ladder LONG, no funding accrual.
 *
 * Places ladderCount limit buy orders spread between:
 *   topPrice    = P × (1 − |F%| × ladderTopMult / 100)
 *   bottomPrice = P × (1 − |F%| × ladderBottomMult / 100)
 * (ladderBottomMult > ladderTopMult, so bottomPrice < topPrice)
 *
 * Quantity per rung = totalQty / ladderCount (largest-remainder distributed).
 *
 * R11 lifecycle (manager.ts): the SL is placed WITH the ladder, fixed at
 * P_avg_full = Σ prices[i]·qty[i] / Σ qty[i] over the rungs actually placed — precomputable
 * from this rule's rungs/qtyFraction output, independent of which ones eventually fill. The TP
 * is placed on the first rung fill and cancelled + re-placed on each deeper fill at the running
 * fill-weighted average. Unfilled rungs stay live until SL/TP/deadline fires — never cancelled
 * at T_funding.
 *
 * Scenario A (no funding accrual): limits are placed below current ask so they fill
 * after T_funding during the expected funding-driven dump.
 */
export function createStrategy4_1aRule(opts: {
  ids: ExecutionIds
  refPrice: (exchange: Exchange, symbol: string) => number | undefined
}): StrategyRule {
  const { ids, refPrice } = opts

  return {
    id: 'strategy_4_1a',
    evaluate(ctx: EvalContext): TradeIntent[] {
      if (ctx.config.id !== 'strategy_4_1a') return []
      const config = ctx.config

      const snap = ctx.snapshots.get(ctx.fundingEvent.symbol)
      if (!snap) return []

      if (snap.fundingRatePercent > -Math.abs(config.negativeFundingThresholdPercent)) return []

      const market = ctx.markets(ctx.fundingEvent.symbol)
      if (market?.status !== 'trading') return []

      const price = refPrice(ctx.exchange, ctx.fundingEvent.symbol)
      if (price === undefined) return []

      const qty = computeOrderQty(config.amountUsd, price, config.leverage, market)
      if (qty === null) return []

      const { nextFundingTimestamp, fundingInterval } = ctx.fundingEvent
      const absF = Math.abs(snap.fundingRatePercent)
      const slPct = absF * config.slMultiplier
      const deadlineAt = nextFundingTimestamp + config.deadlineSeconds * 1000
      const n = config.ladderCount
      const topOffset = absF * config.ladderTopMult
      const bottomOffset = absF * config.ladderBottomMult

      // Distribute quantity across rungs using largest-remainder to avoid rounding loss.
      const step = lotStep(market.amountPrecision)
      const baseQty = Math.floor(qty / n / step) * step
      const remainder = Math.round((qty - baseQty * n) / step)

      const rungs = Array.from({ length: n }, (_, i) => {
        const rungQty = baseQty + (i < remainder ? step : 0)
        // Evenly spaced in price-offset space from top to bottom
        const priceOffsetPct = n === 1 ? topOffset : topOffset + (i * (bottomOffset - topOffset)) / (n - 1)
        return { priceOffsetPct, qtyFraction: rungQty / qty }
      })

      // Skip symbol if even the largest rung at the highest (most favourable) limit price
      // would fall below minNotional — all rungs would be rejected at submission.
      if (rungs[0] !== undefined) {
        const topLimitPrice = price * (1 - rungs[0].priceOffsetPct / 100)
        const maxRungQty = alignToLotStep(qty * rungs[0].qtyFraction, market)
        if (!meetsMinNotional(maxRungQty, topLimitPrice, market)) return []
      }

      return [
        {
          id: ids.intentId('strategy_4_1a', ctx.exchange, snap.symbol, nextFundingTimestamp),
          strategy: 'strategy_4_1a',
          exchange: ctx.exchange,
          symbol: snap.symbol,
          exchangeSymbol: snap.exchangeSymbol,
          side: 'long',
          amountUsd: config.amountUsd,
          leverage: config.leverage,
          volume: qty,
          fundingRate: snap.fundingRate,
          fundingRatePercent: snap.fundingRatePercent,
          fundingInterval,
          nextFundingTimestamp,
          nextFundingDatetime: snap.nextFundingDatetime,
          decidedAt: ctx.now,
          entryAt: nextFundingTimestamp - config.entryOffsetSeconds * 1000,
          entryPolicy: { kind: 'ladder_limit', rungs, expireAt: deadlineAt },
          exitPolicy: {
            kind: 'sl_tp_deadline',
            slPct,
            tpPct: config.takeProfitPct,
            deadlineAt,
            tpVariant: 'A',
          },
        },
      ]
    },
  }
}
