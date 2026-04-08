import { logger } from '../../logger.js'
import type { ResolvedConfig } from '../config/schema.js'
import { queryFundingEvents, queryCrossExchangeFundingEvents } from '../data/funding-events.js'
import { fetchOrderbookWindow } from '../data/orderbook-window.js'
import { validateEventData } from '../data/validation.js'
import type { FundingEvent, SkipReason } from '../data/types.js'
import { createStrategy } from '../strategies/registry.js'
import type { TradeResult } from '../strategies/types.js'
import type { Strategy5 } from '../strategies/strategy-5.js'
import { buildReport } from '../reporting/report-builder.js'
import type { BacktestReport } from '../reporting/types.js'
import { getGitCommit } from './utils.js'

export interface BacktestRunResult {
  report: BacktestReport
  trades: TradeResult[]
}

export async function runBacktestEngine(config: ResolvedConfig): Promise<BacktestRunResult> {
  const { base, strategy: strategyConfig } = config
  const strategyId = strategyConfig.strategy_id

  logger.info({ strategy: strategyId, exchange: base.exchange, symbol: base.symbol }, 'Starting backtest')

  // Get fee schedule for the exchange where trades execute.
  // Strategy 5 trades on exchange_b, not base.exchange.
  const feeExchange = strategyId === 'strategy_5' ? strategyConfig.exchange_b : base.exchange
  const feeSchedule = base.fees[feeExchange]
  if (!feeSchedule) {
    throw new Error(`No fee schedule configured for exchange: ${feeExchange}`)
  }

  // Create and initialize strategy
  const strategy = createStrategy(strategyId)
  strategy.initialize(strategyConfig, feeSchedule, base.slippage.stop_order_slippage)

  const trades: TradeResult[] = []
  const allSkipReasons: SkipReason[] = []
  let triggeredCount = 0
  let unfilledCount = 0
  let totalEventsScanned = 0
  let totalDataRows = 0

  // Handle S5 separately (cross-exchange)
  if (strategyId === 'strategy_5') {
    const s5Config = strategyConfig
    const s5Strategy = strategy as Strategy5

    const crossEvents = await queryCrossExchangeFundingEvents(
      s5Config.exchange_a,
      s5Config.exchange_b,
      base.symbol,
      base.start_date,
      base.end_date,
      s5Config.funding_threshold_a,
      s5Config.funding_max_b,
      s5Config.funding_spread_threshold
    )

    totalEventsScanned = crossEvents.length
    logger.info({ events: crossEvents.length }, 'Found cross-exchange funding events')

    for (const crossEvent of crossEvents) {
      // Fetch Exchange B's data window
      const windowB = await fetchOrderbookWindow(s5Config.exchange_b, base.symbol, crossEvent.funding_time, base.window)

      totalDataRows += windowB.length

      const validation = validateEventData(windowB, crossEvent.funding_time, base.validation)
      if (!validation.valid) {
        for (const reason of validation.skipReasons) allSkipReasons.push(reason)
        continue
      }

      triggeredCount++

      const fakeEvent: FundingEvent = {
        exchange: s5Config.exchange_b,
        symbol: base.symbol,
        funding_time: crossEvent.funding_time,
        funding_rate: crossEvent.funding_rate_b,
      }

      const result = s5Strategy.executeWithCrossExchange(
        fakeEvent,
        windowB,
        crossEvent.funding_rate_a,
        crossEvent.funding_rate_b
      )

      if (result) {
        trades.push(result)
      } else {
        unfilledCount++
      }
    }
  } else {
    // Standard single-exchange strategies
    const fundingThreshold = 'funding_threshold' in strategyConfig ? strategyConfig.funding_threshold : 0

    const events = await queryFundingEvents(
      base.exchange,
      base.symbol,
      base.start_date,
      base.end_date,
      fundingThreshold
    )

    totalEventsScanned = events.length
    logger.info({ events: events.length }, 'Found funding events meeting threshold')

    for (const event of events) {
      const window = await fetchOrderbookWindow(event.exchange, event.symbol, event.funding_time, base.window)

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

      const result = strategy.execute(event, window)
      if (result) {
        trades.push(result)
      } else {
        unfilledCount++
      }
    }
  }

  logger.info(
    {
      trades: trades.length,
      skipped: allSkipReasons.length,
      triggered: triggeredCount,
      unfilled: unfilledCount,
    },
    'Backtest complete'
  )

  const gitCommit = getGitCommit()

  const report = buildReport({
    config,
    trades,
    totalEventsScanned,
    skipReasons: allSkipReasons,
    triggeredCount,
    unfilledCount,
    dataRowCount: totalDataRows,
    gitCommit,
  })

  return { report, trades }
}
