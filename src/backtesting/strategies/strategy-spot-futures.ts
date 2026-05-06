import type { FeeSchedule, SpotFuturesConfig } from '../config/schema.js'
import type { ExitReason } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { calculateSpotFuturesPnl } from '../pnl/calculator.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'

function parseTsToDate(ts: string): Date {
  return new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`)
}

/**
 * Strategy: Delta-Neutral Spot-Futures Funding Capture
 *
 * Simultaneously LONG spot + SHORT perp on the same symbol to harvest
 * positive funding paid by perp longs to perp shorts. The position is
 * carried across one or more funding events; exits trigger on funding
 * floor, spread stop-loss, spread take-profit, or safety deadline.
 *
 * Spot data is currently aliased to perp data (spread_pnl ≈ 0 everywhere).
 * When real spot ingestion exists, only fetchSpotOrderbookWindow changes.
 */
export class SpotFuturesStrategy implements BaseStrategy {
  readonly id = 'strategy_spot_futures'
  private config!: SpotFuturesConfig

  initialize(config: SpotFuturesConfig, _perpFeeSchedule: FeeSchedule, _slippage?: number): void {
    this.config = config
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate >= this.config.F_threshold
  }

  // Required by BaseStrategy but not used for this strategy — engine calls executeSpotFutures.
  execute(_event: FundingEvent, _data: OHLCWindow): TradeResult | null {
    return null
  }

  private carryAlias(
    perpEvent: FundingEvent,
    nextEvents: FundingEvent[],
    perpWindow: OHLCWindow,
    perpEntryPrice: number,
    spotEntryPrice: number
  ): {
    exitTs: string
    exitReason: ExitReason
    perpExitPrice: number
    spotExitPrice: number
    funding_pnl: number
    funding_events_collected: number
  } | null {
    const { config } = this
    let funding_pnl = perpEvent.funding_rate
    let funding_events_collected = 1
    let last_funding_rate = perpEvent.funding_rate
    let exitReason: ExitReason = 'DEADLINE'
    let exitFundingTime: Date | null = null

    for (const fEvent of nextEvents) {
      funding_pnl += fEvent.funding_rate
      funding_events_collected++
      last_funding_rate = fEvent.funding_rate

      if (last_funding_rate <= config.fundingConvergenceThreshold) {
        exitReason = 'FUNDING_FLOOR'
        exitFundingTime = fEvent.funding_time
        break
      }
      if (funding_events_collected >= config.max_carry_funding_events) {
        exitReason = 'DEADLINE'
        exitFundingTime = fEvent.funding_time
        break
      }
    }

    if (exitFundingTime === null) {
      const lastRow = perpWindow.getAll().at(-1)
      if (!lastRow) return null
      return {
        exitTs: lastRow.ts,
        exitReason: 'DEADLINE',
        perpExitPrice: lastRow.ask_open ?? perpEntryPrice,
        spotExitPrice: lastRow.bid_open ?? spotEntryPrice,
        funding_pnl,
        funding_events_collected,
      }
    }

    const exitFundingTs = toClickHouseDateTime(exitFundingTime)
    let exitCandle = perpWindow.getRowAt(exitFundingTs)
    exitCandle ??= perpWindow.getAll().find(r => r.ts >= exitFundingTs)
    if (!exitCandle) {
      const lastRow = perpWindow.getAll().at(-1)
      if (!lastRow) return null
      exitCandle = lastRow
    }

    return {
      exitTs: exitCandle.ts,
      exitReason,
      perpExitPrice: exitCandle.ask_open ?? perpEntryPrice,
      spotExitPrice: exitCandle.bid_open ?? spotEntryPrice,
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

    const entryTime = new Date(perpEvent.funding_time.getTime() - config.entry_offset_seconds * 1000)
    const entryTs = toClickHouseDateTime(entryTime)

    const perpEntryCandle = perpWindow.getRowAt(entryTs)
    const spotEntryCandle = spotWindow.getRowAt(entryTs)
    if (!perpEntryCandle || !spotEntryCandle) return null

    // LONG spot @ ask, SHORT perp @ bid
    const spotEntryFill = fillMarketOrder('buy', spotEntryCandle, 1, 'spot_entry')
    const perpEntryFill = fillMarketOrder('sell', perpEntryCandle, 1, 'perp_entry')
    if (!spotEntryFill || !perpEntryFill) return null

    const spotEntryPrice = spotEntryFill.price // ask_open
    const perpEntryPrice = perpEntryFill.price // bid_open
    const entry_spread = (perpEntryPrice - spotEntryPrice) / spotEntryPrice

    // Profit gate: reject if expected net < minTotalProfit
    const round_trip_fees = 2 * spotFee + 2 * perpFeeSchedule.taker_fee
    if (perpEvent.funding_rate + entry_spread - round_trip_fees < config.minTotalProfit) {
      return null
    }

    // Funding events at or after trigger, sorted ascending
    const sortedEvents = allFundingEvents
      .filter(e => e.funding_time >= perpEvent.funding_time)
      .sort((a, b) => a.funding_time.getTime() - b.funding_time.getTime())

    // Next funding event (after trigger) anchors the first exit window
    const nextEvents = sortedEvents.filter(e => e.funding_time > perpEvent.funding_time)
    const firstNextEvent = nextEvents[0]
    if (!firstNextEvent) return null

    const T_exit_first = new Date(firstNextEvent.funding_time.getTime() - config.exit_offset_seconds * 1000)

    const isAlias = config.spot_exchange === config.perp_exchange

    let funding_pnl = 0
    let funding_events_collected = 0
    let exitReason: ExitReason = 'DEADLINE'
    let exitTs = ''
    let perpExitPrice = perpEntryPrice
    let spotExitPrice = spotEntryPrice

    if (isAlias) {
      const aliasResult = this.carryAlias(perpEvent, nextEvents, perpWindow, perpEntryPrice, spotEntryPrice)
      if (!aliasResult) return null
      funding_pnl = aliasResult.funding_pnl
      funding_events_collected = aliasResult.funding_events_collected
      exitReason = aliasResult.exitReason
      exitTs = aliasResult.exitTs
      perpExitPrice = aliasResult.perpExitPrice
      spotExitPrice = aliasResult.spotExitPrice
    } else {
      let last_funding_rate = perpEvent.funding_rate
      const accrued = new Set<string>()

      for (const perpRow of perpWindow.getAll()) {
        const t = perpRow.ts
        if (t < entryTs) continue

        // Accrue each funding event as the cursor crosses its timestamp
        for (const fEvent of sortedEvents) {
          const fTs = toClickHouseDateTime(fEvent.funding_time)
          if (t >= fTs && !accrued.has(fTs)) {
            accrued.add(fTs)
            funding_pnl += fEvent.funding_rate
            funding_events_collected++
            last_funding_rate = fEvent.funding_rate
          }
        }

        // Gate: no exits before the first carry cycle completes
        if (parseTsToDate(t) < T_exit_first) continue

        const spotRow = spotWindow.getRowAt(t) ?? perpRow
        const { bid_open: perpBid, ask_open: perpAsk } = perpRow
        const { bid_open: spotBid, ask_open: spotAsk } = spotRow
        if (perpBid === null || perpAsk === null || spotBid === null || spotAsk === null) continue

        const perp_mid = (perpBid + perpAsk) / 2
        const spot_mid = (spotBid + spotAsk) / 2
        const current_spread = (perp_mid - spot_mid) / spotEntryPrice
        const spread_pnl_current = entry_spread - current_spread

        if (last_funding_rate <= config.fundingConvergenceThreshold) {
          exitReason = 'FUNDING_FLOOR'
          exitTs = t
          perpExitPrice = perpAsk
          spotExitPrice = spotBid
          break
        }

        if (spread_pnl_current >= config.spreadTakeProfit) {
          exitReason = 'SPREAD_TP'
          exitTs = t
          perpExitPrice = perpAsk
          spotExitPrice = spotBid
          break
        }

        if (current_spread - entry_spread >= config.spreadWideningThreshold) {
          exitReason = 'SPREAD_SL'
          exitTs = t
          perpExitPrice = perpAsk
          spotExitPrice = spotBid
          break
        }

        if (funding_events_collected >= config.max_carry_funding_events) {
          exitReason = 'DEADLINE'
          exitTs = t
          perpExitPrice = perpAsk
          spotExitPrice = spotBid
          break
        }
      }

      // DEADLINE: use last available candle if no explicit exit triggered
      if (!exitTs) {
        const allRows = perpWindow.getAll()
        const lastRow = allRows[allRows.length - 1]
        if (!lastRow) return null
        exitTs = lastRow.ts
        const spotLastRow = spotWindow.getRowAt(exitTs) ?? lastRow
        perpExitPrice = lastRow.ask_open ?? perpEntryPrice
        spotExitPrice = spotLastRow.bid_open ?? spotEntryPrice
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

    const exitTime = parseTsToDate(exitTs)
    const holdDuration = (exitTime.getTime() - entryTime.getTime()) / 1000

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
