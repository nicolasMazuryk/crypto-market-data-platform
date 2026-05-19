import type { Logger } from 'pino'

import type { EventBus } from '../core/types.js'
import type { ExecutionManager } from '../execution/types.js'
import type { ExchangeRestAdapter } from '../adapters/rest/types.js'

const FUNDING_INTERVAL_MS = 1 * 60 * 60 * 1000
const POLL_DELAY_MS = 3_000
const RETRY_INTERVAL_MS = 3_000
// Retry window after funding_ts: OKX REST can take up to 60s to publish funding history.
const RETRY_WINDOW_MS = 60_000

export interface FundingIncomePollerOpts {
  restAdapters: Map<ExchangeRestAdapter['exchange'], ExchangeRestAdapter>
  execManager: ExecutionManager
  bus: EventBus
  logger: Logger
  now?: () => number
}

export interface FundingIncomePoller {
  start(): void
  stop(): void
  tick(): Promise<void>
}

export function createFundingIncomePoller(opts: FundingIncomePollerOpts): FundingIncomePoller {
  const { restAdapters, execManager, bus, logger } = opts
  const nowFn = opts.now ?? (() => Date.now())
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function delayToNextTickMs(): number {
    const now = nowFn()
    const boundary = Math.ceil(now / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS
    return Math.max(0, boundary + POLL_DELAY_MS - now)
  }

  async function tick(): Promise<void> {
    const now = nowFn()
    const fundingTs = Math.floor(now / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS
    const openIntents = execManager
      .listRecentIntentsForAttribution(90_000)
      .filter(intent => restAdapters.get(intent.exchange)?.fetchFundingFeeIncome !== undefined)

    if (openIntents.length === 0) return

    logger.info(
      { event: 'funding_income_poller.tick', fundingTs, intentCount: openIntents.length },
      'funding_income_poller.tick'
    )

    await Promise.allSettled(
      openIntents.map(async ({ intentId, exchange, symbol }) => {
        try {
          const adapter = restAdapters.get(exchange)
          if (!adapter?.fetchFundingFeeIncome) return
          const record = await adapter.fetchFundingFeeIncome(symbol, fundingTs)
          if (!record) {
            logger.debug(
              { event: 'funding_income_poller.not_found', intentId, exchange, symbol, fundingTs },
              'funding_income_poller.not_found'
            )
            return
          }
          logger.info(
            {
              event: 'funding_income_poller.found',
              intentId,
              exchange,
              symbol,
              fundingTs,
              fundingAmount: record.fundingAmount,
            },
            'funding_income_poller.found'
          )
          bus.emit('ws.funding_fee', {
            exchange,
            symbol: record.symbol,
            fundingTime: record.fundingTime,
            fundingRate: 0,
            fundingAmount: record.fundingAmount,
            asset: record.asset,
            positionQty: 0,
            receivedAt: nowFn(),
          })
        } catch (err) {
          logger.warn(
            { event: 'funding_income_poller.error', intentId, exchange, symbol, fundingTs, err },
            'funding_income_poller.error'
          )
        }
      })
    )
  }

  function schedule(retryWindowEnd?: number): void {
    if (stopped) return
    const now = nowFn()
    const withinRetryWindow = retryWindowEnd !== undefined && now < retryWindowEnd
    const delay = withinRetryWindow ? RETRY_INTERVAL_MS : delayToNextTickMs()
    timer = setTimeout(() => {
      void tick().finally(() => {
        if (!stopped) {
          const afterTick = nowFn()
          const fundingTs = Math.floor(afterTick / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS
          const windowEnd = retryWindowEnd ?? fundingTs + RETRY_WINDOW_MS
          if (afterTick < windowEnd) {
            schedule(windowEnd)
          } else {
            schedule()
          }
        }
      })
    }, delay)
  }

  return {
    start(): void {
      stopped = false
      schedule()
    },
    stop(): void {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
    tick,
  }
}
