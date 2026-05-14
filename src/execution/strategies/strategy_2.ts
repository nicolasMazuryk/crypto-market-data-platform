import type { Exchange } from '../types/exchange.js'
import type { ExecutionIds } from '../core/ids.js'
import { computeOrderQty } from './shared/sizing.js'
import type { EvalContext, StrategyRule, TradeIntent } from './types.js'

/**
 * Strategy 2: Negative Funding LONG, retracement exit.
 *
 * Entry: market buy at T_funding − entryOffsetSeconds.
 * Exit: SL at entry × (1 − |F%| × slMultiplier / 100); TP is a dynamic retracement
 *   target tracked by the execution manager after T_funding; deadline closes the position.
 */
export function createStrategy2Rule(opts: {
  ids: ExecutionIds
  refPrice: (exchange: Exchange, symbol: string) => number | undefined
}): StrategyRule {
  const { ids, refPrice } = opts

  return {
    id: 'strategy_2',
    evaluate(ctx: EvalContext): TradeIntent[] {
      if (ctx.config.id !== 'strategy_2') return []
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
      const slPct = Math.abs(snap.fundingRatePercent) * config.slMultiplier

      return [
        {
          id: ids.intentId('strategy_2', ctx.exchange, snap.symbol, nextFundingTimestamp),
          strategy: 'strategy_2',
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
          entryPolicy: { kind: 'market' },
          exitPolicy: {
            kind: 'sl_tp_deadline_retracement_funding_event',
            slPct,
            retracementPct: config.retracementPct,
            anchorPrice: price,
            deadlineAt: nextFundingTimestamp + config.deadlineSeconds * 1000,
            fundingTs: nextFundingTimestamp,
            timeoutAt: nextFundingTimestamp + config.fundingFeeTimeoutSeconds * 1000,
          },
        },
      ]
    },
  }
}
