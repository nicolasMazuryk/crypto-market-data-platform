import type { Exchange } from '../types/exchange.js'
import type { ExecutionIds } from '../core/ids.js'
import { computeOrderQty } from './shared/sizing.js'
import type { EvalContext, StrategyRule, TradeIntent } from './types.js'

export function createStrategy1Rule(opts: {
  ids: ExecutionIds
  refPrice: (exchange: Exchange, symbol: string) => number | undefined
}): StrategyRule {
  const { ids, refPrice } = opts

  return {
    id: 'strategy_1',
    evaluate(ctx: EvalContext): TradeIntent[] {
      if (ctx.config.id !== 'strategy_1') return []
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

      return [
        {
          id: ids.intentId('strategy_1', ctx.exchange, snap.symbol, nextFundingTimestamp),
          strategy: 'strategy_1',
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
          exitPolicy: {
            kind: 'timed',
            exitAt: nextFundingTimestamp + config.exitOffsetSeconds * 1000,
          },
        },
      ]
    },
  }
}
