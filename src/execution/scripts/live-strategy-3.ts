/**
 * Live driver for strategy_3a / strategy_3b against exchange mainnet.
 * Runs the engine for one funding cycle on a manually-chosen symbol and prints a post-trade summary.
 *
 * Usage:
 *   tsx --env-file=.env src/execution/scripts/live-strategy-3.ts --config config/execution.live.yaml --symbol ETHUSDT
 *   tsx --env-file=.env src/execution/scripts/live-strategy-3.ts --config config/execution.dry-run.yaml --symbol ETHUSDT
 *   tsx --env-file=.env src/execution/scripts/live-strategy-3.ts --config config/execution.live.yaml --symbol ETHUSDT --timeout-minutes 90
 *   tsx --env-file=.env src/execution/scripts/live-strategy-3.ts --config config/execution.live.yaml --symbol ETHUSDT --funding-fee-grace-seconds 10
 *   tsx --env-file=.env src/execution/scripts/live-strategy-3.ts --config config/execution.live-gateio-test.yaml --exchange gateio --symbol BTCUSDT
 *   tsx --env-file=.env src/execution/scripts/live-strategy-3.ts --config config/execution.live-okx-test.yaml --exchange okx --symbol ETHUSDT --funding 17:30:00 --ack-live-funding-override
 *
 * Prerequisites: exchange API key and secret set in .env (e.g. BINANCE_API_KEY / GATEIO_API_KEY).
 * Config must have exactly one of strategy_3a or strategy_3b enabled (they are mutually exclusive).
 *
 * Strategy 3 goes short on high-negative-funding symbols — the position pays funding,
 * so fundingAmount in trade.summary will be negative. Net PnL is modelled as:
 *   priceDelta (short gains when price falls) + fundingAmount − fees
 */

import { parseArgs } from 'node:util'

import { startEngine } from '../index.js'
import type { Exchange } from '../types/exchange.js'
import type { FundingFeeEvent } from '../adapters/privatews/types.js'
import type { IntentState } from '../execution/types.js'
import { createIds } from '../core/ids.js'
import { gracefulShutdown } from './lib/graceful-shutdown.js'

const DEFAULT_TIMEOUT_MINUTES = 20
const DEFAULT_GRACE_SECONDS = 10

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      symbol: { type: 'string' },
      config: { type: 'string' },
      exchange: { type: 'string' },
      funding: { type: 'string' },
      'ack-live-funding-override': { type: 'boolean' },
      'metrics-port': { type: 'string' },
      'health-port': { type: 'string' },
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
    console.error('Example: tsx src/execution/scripts/live-strategy-3.ts --symbol ETHUSDT')
    process.exitCode = 1
    return
  }

  const configPath = values.config
  if (!configPath) {
    console.error('Error: --config <path> is required (e.g. --config config/execution.live.yaml)')
    process.exitCode = 1
    return
  }

  const exchange = (values.exchange ?? 'binance') as Exchange

  console.log(JSON.stringify({ event: 'driver.starting', symbol, configPath, exchange }))

  const handle = await startEngine({
    configPath,
    exchangeFilter: [exchange],
    symbolFilter: [symbol],
    ...(values.funding !== undefined ? { fundingTimeOverride: values.funding } : {}),
    ...(values['ack-live-funding-override'] ? { ackLiveFundingOverride: true } : {}),
    ...(values['metrics-port'] !== undefined ? { metricsPort: parseInt(values['metrics-port'], 10) } : {}),
    ...(values['health-port'] !== undefined ? { healthPort: parseInt(values['health-port'], 10) } : {}),
  })

  const { bus, manager } = handle
  const ids = createIds()
  if (!manager) {
    console.error('engine: manager not available')
    await handle.stop()
    process.exitCode = 1
    return
  }

  const fundingFees: FundingFeeEvent[] = []
  let entryPrice: number | undefined
  let exitPrice: number | undefined
  let exitReason: string | undefined

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

      const slClientId = ids.forExit(state.intent.id, 'sl')
      const tpClientId = ids.forExit(state.intent.id, 'tp')

      console.log(
        JSON.stringify({
          event: 'intent.state_changed',
          status: state.status,
          symbol: state.intent.symbol,
          strategy: state.intent.strategy,
          side: state.intent.side,
          filledQty: state.filledQty,
          avgEntryPrice: state.avgEntryPrice,
          avgExitPrice: state.avgExitPrice,
          exitReason: state.exitReason,
          slClientOrderId: slClientId,
          tpClientOrderId: tpClientId,
          at: new Date().toISOString(),
        })
      )

      if (state.avgEntryPrice !== undefined) entryPrice = state.avgEntryPrice
      if (state.avgExitPrice !== undefined) exitPrice = state.avgExitPrice
      if (state.exitReason !== undefined) exitReason = state.exitReason

      if (state.status === 'exited' || state.status === 'error') {
        clearTimeout(hardTimeout)
        process.exitCode = state.status === 'exited' ? 0 : 1
        void gracefulShutdown(handle, {
          drainSeconds: gracePeriod,
          onDrained: () => {
            for (const unsub of unsubs) unsub()
            if (entryPrice !== undefined && exitPrice !== undefined) {
              const totalFundingFee = fundingFees.reduce((sum, f) => sum + f.fundingAmount, 0)
              // For a short: profit from price movement is (entryPrice - exitPrice) / entryPrice
              const priceDeltaPct = (((entryPrice - exitPrice) / entryPrice) * 100).toFixed(4)
              const stratCfg = handle.config.strategies.find(s => s.id === 'strategy_3a' || s.id === 'strategy_3b')
              const amountUsd =
                stratCfg !== undefined && 'amountUsd' in stratCfg ? (stratCfg as { amountUsd: number }).amountUsd : 0

              // TP exits: taker+maker fees; SL/deadline exits: 2× taker fees
              const isTpExit = exitReason === 'tp'
              const makerFee = 0.0002
              const takerFee = 0.0004
              const feesUsd = isTpExit ? (takerFee + makerFee) * amountUsd : 2 * takerFee * amountUsd

              // fundingAmount is negative for shorts (position pays funding to longs)
              const modelPnl = (parseFloat(priceDeltaPct) / 100) * amountUsd + totalFundingFee - feesUsd

              console.log(
                JSON.stringify({
                  event: 'trade.summary',
                  symbol,
                  strategy: stratCfg?.id,
                  side: 'short',
                  exitReason,
                  entryPrice,
                  exitPrice,
                  priceDeltaPct,
                  fundingAmount: totalFundingFee,
                  estimatedFeesUsd: feesUsd.toFixed(4),
                  modelExpectedPnlUsd: modelPnl.toFixed(4),
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
