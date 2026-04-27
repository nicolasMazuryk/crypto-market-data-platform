/**
 * Live driver for strategy_1 against Binance mainnet.
 * Runs the engine for one funding cycle on a manually-chosen symbol and prints a post-trade summary.
 *
 * Usage:
 *   tsx --env-file=.env src/execution/scripts/live-strategy-1.ts --config config/execution.live.yaml --symbol BTCUSDT
 *   tsx --env-file=.env src/execution/scripts/live-strategy-1.ts --config config/execution.dry-run.yaml --symbol BTCUSDT
 *   tsx --env-file=.env src/execution/scripts/live-strategy-1.ts --config config/execution.live.yaml --symbol BTCUSDT --timeout-minutes 90
 *   tsx --env-file=.env src/execution/scripts/live-strategy-1.ts --config config/execution.live.yaml --symbol BTCUSDT --funding-fee-grace-seconds 10
 *
 * Prerequisites: BINANCE_API_KEY and BINANCE_API_SECRET set in .env (for live config)
 *
 * The engine trades ALL symbols that qualify the strategy threshold. --symbol scopes the
 * monitoring output to one symbol; risk limits (maxConcurrentIntents, maxNotionalUsd) cap
 * total exposure.
 */

import { parseArgs } from 'node:util'

import { startEngine } from '../index.js'
import type { FundingFeeEvent } from '../adapters/privatews/types.js'
import type { IntentState } from '../execution/types.js'
import { gracefulShutdown } from './lib/graceful-shutdown.js'

const DEFAULT_TIMEOUT_MINUTES = 20
const DEFAULT_GRACE_SECONDS = 10

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      symbol: { type: 'string' },
      config: { type: 'string' },
      'timeout-minutes': { type: 'string' },
      'funding-fee-grace-seconds': { type: 'string' },
    },
    allowPositionals: false,
  })

  const timeoutMinutes =
    values['timeout-minutes'] !== undefined ? parseInt(values['timeout-minutes'], 10) : DEFAULT_TIMEOUT_MINUTES
  const TIMEOUT_MS = timeoutMinutes * 60 * 1000

  const gracePeriod =
    values['funding-fee-grace-seconds'] !== undefined
      ? parseInt(values['funding-fee-grace-seconds'], 10)
      : DEFAULT_GRACE_SECONDS

  const symbol = values.symbol
  if (!symbol) {
    console.error('Error: --symbol <SYMBOL> is required')
    console.error('Example: tsx src/execution/scripts/live-strategy-1.ts --symbol BTCUSDT')
    process.exitCode = 1
    return
  }

  const configPath = values.config
  if (!configPath) {
    console.error('Error: --config <path> is required (e.g. --config config/execution.live.yaml)')
    process.exitCode = 1
    return
  }

  console.log(JSON.stringify({ event: 'driver.starting', symbol, configPath }))

  const handle = await startEngine({
    configPath,
    exchangeFilter: ['binance'],
    symbolFilter: [symbol],
  })

  const { bus, manager } = handle
  if (!manager) {
    console.error('engine: manager not available')
    await handle.stop()
    process.exitCode = 1
    return
  }

  const fundingFees: FundingFeeEvent[] = []
  let entryPrice: number | undefined
  let exitPrice: number | undefined

  const unsubs: (() => void)[] = []

  unsubs.push(
    bus.on('ws.funding_fee', (event: FundingFeeEvent) => {
      if (event.symbol === symbol) {
        fundingFees.push(event)
        console.log(
          JSON.stringify({
            event: 'ws.funding_fee',
            symbol: event.symbol,
            fundingAmount: event.fundingAmount,
            fundingRate: event.fundingRate,
            at: new Date().toISOString(),
          })
        )
      }
    })
  )

  unsubs.push(
    bus.on('intent.state_changed', (state: IntentState) => {
      if (state.intent.symbol !== symbol) return
      console.log(
        JSON.stringify({
          event: 'intent.state_changed',
          status: state.status,
          symbol: state.intent.symbol,
          filledQty: state.filledQty,
          avgEntryPrice: state.avgEntryPrice,
          avgExitPrice: state.avgExitPrice,
          exitReason: state.exitReason,
          at: new Date().toISOString(),
        })
      )
      if (state.avgEntryPrice !== undefined) entryPrice = state.avgEntryPrice
      if (state.avgExitPrice !== undefined) exitPrice = state.avgExitPrice

      if (state.status === 'exited' || state.status === 'error') {
        clearTimeout(hardTimeout)
        process.exitCode = state.status === 'exited' ? 0 : 1
        void gracefulShutdown(handle, {
          drainSeconds: gracePeriod,
          onDrained: () => {
            for (const unsub of unsubs) unsub()
            if (entryPrice !== undefined && exitPrice !== undefined) {
              const totalFundingFee = fundingFees.reduce((sum, f) => sum + f.fundingAmount, 0)
              const priceDeltaPct = (((exitPrice - entryPrice) / entryPrice) * 100).toFixed(4)
              const stratCfg = handle.config.strategies.find(s => s.id === 'strategy_1')
              const amountUsd =
                stratCfg !== undefined && 'amountUsd' in stratCfg ? (stratCfg as { amountUsd: number }).amountUsd : 0
              const takerFeesUsd = 2 * 0.0004 * amountUsd

              console.log(
                JSON.stringify({
                  event: 'trade.summary',
                  symbol,
                  entryPrice,
                  exitPrice,
                  priceDeltaPct,
                  fundingFeeCollected: totalFundingFee,
                  estimatedTakerFeeUsd: takerFeesUsd,
                  modelExpectedPnlUsd: (totalFundingFee - takerFeesUsd).toFixed(4),
                })
              )
            }
          },
        })
      }
    })
  )

  const hardTimeout = setTimeout(() => {
    console.error(JSON.stringify({ event: 'driver.timeout', symbol, timeoutMs: TIMEOUT_MS }))
    process.exitCode = 1
    void manager.flattenAll().finally(() => {
      void gracefulShutdown(handle, { drainSeconds: 0 })
    })
  }, TIMEOUT_MS)

  process.on('SIGINT', () => {
    console.error(JSON.stringify({ event: 'driver.sigint' }))
    void manager.flattenAll().finally(() => {
      void gracefulShutdown(handle, { drainSeconds: 0 })
    })
  })

  process.on('SIGTERM', () => {
    console.error(JSON.stringify({ event: 'driver.sigterm' }))
    void manager.flattenAll().finally(() => {
      void gracefulShutdown(handle, { drainSeconds: 0 })
    })
  })

  console.log(JSON.stringify({ event: 'engine.started', symbol, mode: handle.config.mode }))
}

main().catch((err: unknown) => {
  console.error('fatal', err)
  process.exitCode = 1
})
