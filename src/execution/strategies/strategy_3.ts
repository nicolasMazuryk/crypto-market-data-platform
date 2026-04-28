import type { Exchange } from '../types/exchange.js'
import type { ExecutionIds } from '../core/ids.js'
import { computeOrderQty } from './shared/sizing.js'
import type { EvalContext, StrategyRule, TradeIntent } from './types.js'

// TP is computed from the funding rate at decision time
// (variant A: |F|*1.5, variant B: |F|+0.4).
export function createStrategy3Rule(opts: {
  variant: 'A' | 'B'
  ids: ExecutionIds
  refPrice: (exchange: Exchange, symbol: string) => number | undefined
}): StrategyRule {
  const { variant, ids, refPrice } = opts
  const ruleId = variant === 'A' ? ('strategy_3a' as const) : ('strategy_3b' as const)

  return {
    id: ruleId,
    evaluate(ctx: EvalContext): TradeIntent[] {
      if (ctx.config.id !== ruleId) return []
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

      const tpPct =
        variant === 'A'
          ? Math.abs(snap.fundingRatePercent) * config.tpVariantAMultiplier
          : Math.abs(snap.fundingRatePercent) + config.tpVariantBOffsetPercent

      const entryAt = nextFundingTimestamp - config.entryOffsetSeconds * 1000

      return [
        {
          id: ids.intentId(ruleId, ctx.exchange, snap.symbol, nextFundingTimestamp),
          strategy: ruleId,
          exchange: ctx.exchange,
          symbol: snap.symbol,
          exchangeSymbol: snap.exchangeSymbol,
          side: 'short',
          amountUsd: config.amountUsd,
          leverage: config.leverage,
          volume: qty,
          fundingRate: snap.fundingRate,
          fundingRatePercent: snap.fundingRatePercent,
          fundingInterval,
          nextFundingTimestamp,
          nextFundingDatetime: snap.nextFundingDatetime,
          decidedAt: ctx.now,
          entryAt,
          exitPolicy: {
            kind: 'sl_tp_deadline',
            slPct: config.stopLossPercent,
            tpPct,
            deadlineAt: nextFundingTimestamp + config.deadlineSeconds * 1000,
            tpVariant: config.tpVariant, // audit label — not read by manager; tpPct encodes the result
          },
        },
      ]
    },
  }
}
