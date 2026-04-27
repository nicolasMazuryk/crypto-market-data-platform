import type { Logger } from 'pino'

import type { Clock } from '../core/types.js'
import type { FundingRateSource } from '../funding/types.js'
import type { SchedulerConfig } from '../config/types.js'
import type { StrategyConfig, StrategyEvaluator, StrategyId } from '../strategies/types.js'
import type { Exchange } from '../types/exchange.js'

const DEFAULT_EVALUATE_LEAD_MS = 1500
const HOUR_MS = 3_600_000

export interface FundingEventSchedulerOptions {
  clock: Clock
  evaluator: StrategyEvaluator
  funding: FundingRateSource
  exchanges?: Exchange[]
  configsByStrategy: Map<StrategyId, StrategyConfig>
  config: SchedulerConfig
  symbolFilter?: Set<string>
  evaluateLeadMs?: number
  fundingTimeOverrideMs?: number
  staleSnapshotMaxAgeMs?: number
  leveragePrewarmer?: (exchange: Exchange, symbol: string, leverage: number) => void
  logger: Logger
}

export interface FundingEventSchedulerHandle {
  stop(): void
}

function minEntryOffsetMs(configsByStrategy: Map<StrategyId, StrategyConfig>): number {
  let min = Infinity
  for (const cfg of configsByStrategy.values()) {
    if (cfg.enabled) min = Math.min(min, cfg.entryOffsetSeconds * 1000)
  }
  return min === Infinity ? 5000 : min
}

function nextWakeTime(now: number, wakeBeforeHourEndMs: number): number {
  let nextHour = Math.ceil((now + 1) / HOUR_MS) * HOUR_MS
  let wake = nextHour - wakeBeforeHourEndMs
  if (wake <= now) {
    nextHour += HOUR_MS
    wake = nextHour - wakeBeforeHourEndMs
  }
  return wake
}

export function createFundingEventScheduler(opts: FundingEventSchedulerOptions): FundingEventSchedulerHandle {
  const { clock, evaluator, funding, configsByStrategy, config, logger, symbolFilter } = opts
  const leadMs = opts.evaluateLeadMs ?? DEFAULT_EVALUATE_LEAD_MS
  const exchanges = opts.exchanges ?? []
  const isOverrideMode = opts.fundingTimeOverrideMs !== undefined

  const evalTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function handleWake(): void {
    if (stopped) return
    const now = clock.now()
    const windowEnd = now + config.fundingWindowMs
    const entryOffsetMs = minEntryOffsetMs(configsByStrategy)

    const enabledLeverages = new Set<number>()
    for (const cfg of configsByStrategy.values()) {
      if (cfg.enabled) enabledLeverages.add(cfg.leverage)
    }

    let scheduledCount = 0
    const staleMaxAgeMs = opts.staleSnapshotMaxAgeMs ?? 30_000

    for (const exchange of exchanges) {
      // Collect and sort by fundingRate (most negative first) so the best opportunities
      // are evaluated — and therefore submitted — before the per-strategy cap is reached.
      const snaps = Array.from(funding.latest(exchange).values())
        .filter(snap => {
          if (symbolFilter && !symbolFilter.has(snap.symbol)) return false
          if (snap.timestamp < now - staleMaxAgeMs) {
            logger.warn(
              { exchange, symbol: snap.symbol, ageMs: now - snap.timestamp },
              'scheduler: stale snapshot, skipping'
            )
            return false
          }
          return snap.nextFundingTimestamp >= now && snap.nextFundingTimestamp <= windowEnd
        })
        .sort((a, b) => a.fundingRate - b.fundingRate) // most negative first

      for (const snap of snaps) {
        const { symbol, nextFundingTimestamp } = snap
        const key = `${exchange}|${symbol}`
        const evaluateAt = nextFundingTimestamp - entryOffsetMs - leadMs
        const skewMs = clock.skewMs(exchange)
        const delay = Math.max(0, evaluateAt - now - skewMs)

        const capturedTs = nextFundingTimestamp
        const timer = setTimeout(() => {
          evalTimers.delete(key)
          const latest = funding.latest(exchange).get(symbol)
          if (latest?.nextFundingTimestamp !== capturedTs) {
            logger.debug({ exchange, symbol }, 'scheduler: funding advanced, skipping evaluation')
            return
          }
          logger.debug(
            { event: 'scheduler.firing', exchange, symbol, nextFundingTimestamp: capturedTs },
            'scheduler.firing'
          )
          evaluator.evaluate(exchange, symbol)
        }, delay)

        evalTimers.set(key, timer)
        logger.debug(
          { event: 'scheduler.scheduled', exchange, symbol, nextFundingTimestamp: capturedTs, evaluateAt, delay },
          'scheduler.scheduled'
        )
        scheduledCount++

        for (const leverage of enabledLeverages) {
          opts.leveragePrewarmer?.(exchange, symbol, leverage)
        }
      }
    }

    const nextWake = nextWakeTime(now, config.wakeBeforeHourEndMs)
    const wakeDelay = nextWake - now
    logger.info({ event: 'scheduler.wake', nextWake, wakeDelay, scheduledCount }, 'scheduler.wake')

    if (scheduledCount === 0) {
      logger.warn(
        { event: 'scheduler.no_candidates', exchanges: exchanges.length, fundingWindowMs: config.fundingWindowMs },
        'scheduler.no_candidates'
      )
    }

    if (!isOverrideMode) {
      wakeTimer = setTimeout(handleWake, wakeDelay)
    }
  }

  const now = clock.now()

  if (opts.fundingTimeOverrideMs !== undefined) {
    const overrideMs = opts.fundingTimeOverrideMs
    const delta = overrideMs - now
    if (delta <= 0) {
      throw new Error(
        `funding time override is in the past (${String(-delta)}ms ago) — use a future time`
      )
    }
    if (delta > config.fundingWindowMs) {
      throw new Error(
        `funding time override is ${String(delta)}ms away but fundingWindowMs is ${String(config.fundingWindowMs)}ms — ` +
          `set the override within ${String(Math.round(config.fundingWindowMs / 60_000))} min of now ` +
          `or increase scheduler.fundingWindowMs in your config`
      )
    }
    logger.info({ event: 'scheduler.armed', override: true, overrideMs, delta }, 'scheduler.armed')
    handleWake()
  } else {
    const currentNextHour = Math.ceil((now + 1) / HOUR_MS) * HOUR_MS
    const currentHourWakeTime = currentNextHour - config.wakeBeforeHourEndMs

    if (now >= currentHourWakeTime) {
      // Engine started inside the pre-funding window — scan immediately to catch this
      // funding cycle. handleWake() will arm the timer for the next hour internally.
      logger.info({ event: 'scheduler.armed', catchUp: true, currentHourWakeTime, currentNextHour }, 'scheduler.armed')
      handleWake()
    } else {
      const initialWake = nextWakeTime(now, config.wakeBeforeHourEndMs)
      const initialDelay = initialWake - now
      logger.info({ event: 'scheduler.armed', nextWake: initialWake, initialDelay }, 'scheduler.armed')
      wakeTimer = setTimeout(handleWake, initialDelay)
    }
  }

  return {
    stop() {
      stopped = true
      if (wakeTimer !== null) {
        clearTimeout(wakeTimer)
        wakeTimer = null
      }
      for (const timer of evalTimers.values()) clearTimeout(timer)
      evalTimers.clear()
    },
  }
}
