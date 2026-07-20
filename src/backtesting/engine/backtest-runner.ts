import { logger } from '../../logger.js'
import type { ResolvedConfig } from '../config/schema.js'
import { queryFundingEvents } from '../data/funding-events.js'
import { fetchOrderbookWindow } from '../data/orderbook-window.js'
import { validateEventData } from '../data/validation.js'
import type { SkipReason } from '../data/types.js'

import { createStrategy } from '../strategies/registry.js'
import type { TradeResult } from '../strategies/types.js'
import type { ErrorCode } from '../config/schema.js'
import { buildReport } from '../reporting/report-builder.js'
import type { BacktestReport } from '../reporting/types.js'
import { getGitCommit } from './utils.js'
import { buildLookaheadContext } from './localization.js'

export interface BacktestRunResult {
  report: BacktestReport
  trades: TradeResult[]
}

function compareTrades(a: TradeResult, b: TradeResult): number {
  return (
    a.funding_time.getTime() - b.funding_time.getTime() ||
    a.exchange.localeCompare(b.exchange) ||
    a.symbol.localeCompare(b.symbol) ||
    a.strategy_id.localeCompare(b.strategy_id)
  )
}

export async function runBacktestEngine(config: ResolvedConfig): Promise<BacktestRunResult> {
  const { base, strategy: strategyConfig } = config
  const strategyId = strategyConfig.strategy_id

  logger.info({ strategy: strategyId, exchange: base.exchange, symbol: base.symbol ?? 'all' }, 'Starting backtest')

  const feeSchedule = base.fees[base.exchange]
  if (!feeSchedule) {
    throw new Error(`No fee schedule configured for exchange: ${base.exchange}`)
  }

  // Create and initialize strategy
  const strategy = createStrategy(strategyId)
  strategy.initialize(
    strategyConfig,
    feeSchedule,
    base.market_slippage_pct / 100,
    base.order_latency_ms,
    base.funding_settlement
  )

  const trades: TradeResult[] = []
  const errorCodes: ErrorCode[] = []
  const allSkipReasons: SkipReason[] = []
  let triggeredCount = 0
  let unfilledCount = 0
  let totalEventsScanned = 0
  let totalDataRows = 0

  const fundingThreshold =
    'negative_funding_threshold_percent' in strategyConfig
      ? Math.abs(strategyConfig.negative_funding_threshold_percent) / 100
      : 0

  const events = await queryFundingEvents(base.exchange, base.symbol, base.start_date, base.end_date, fundingThreshold)

  totalEventsScanned = events.length
  logger.info({ events: events.length }, 'Found funding events meeting threshold')

  const FETCH_CONCURRENCY = 30
  for (let i = 0; i < events.length; i += FETCH_CONCURRENCY) {
    const batch = events.slice(i, i + FETCH_CONCURRENCY)
    const pairs = await Promise.all(
      batch.map(async event => ({
        event,
        window: await fetchOrderbookWindow(event.exchange, event.symbol, event.funding_time, base.window),
      }))
    )

    for (const { event, window } of pairs) {
      totalDataRows += window.length

      const validation = validateEventData(window, event.funding_time, base.validation)
      if (!validation.valid) {
        for (const reason of validation.skipReasons) allSkipReasons.push(reason)
        logger.debug({ event: event.funding_time, reasons: validation.skipReasons }, 'Skipping event')
        continue
      }

      if (!strategy.shouldTrigger(event)) {
        continue
      }

      triggeredCount++

      // Engine performs the one sanctioned lookahead (§3.2): localize T_drop and hand the
      // strategy a time-gated window. Strategies that key off T_settle ignore the context.
      const context = buildLookaheadContext(window, event.funding_time, event.funding_rate, {
        dropSearchWindowSeconds: base.drop_search_window_seconds,
        dropQualifierFundingMult: base.drop_qualifier_funding_mult,
        dropQualifierRangeMult: base.drop_qualifier_range_mult,
      })

      const result = strategy.execute(event, window, context)
      if (result === null) {
        unfilledCount++
      } else if ('error_code' in result) {
        errorCodes.push(result.error_code)
      } else {
        trades.push(result)
      }
    }

    if (i > 0 && i % 1000 === 0) {
      logger.info({ processed: i, total: events.length }, 'Backtest progress')
    }
  }

  const tradesOpenAtEnd = 0

  logger.info(
    {
      trades: trades.length,
      skipped: allSkipReasons.length,
      triggered: triggeredCount,
      unfilled: unfilledCount,
      openAtEnd: tradesOpenAtEnd,
    },
    'Backtest complete'
  )

  const gitCommit = getGitCommit()
  trades.sort(compareTrades)

  const report = buildReport({
    config,
    trades,
    errorCodes,
    totalEventsScanned,
    skipReasons: allSkipReasons,
    triggeredCount,
    unfilledCount,
    tradesOpenAtEnd,
    dataRowCount: totalDataRows,
    gitCommit,
  })

  return { report, trades }
}
