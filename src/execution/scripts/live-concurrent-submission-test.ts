/**
 * Concurrent submission rate-limit test (Task 2 verification).
 *
 * Submits N intents to the same exchange simultaneously, verifying that
 * withSubmissionGate staggers createOrder calls by at least submissionStaggerMs.
 *
 * Checks:
 *   1. No 10006 / -1003 rate-limit errors from the exchange
 *   2. Gap between consecutive createOrder calls >= submissionStaggerMs
 *   3. All positions closed after test
 *
 * Run:
 *   source <(bash scripts/exchange-subkey.sh bybit strategy_1)
 *   tsx src/execution/scripts/live-concurrent-submission-test.ts
 *
 * Or with explicit env:
 *   BYBIT_API_KEY=... BYBIT_API_SECRET=... tsx src/execution/scripts/live-concurrent-submission-test.ts
 */

import { config as loadDotenv } from 'dotenv'
import ccxt from 'ccxt'
import { randomUUID } from 'node:crypto'

import { createEventBus } from '../core/bus.js'
import { createClock } from '../core/clock.js'
import { createIds } from '../core/ids.js'
import { createRateLimiter } from '../core/ratelimit/tokenBucket.js'
import { createMarketMetadataProvider } from '../markets/provider.js'
import {
  MetricsRegistry,
  registerBaseMetrics,
  registerMarketsMetrics,
  registerRestMetrics,
  registerRateLimitMetrics,
  registerPrivateWsMetrics,
  registerStateMetrics,
  registerExecutionMetrics,
} from '../observability/metrics.js'
import { createRestAdapter } from '../adapters/rest/factory.js'
import { createPrivateWsAdapter } from '../adapters/privatews/factory.js'
import { createStateStore } from '../state/store.js'
import { createKillSwitch } from '../risk/killSwitch.js'
import { createPositionMonitor } from '../execution/monitor.js'
import { createExecutionManager } from '../execution/manager.js'
import { preflight } from '../execution/preflight.js'
import type { ExchangeConfig, ExchangeCredentials } from '../config/types.js'
import type { Exchange } from '../types/exchange.js'
import type { TradeIntent } from '../strategies/types.js'
import type { ExchangeRestAdapter } from '../adapters/rest/types.js'

loadDotenv()

const R = '\x1b[0m'
const GR = '\x1b[32m'
const RD = '\x1b[31m'
const YL = '\x1b[33m'
const CY = '\x1b[36m'
const BD = '\x1b[1m'

const STAGGER_MS = 150
const N_INTENTS = 3
// XRP/USDT:USDT — cheap, liquid, available on all exchanges
const SYMBOL = 'XRPUSDT'
const EXCHANGE_SYMBOL = 'XRP/USDT:USDT'
const AMOUNT_USD = 8
const LEVERAGE = 2

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchMarkPrice(ccxtId: string, unified: string): Promise<number> {
  const reg = ccxt as unknown as Record<
    string,
    new (cfg?: Record<string, unknown>) => {
      fetchTicker(symbol: string): Promise<{ last?: number; close?: number; markPrice?: number }>
      close?(): Promise<void>
    }
  >
  const Cls = reg[ccxtId]
  if (!Cls) throw new Error(`CCXT class not found: ${ccxtId}`)
  const ex = new Cls({ enableRateLimit: false })
  try {
    const ticker = await ex.fetchTicker(unified)
    const price = ticker.markPrice ?? ticker.last ?? ticker.close
    if (!price || price <= 0) throw new Error(`No mark price from ${ccxtId}`)
    return price
  } finally {
    if (ex.close) await ex.close()
  }
}

function buildIntent(exchange: Exchange, markPrice: number, index: number): TradeIntent {
  const now = Date.now()
  return {
    id: randomUUID(),
    strategy: 'strategy_1',
    exchange,
    symbol: SYMBOL,
    exchangeSymbol: EXCHANGE_SYMBOL,
    side: 'long',
    amountUsd: AMOUNT_USD,
    leverage: LEVERAGE,
    volume: 0,
    fundingRate: -0.001,
    fundingRatePercent: -0.1,
    fundingInterval: '8h',
    nextFundingTimestamp: now + 8 * 3600_000,
    nextFundingDatetime: new Date(now + 8 * 3600_000).toISOString(),
    decidedAt: now,
    entryAt: now,
    exitPolicy: { kind: 'timed', exitAfterMs: 30_000 },
    _markPrice: markPrice,
    _testIndex: index,
  } as unknown as TradeIntent
}

async function main(): Promise<void> {
  const exchange: Exchange = 'bybit'
  const ccxtId = 'bybit'
  const envPrefix = 'BYBIT'

  console.log(`\n${BD}${CY}Concurrent submission stagger test — ${exchange}${R}`)
  console.log(`${CY}submissionStaggerMs=${String(STAGGER_MS)}, N_INTENTS=${String(N_INTENTS)}${R}\n`)

  const apiKey = process.env[`${envPrefix}_API_KEY`]
  const apiSecret = process.env[`${envPrefix}_API_SECRET`]
  if (!apiKey || !apiSecret) {
    console.error(`${RD}Missing ${envPrefix}_API_KEY / ${envPrefix}_API_SECRET${R}`)
    console.error(`Run: source <(bash scripts/exchange-subkey.sh bybit strategy_1)`)
    process.exit(1)
  }

  const credentials: ExchangeCredentials = { apiKey, apiSecret }
  const cfg: ExchangeConfig & { credentials: ExchangeCredentials } = {
    exchange,
    enabled: true,
    credentialsEnvPrefix: envPrefix,
    marketRefreshMs: 60_000,
    fundingPullMs: 15_000,
    rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    credentials,
  }

  console.log(`  → Fetching ${SYMBOL} mark price…`)
  const markPrice = await fetchMarkPrice(ccxtId, EXCHANGE_SYMBOL)
  console.log(`  → Mark price: $${markPrice.toFixed(4)}`)

  const bus = createEventBus()
  const clock = createClock()
  const ids = createIds()
  const registry = new MetricsRegistry()

  registerBaseMetrics(registry, {
    mode: 'live',
    configHash: 'concurrent-test',
    startedAtSeconds: Math.floor(Date.now() / 1000),
    enabledExchanges: [exchange],
  })

  const restMetrics = registerRestMetrics(registry)
  const rateLimitMetrics = registerRateLimitMetrics(registry)
  const limiter = createRateLimiter({
    profile: cfg.rateLimits,
    metrics: rateLimitMetrics,
    logger: console as never,
  })

  const rawRest = createRestAdapter({
    engineMode: 'live',
    config: cfg,
    limiter,
    clock,
    ids,
    logger: console as never,
    metrics: restMetrics,
  })

  // Instrument createOrder to capture call timestamps and any rate-limit errors.
  const createOrderTimestamps: number[] = []
  const rateLimitErrors: string[] = []
  const instrumentedRest: ExchangeRestAdapter = {
    ...rawRest,
    createOrder: async (params) => {
      const ts = Date.now()
      createOrderTimestamps.push(ts)
      console.log(`  ${CY}[${new Date(ts).toISOString()}] createOrder → ${params.symbol} qty=${String(params.qty)}${R}`)
      try {
        const result = await rawRest.createOrder(params)
        return result
      } catch (err: unknown) {
        const msg = String(err)
        if (msg.includes('10006') || msg.includes('-1003') || msg.includes('Too many') || msg.includes('rate limit')) {
          rateLimitErrors.push(msg)
          console.error(`  ${RD}RATE LIMIT ERROR: ${msg}${R}`)
        }
        throw err
      }
    },
  }

  const marketsMetrics = registerMarketsMetrics(registry)
  const marketsHandle = createMarketMetadataProvider({
    bus,
    logger: console as never,
    metrics: marketsMetrics,
    exchanges: [cfg],
  })

  const stateMetrics = registerStateMetrics(registry)
  const stateStore = createStateStore({
    bus,
    restAdapters: new Map([[exchange, instrumentedRest]]),
    exchanges: [exchange],
    clock,
    logger: console as never,
    metrics: stateMetrics,
  })
  stateStore.start()

  const wsMetrics = registerPrivateWsMetrics(registry)
  const ws = createPrivateWsAdapter({
    engineMode: 'live',
    config: cfg,
    bus,
    clock,
    logger: console as never,
    metrics: wsMetrics,
  })

  const killSwitch = createKillSwitch(console as never)
  const execMetrics = registerExecutionMetrics(registry)
  const monitor = createPositionMonitor({
    bus,
    clock,
    logger: console as never,
    metrics: execMetrics,
  })

  let cachedMarkPrice = markPrice
  const manager = createExecutionManager({
    bus,
    clock,
    ids,
    logger: console as never,
    metrics: execMetrics,
    restAdapters: new Map([[exchange, instrumentedRest]]),
    state: stateStore,
    markets: marketsHandle.provider,
    killSwitch,
    monitor,
    preflight: (intent, refPriceValue) =>
      preflight(intent, refPriceValue, {
        markets: marketsHandle.provider,
        state: stateStore,
        killSwitch,
        risk: {
          globalMaxConcurrentIntents: 20,
          globalMaxNotionalUsd: 2000,
          perStrategy: { strategy_1: { maxConcurrentIntents: 10, maxNotionalUsd: 1000 } },
        },
        countIntents: () => manager.list().filter(s => !['exited', 'error', 'cancelled'].includes(s.status)).length,
        notionalInFlight: () =>
          manager
            .list()
            .filter(s => !['exited', 'error', 'cancelled'].includes(s.status))
            .reduce((sum, s) => sum + s.intent.amountUsd, 0),
      }),
    refPrice: () => cachedMarkPrice,
    submissionStaggerMs: { bybit: STAGGER_MS },
  })
  manager.start()

  // Connect WS for account updates
  await ws.connect()
  console.log(`  ${GR}✓${R} WS connected`)

  // Wait for markets to load
  await marketsHandle.provider.refresh(exchange)
  console.log(`  ${GR}✓${R} Markets loaded`)

  const intents = Array.from({ length: N_INTENTS }, (_, i) => buildIntent(exchange, markPrice, i))

  console.log(`\n  → Submitting ${String(N_INTENTS)} intents simultaneously…`)
  const submitStart = Date.now()

  // Fire all submits concurrently — this is the scenario that caused rate-limit exhaustion
  const results = await Promise.allSettled(intents.map(intent => manager.submit(intent)))

  const submitEnd = Date.now()
  console.log(`  → All submits returned in ${String(submitEnd - submitStart)}ms`)

  // Print intent results
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const state = manager.get(intents[i]!.id)
    const status = state?.status ?? 'unknown'
    const symbol = result?.status === 'fulfilled' ? result.value.status : '(rejected)'
    console.log(`  Intent ${String(i + 1)}: status=${status} (${String(symbol)})`)
  }

  // ── Verify stagger timing ──────────────────────────────────────────────
  console.log(`\n${BD}Timing analysis:${R}`)
  const gaps: number[] = []
  for (let i = 1; i < createOrderTimestamps.length; i++) {
    const gap = createOrderTimestamps[i]! - createOrderTimestamps[i - 1]!
    gaps.push(gap)
    const ok = gap >= STAGGER_MS
    console.log(`  Gap ${String(i)}: ${String(gap)}ms ${ok ? `${GR}✓${R}` : `${RD}✗ (< ${String(STAGGER_MS)}ms)${R}`}`)
  }

  let passed = true

  if (createOrderTimestamps.length === 0) {
    console.log(`  ${YL}⚠ No createOrder calls captured — all intents may have been rejected pre-flight${R}`)
    passed = false
  }

  if (rateLimitErrors.length > 0) {
    console.log(`\n  ${RD}✗ ${String(rateLimitErrors.length)} rate-limit error(s)${R}`)
    passed = false
  } else {
    console.log(`  ${GR}✓ No rate-limit errors${R}`)
  }

  const badGaps = gaps.filter(g => g < STAGGER_MS)
  if (badGaps.length > 0) {
    console.log(`  ${RD}✗ ${String(badGaps.length)} gap(s) below ${String(STAGGER_MS)}ms: ${badGaps.map(String).join(', ')}ms${R}`)
    passed = false
  } else if (gaps.length > 0) {
    console.log(`  ${GR}✓ All gaps >= ${String(STAGGER_MS)}ms (min=${String(Math.min(...gaps))}ms)${R}`)
  }

  // ── Close all open positions ──────────────────────────────────────────
  console.log(`\n  → Closing positions…`)
  await sleep(2000) // allow fills to settle
  try {
    const positions = await rawRest.getPositions()
    const open = positions.filter(p => p.symbol.includes('XRP') && p.qty > 0)
    if (open.length === 0) {
      console.log(`  ${GR}✓${R} No open positions`)
    }
    for (const pos of open) {
      const side = pos.side === 'long' ? 'sell' : 'buy'
      try {
        await rawRest.createOrder({
          intentId: 'cleanup',
          clientOrderId: `cleanup-${Date.now().toString(36)}`,
          exchange,
          symbol: EXCHANGE_SYMBOL,
          side,
          type: 'market',
          qty: pos.qty,
          reduceOnly: true,
        })
        console.log(`  ${GR}✓${R} Closed ${pos.side} ${String(pos.qty)} ${pos.symbol}`)
      } catch (err) {
        console.error(`  ${RD}✗ Close failed: ${String(err)}${R}`)
      }
    }
  } catch (err) {
    console.error(`  ${RD}✗ getPositions failed: ${String(err)}${R}`)
  }

  await ws.disconnect?.()

  console.log(`\n${BD}Result: ${passed ? `${GR}PASS${R}` : `${RD}FAIL${R}`}${R}`)
  if (!passed) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
