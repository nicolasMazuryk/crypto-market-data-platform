import { logger } from '../../logger.js'
import type { ResolvedConfig } from '../config/schema.js'
import { queryFundingEvents, queryMainExchangeCrossEvents } from '../data/funding-events.js'
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

  logger.info({ strategy: strategyId, exchange: base.exchange, symbol: base.symbol ?? 'all' }, 'Starting backtest')

  // For S5, initialize with main_exchange fees as fallback; actual per-trade fees are passed per call.
  const feeExchange =
    strategyConfig.strategy_id === 'strategy_5' ? strategyConfig.main_exchange : base.exchange
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

  // Handle S5 separately (main-exchange-driven, scans all target exchanges)
  if (strategyConfig.strategy_id === 'strategy_5') {
    const s5Config = strategyConfig
    const s5Strategy = strategy as Strategy5

    // Pass only user-specified exclusions; queryMainExchangeCrossEvents auto-adds main_exchange
    const crossEvents = await queryMainExchangeCrossEvents(
      s5Config.main_exchange,
      s5Config.exclude_exchanges,
      base.symbol,
      base.start_date,
      base.end_date,
      s5Config.main_exchange_funding_threshold,
      s5Config.min_funding_spread,
      base.funding_time_tolerance_seconds
    )

    totalEventsScanned = crossEvents.length
    logger.info(
      { events: crossEvents.length, main_exchange: s5Config.main_exchange },
      'Found main-exchange cross events'
    )

    const FETCH_CONCURRENCY_S5 = 30
    for (let i = 0; i < crossEvents.length; i += FETCH_CONCURRENCY_S5) {
      const batch = crossEvents.slice(i, i + FETCH_CONCURRENCY_S5)
      const pairs = await Promise.all(
        batch.map(async crossEvent => ({
          crossEvent,
          windowTarget: await fetchOrderbookWindow(
            crossEvent.target_exchange,
            crossEvent.symbol,
            crossEvent.funding_time,
            base.window
          ),
        }))
      )

      for (const { crossEvent, windowTarget } of pairs) {
        totalDataRows += windowTarget.length

        const validation = validateEventData(windowTarget, crossEvent.funding_time, base.validation)
        if (!validation.valid) {
          for (const reason of validation.skipReasons) allSkipReasons.push(reason)
          continue
        }

        triggeredCount++

        const targetFeeSchedule = base.fees[crossEvent.target_exchange] ?? feeSchedule

        const fakeEvent: FundingEvent = {
          exchange: crossEvent.target_exchange,
          symbol: crossEvent.symbol,
          funding_time: crossEvent.funding_time,
          funding_rate: crossEvent.target_funding_rate,
        }

        const result = s5Strategy.executeMainExchange(
          fakeEvent,
          windowTarget,
          crossEvent.main_funding_rate,
          crossEvent.target_funding_rate,
          crossEvent.target_funding_time,
          targetFeeSchedule
        )

        if (result) {
          trades.push(result)
        } else {
          unfilledCount++
        }
      }

      if (i > 0 && i % 1000 === 0) {
        logger.info({ processed: i, total: crossEvents.length }, 'Backtest progress')
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

        const result = strategy.execute(event, window)
        if (result) {
          trades.push(result)
        } else {
          unfilledCount++
        }
      }

      if (i > 0 && i % 1000 === 0) {
        logger.info({ processed: i, total: events.length }, 'Backtest progress')
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
