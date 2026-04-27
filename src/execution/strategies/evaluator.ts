import type { Logger } from 'pino'

import type { Clock, EventBus } from '../core/types.js'
import type { FundingRateSource } from '../funding/types.js'
import type { MarketMetadataProvider } from '../markets/types.js'
import type { ExecutionMetrics } from '../observability/metrics.js'
import type { Tracer } from '../observability/types.js'
import type { Exchange } from '../types/exchange.js'
import type { EvalContext, StrategyConfig, StrategyEvaluator, StrategyId, TradeIntent } from './types.js'
import type { StrategyRegistry } from './registry.js'

export interface StrategyEvaluatorOptions {
  bus: EventBus
  clock: Clock
  logger: Logger
  metrics: ExecutionMetrics
  registry: StrategyRegistry
  funding: FundingRateSource
  markets: MarketMetadataProvider
  configsByStrategy: Map<StrategyId, StrategyConfig>
  symbolFilter?: Set<string>
  tracer?: Tracer
}

export function createStrategyEvaluator(opts: StrategyEvaluatorOptions): StrategyEvaluator {
  const { bus, clock, logger, metrics, registry, funding, markets, configsByStrategy, symbolFilter, tracer } = opts

  return {
    evaluate(exchange: Exchange, fundingEventSymbol: string): TradeIntent[] {
      const span = tracer?.startSpan('evaluator.evaluate', { exchange, symbol: fundingEventSymbol })
      if (symbolFilter && !symbolFilter.has(fundingEventSymbol)) {
        logger.debug({ exchange, symbol: fundingEventSymbol }, 'evaluator: symbol filtered')
        span?.end()
        return []
      }

      const snapshots = funding.latest(exchange)
      const triggerSnap = snapshots.get(fundingEventSymbol)
      if (!triggerSnap) {
        logger.warn({ exchange, symbol: fundingEventSymbol }, 'evaluator: funding snapshot not found')
        span?.end()
        return []
      }

      const fundingEvent = {
        symbol: triggerSnap.symbol,
        nextFundingTimestamp: triggerSnap.nextFundingTimestamp,
        fundingInterval: triggerSnap.fundingInterval,
      }

      const allIntents: TradeIntent[] = []

      for (const rule of registry.list()) {
        const config = configsByStrategy.get(rule.id)
        if (config?.enabled !== true) continue

        const ctx: EvalContext = {
          now: clock.now(),
          exchange,
          fundingEvent,
          snapshots,
          markets: (symbol: string) => markets.get(exchange, symbol),
          config,
        }

        try {
          const intents = rule.evaluate(ctx)
          allIntents.push(...intents)
        } catch (err) {
          logger.error({ exchange, strategy: rule.id, err }, 'evaluator: rule threw')
        }
      }

      // Dedupe by (strategy, exchange, symbol, nextFundingTimestamp)
      const seen = new Set<string>()
      const deduped: TradeIntent[] = []
      for (const intent of allIntents) {
        const key = `${intent.strategy}|${intent.exchange}|${intent.symbol}|${String(intent.nextFundingTimestamp)}`
        if (!seen.has(key)) {
          seen.add(key)
          deduped.push(intent)
        }
      }

      for (const intent of deduped) {
        metrics.intentDecidedTotal.inc(1, { exchange, strategy: intent.strategy })
        bus.emit('intent.decided', intent)
        logger.info(
          {
            event: 'intent.decided',
            exchange: intent.exchange,
            strategy: intent.strategy,
            symbol: intent.symbol,
            side: intent.side,
            fundingRate: intent.fundingRate,
            fundingRatePercent: intent.fundingRatePercent,
            entryAt: intent.entryAt,
            exitPolicy: intent.exitPolicy,
          },
          'intent.decided'
        )
      }

      span?.setAttribute('intents_decided', deduped.length)
      span?.end()
      return deduped
    },
  }
}
