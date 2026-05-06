import type { FeeSchedule, SpotFuturesConfig } from '../config/schema.js'
import type { ExitReason } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { calculateSpotFuturesPnl } from '../pnl/calculator.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'

export const SPOT_FUTURES_ENTRY_OFFSET_SECONDS = 5
export const SPOT_FUTURES_EXIT_OFFSET_SECONDS = 5
export const SPOT_FUTURES_SPREAD_TAKE_PROFIT = 0.02
export const SPOT_FUTURES_SPREAD_WIDENING_THRESHOLD = 0.03

function parseTsToDate(ts: string): Date {
  return new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`)
}

/**
 * Strategy: Delta-Neutral Spot-Futures Funding Capture
 *
 * Simultaneously LONG spot + SHORT perp on the same symbol to harvest
 * positive funding paid by perp longs to perp shorts. The position is
 * carried across one or more funding events; exits trigger on funding
 * floor or spread stop-loss/take-profit.
 *
 * Spot data is currently aliased to perp data (spread_pnl = 0 everywhere).
 * When real spot ingestion exists, only fetchSpotOrderbookWindow changes.
 */
export class SpotFuturesStrategy implements BaseStrategy {
  readonly id = 'strategy_spot_futures'
  private config!: SpotFuturesConfig
  /** Positions still open at end of available data (no exit signal fired). */
  openAtEndCount = 0

  initialize(config: SpotFuturesConfig, _perpFeeSchedule: FeeSchedule, _slippage?: number): void {
    this.config = config
    this.openAtEndCount = 0
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate >= this.config.F_threshold
  }

  // Required by BaseStrategy but not used for this strategy — engine calls executeSpotFutures.
  execute(_event: FundingEvent, _data: OHLCWindow): TradeResult | null {
    return null
  }

  /**
   * Peek-ahead carry loop for alias mode.
   *
   * The trigger event always accrues (it has already settled when we enter).
   * For each subsequent event, we check the rate BEFORE accruing: if it falls
   * below fundingConvergenceThreshold we close just before that settlement
   * and never collect the unprofitable event.
   *
   * Returns null when all provided next events remain above threshold
   * (data exhausted — position stays open).
   */
  private carryAlias(
    perpEvent: FundingEvent,
    nextEvents: FundingEvent[],
    perpWindow: OHLCWindow,
    entryMid: number
  ): {
    exitTs: string
    exitTime: Date
    exitReason: ExitReason
    perpExitPrice: number
    spotExitPrice: number
    funding_pnl: number
    funding_events_collected: number
  } | null {
    const { config } = this

    // Trigger event accrues unconditionally (already settled at entry)
    let funding_pnl = perpEvent.funding_rate
    let funding_events_collected = 1
    let exitFundingEvent: FundingEvent | null = null

    for (const fEvent of nextEvents) {
      if (fEvent.funding_rate <= config.fundingConvergenceThreshold) {
        exitFundingEvent = fEvent
        break
      }
      funding_pnl += fEvent.funding_rate
      funding_events_collected++
    }

    // Data exhausted before any exit signal — position stays open
    if (!exitFundingEvent) return null

    // Exit just before the sub-threshold event settles
    const exitTime = new Date(exitFundingEvent.funding_time.getTime() - SPOT_FUTURES_EXIT_OFFSET_SECONDS * 1000)
    const exitTs = toClickHouseDateTime(exitTime)

    // Find candle for price lookup (alias: use mid-price for both legs → spread_pnl = 0)
    let exitCandle = perpWindow.getRowAt(exitTs)
    exitCandle ??= perpWindow.getAll().find(r => r.ts >= exitTs)
    if (!exitCandle) {
      const lastRow = perpWindow.getAll().at(-1)
      if (!lastRow) return null
      exitCandle = lastRow
    }

    const ask = exitCandle.ask_open
    const bid = exitCandle.bid_open
    const exitMid = ask !== null && bid !== null ? (ask + bid) / 2 : entryMid

    return {
      exitTs: exitCandle.ts,
      exitTime,
      exitReason: 'FUNDING_FLOOR',
      perpExitPrice: exitMid,
      spotExitPrice: exitMid,
      funding_pnl,
      funding_events_collected,
    }
  }

  /**
   * Execute the spot-futures carry trade for a single triggering funding event.
   *
   * @param perpEvent        The triggering positive-funding event on the perp exchange
   * @param perpWindow       Wide orderbook window for the perp leg
   * @param spotWindow       Wide orderbook window for the spot leg (alias mode: same as perp)
   * @param allFundingEvents All funding events from T_trigger through end of wide window
   * @param perpFeeSchedule  Perp taker fee schedule
   * @param spotFee          Spot taker fee per order leg
   */
  executeSpotFutures(
    perpEvent: FundingEvent,
    perpWindow: OHLCWindow,
    spotWindow: OHLCWindow,
    allFundingEvents: FundingEvent[],
    perpFeeSchedule: FeeSchedule,
    spotFee: number
  ): TradeResult | null {
    const { config } = this

    const entryTime = new Date(perpEvent.funding_time.getTime() - SPOT_FUTURES_ENTRY_OFFSET_SECONDS * 1000)
    const entryTs = toClickHouseDateTime(entryTime)

    const perpEntryCandle = perpWindow.getRowAt(entryTs)
    const spotEntryCandle = spotWindow.getRowAt(entryTs)
    if (!perpEntryCandle || !spotEntryCandle) return null

    // Validate fills (ensures ask/bid prices are non-null)
    const spotEntryFill = fillMarketOrder('buy', spotEntryCandle, 1, 'spot_entry')
    const perpEntryFill = fillMarketOrder('sell', perpEntryCandle, 1, 'perp_entry')
    if (!spotEntryFill || !perpEntryFill) return null

    const isAlias = config.spot_exchange === config.perp_exchange

    // F3: alias mode uses mid-price for both legs so entry_spread = 0
    let spotEntryPrice = spotEntryFill.price
    let perpEntryPrice = perpEntryFill.price
    if (isAlias) {
      const ask = perpEntryCandle.ask_open
      const bid = perpEntryCandle.bid_open
      if (ask !== null && bid !== null) {
        const mid = (ask + bid) / 2
        spotEntryPrice = mid
        perpEntryPrice = mid
      }
    }

    const entry_spread = (perpEntryPrice - spotEntryPrice) / spotEntryPrice

    // Profit gate: reject if expected net < minTotalProfit
    const round_trip_fees = 2 * spotFee + 2 * perpFeeSchedule.taker_fee
    if (perpEvent.funding_rate + entry_spread - round_trip_fees < config.minTotalProfit) {
      return null
    }

    // Next funding events strictly after the trigger, ascending
    const nextEvents = allFundingEvents
      .filter(e => e.funding_time > perpEvent.funding_time)
      .sort((a, b) => a.funding_time.getTime() - b.funding_time.getTime())

    if (nextEvents.length === 0) {
      this.openAtEndCount++
      return null
    }

    const T_exit_first = new Date(nextEvents[0].funding_time.getTime() - SPOT_FUTURES_EXIT_OFFSET_SECONDS * 1000)

    let funding_pnl = 0
    let funding_events_collected = 0
    let exitReason: ExitReason = 'FUNDING_FLOOR'
    let exitTs = ''
    let perpExitPrice = perpEntryPrice
    let spotExitPrice = spotEntryPrice
    let logicalExitTime: Date = entryTime // overwritten in every reachable branch below

    if (isAlias) {
      const aliasResult = this.carryAlias(perpEvent, nextEvents, perpWindow, perpEntryPrice)
      if (!aliasResult) {
        this.openAtEndCount++
        return null
      }
      funding_pnl = aliasResult.funding_pnl
      funding_events_collected = aliasResult.funding_events_collected
      exitReason = aliasResult.exitReason
      exitTs = aliasResult.exitTs
      perpExitPrice = aliasResult.perpExitPrice
      spotExitPrice = aliasResult.spotExitPrice
      logicalExitTime = aliasResult.exitTime
    } else {
      // Peek-ahead: accrue trigger event, then inspect each future event before accruing it
      funding_pnl = perpEvent.funding_rate
      funding_events_collected = 1

      let fundingFloorEvent: FundingEvent | null = null
      for (const fEvent of nextEvents) {
        if (fEvent.funding_rate <= config.fundingConvergenceThreshold) {
          fundingFloorEvent = fEvent
          break
        }
        funding_pnl += fEvent.funding_rate
        funding_events_collected++
      }

      // Data exhausted before any exit signal — position stays open
      if (!fundingFloorEvent) {
        this.openAtEndCount++
        return null
      }

      const logicalFundingExitTime = new Date(
        fundingFloorEvent.funding_time.getTime() - SPOT_FUTURES_EXIT_OFFSET_SECONDS * 1000
      )
      const logicalFundingExitTs = toClickHouseDateTime(logicalFundingExitTime)

      logicalExitTime = logicalFundingExitTime
      exitReason = 'FUNDING_FLOOR'

      // Candle loop: check SPREAD_TP / SPREAD_SL up to the funding floor exit time
      for (const perpRow of perpWindow.getAll()) {
        const t = perpRow.ts
        if (t < entryTs) continue
        if (t >= logicalFundingExitTs) break

        if (parseTsToDate(t) < T_exit_first) continue

        const spotRow = spotWindow.getRowAt(t) ?? perpRow
        const { bid_open: perpBid, ask_open: perpAsk } = perpRow
        const { bid_open: spotBid, ask_open: spotAsk } = spotRow
        if (perpBid === null || perpAsk === null || spotBid === null || spotAsk === null) continue

        const perp_mid = (perpBid + perpAsk) / 2
        const spot_mid = (spotBid + spotAsk) / 2
        const current_spread = (perp_mid - spot_mid) / spotEntryPrice
        const spread_pnl_current = entry_spread - current_spread

        if (spread_pnl_current >= SPOT_FUTURES_SPREAD_TAKE_PROFIT) {
          exitReason = 'SPREAD_TP'
          exitTs = t
          logicalExitTime = parseTsToDate(t)
          perpExitPrice = perpAsk
          spotExitPrice = spotBid
          break
        }

        if (current_spread - entry_spread >= SPOT_FUTURES_SPREAD_WIDENING_THRESHOLD) {
          exitReason = 'SPREAD_SL'
          exitTs = t
          logicalExitTime = parseTsToDate(t)
          perpExitPrice = perpAsk
          spotExitPrice = spotBid
          break
        }
      }

      // If no spread exit triggered, exit at funding floor time
      if (!exitTs) {
        exitTs = logicalFundingExitTs
        let exitCandle = perpWindow.getRowAt(logicalFundingExitTs)
        exitCandle ??= perpWindow.getAll().find(r => r.ts >= logicalFundingExitTs)
        if (!exitCandle) {
          const lastRow = perpWindow.getAll().at(-1)
          if (!lastRow) return null
          exitCandle = lastRow
        }
        const spotExitCandle = spotWindow.getRowAt(logicalFundingExitTs) ?? exitCandle
        perpExitPrice = exitCandle.ask_open ?? perpEntryPrice
        spotExitPrice = spotExitCandle.bid_open ?? spotEntryPrice
      }
    }

    const exit_spread = (perpExitPrice - spotExitPrice) / spotEntryPrice

    const pnl = calculateSpotFuturesPnl({
      entrySpread: entry_spread,
      exitSpread: exit_spread,
      cumulativeFundingRate: funding_pnl,
      spotFeePerLeg: spotFee,
      perpTakerFee: perpFeeSchedule.taker_fee,
    })

    const holdDuration = (logicalExitTime.getTime() - entryTime.getTime()) / 1000

    return {
      strategy_id: this.id,
      exchange: perpEvent.exchange,
      symbol: perpEvent.symbol,
      funding_time: perpEvent.funding_time,
      funding_rate: perpEvent.funding_rate,
      entry_price: perpEntryPrice,
      exit_price: perpExitPrice,
      pnl,
      exit_reason: exitReason,
      hold_duration: holdDuration,
      fill_count: 1,
      funding_received: funding_events_collected > 0,
      funding_events_collected,
      cumulative_funding_rate: funding_pnl,
      entry_spread,
      exit_spread,
    }
  }
}
