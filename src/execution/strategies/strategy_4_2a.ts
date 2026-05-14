import type { Exchange } from '../types/exchange.js'
import type { ExecutionIds } from '../core/ids.js'
import { computeOrderQty } from './shared/sizing.js'
import type { EvalContext, StrategyRule, TradeIntent } from './types.js'

/**
 * Strategy 4.2a: Negative Funding single-limit LONG, no funding accrual.
 *
 * Entry: one limit buy at P × (1 − |F%| × limitOffsetMult / 100), placed entryOffsetSeconds
 *   before T_funding. The limit fills after T_funding (scenario A — no funding fee accrued).
 * Exit: SL at fill × (1 − |F%| × slMultiplier / 100), TP at fill + takeProfitPct%, deadline.
 * Constraint: slMultiplier > limitOffsetMult (enforced in schema).
 */
export function createStrategy4_2aRule(opts: {
  ids: ExecutionIds
  refPrice: (exchange: Exchange, symbol: string) => number | undefined
}): StrategyRule {
  const { ids, refPrice } = opts

  return {
    id: 'strategy_4_2a',
    evaluate(ctx: EvalContext): TradeIntent[] {
      if (ctx.config.id !== 'strategy_4_2a') return []
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
      // priceOffsetPct: percent below current price for limit entry (e.g. 0.3 for 0.3%)
      const priceOffsetPct = absF * config.limitOffsetMult
      const deadlineAt = nextFundingTimestamp + config.deadlineSeconds * 1000

      return [
        {
          id: ids.intentId('strategy_4_2a', ctx.exchange, snap.symbol, nextFundingTimestamp),
          strategy: 'strategy_4_2a',
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
          entryPolicy: { kind: 'limit', priceOffsetPct, expireAt: deadlineAt },
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
