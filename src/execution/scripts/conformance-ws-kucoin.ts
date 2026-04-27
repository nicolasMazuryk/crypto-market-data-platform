/**
 * Live WS conformance test for KuCoin Futures private WebSocket adapter.
 *
 * Run with:
 *   tsx --env-file=.env src/execution/scripts/conformance-ws-kucoin.ts
 */

import { config as loadDotenv } from 'dotenv'
import { randomUUID } from 'node:crypto'

import { createClock } from '../core/clock.js'
import { createIds } from '../core/ids.js'
import { createEventBus } from '../core/bus.js'
import { createRateLimiter } from '../core/ratelimit/tokenBucket.js'
import {
  MetricsRegistry,
  registerRestMetrics,
  registerRateLimitMetrics,
  registerPrivateWsMetrics,
} from '../observability/metrics.js'
import { createKucoinRestAdapter } from '../adapters/rest/kucoin.js'
import { createKucoinPrivateWsAdapter } from '../adapters/privatews/kucoin.js'
import type { ExchangeConfig, ExchangeCredentials } from '../config/types.js'
import type { OrderEvent, BalanceEvent } from '../adapters/privatews/types.js'

loadDotenv()

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'

let passed = 0
let failed = 0

function pass(label: string, detail?: string): void {
  passed++
  console.log(`${GREEN}✓${RESET} ${label}${detail ? `  ${CYAN}(${detail})${RESET}` : ''}`)
}

function fail(label: string, err: unknown): void {
  failed++
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`${RED}✗${RESET} ${label}`)
  console.error(`  ${RED}${msg}${RESET}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}${CYAN}=== KuCoin Futures WS adapter — live mainnet test ===${RESET}\n`)

  const apiKey = process.env.KUCOIN_API_KEY
  const apiSecret = process.env.KUCOIN_API_SECRET
  const apiPassphrase = process.env.KUCOIN_API_PASSPHRASE

  if (!apiKey || !apiSecret || !apiPassphrase) {
    console.error(`${RED}Missing KUCOIN credentials in .env${RESET}`)
    process.exitCode = 1
    return
  }

  if (process.env.KUCOIN_TESTNET !== 'true') {
    console.warn(`${YELLOW}⚠  KUCOIN_TESTNET is not set to 'true' — using mainnet credentials${RESET}`)
  }

  const credentials: ExchangeCredentials = { apiKey, apiSecret, apiPassphrase }
  const cfg = {
    exchange: 'kucoin' as const,
    enabled: true,
    credentialsEnvPrefix: 'KUCOIN',
    marketRefreshMs: 60000,
    fundingPullMs: 15000,
    rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    credentials,
  } as unknown as ExchangeConfig

  const registry = new MetricsRegistry()
  const restMetrics = registerRestMetrics(registry)
  const rateLimitMetrics = registerRateLimitMetrics(registry)
  const wsMetrics = registerPrivateWsMetrics(registry)
  const clock = createClock()
  const ids = createIds()
  const bus = createEventBus()

  const limiter = createRateLimiter({
    profile: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    metrics: rateLimitMetrics,
    logger: console as never,
  })

  const restAdapter = createKucoinRestAdapter({ config: cfg, limiter, clock, ids, logger: console as never, metrics: restMetrics })
  const wsAdapter = createKucoinPrivateWsAdapter({ config: cfg, bus, clock, logger: console as never, metrics: wsMetrics })

  const orderEvents: OrderEvent[] = []
  const balanceEvents: BalanceEvent[] = []

  wsAdapter.events.on('order', e => {
    orderEvents.push(e)
    console.log(`  ${CYAN}[WS] order: ${e.order.status} id=${e.order.exchangeOrderId}${RESET}`)
  })
  wsAdapter.events.on('balance', e => {
    balanceEvents.push(e)
    console.log(`  ${CYAN}[WS] balance: ${e.balance.asset}=${String(e.balance.available)}${RESET}`)
  })
  wsAdapter.events.on('connectionState', e => {
    console.log(`  ${CYAN}[WS] state: ${e.state}${RESET}`)
  })

  try {
    await wsAdapter.connect()
    pass('WS connected')
  } catch (err) {
    fail('WS connect', err)
    process.exitCode = 1
    return
  }

  await sleep(3000)

  const intentId = randomUUID()
  const clientOrderId = `livetest-${intentId.slice(0, 16)}`
  let exchangeOrderId = ''

  try {
    const ack = await restAdapter.createOrder({
      intentId,
      clientOrderId,
      exchange: 'kucoin',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      qty: 1, // 1 contract = 0.001 BTC
      price: 1000,
      timeInForce: 'GTC',
      leverage: 1,
    })
    if (ack.status !== 'accepted') throw new Error(`createOrder rejected: ${ack.rejectReason ?? ''}`)
    exchangeOrderId = ack.exchangeOrderId
    pass('createOrder via REST', `id=${exchangeOrderId}`)
  } catch (err) {
    fail('createOrder via REST', err)
    await wsAdapter.disconnect()
    await restAdapter.dispose()
    process.exitCode = 1
    return
  }

  console.log(`\n  Waiting 5s for WS events...`)
  await sleep(5000)

  try {
    await restAdapter.cancelOrder({ symbol: 'BTCUSDT', exchangeOrderId, clientOrderId })
    pass('cancelOrder via REST')
  } catch (err) {
    fail('cancelOrder via REST', err)
  }

  await sleep(3000)

  if (orderEvents.length > 0) {
    pass('order events received', `count=${String(orderEvents.length)}`)
  } else {
    fail('order events received', new Error('no order events within timeout'))
  }

  if (balanceEvents.length > 0) {
    pass('balance events received', `count=${String(balanceEvents.length)}`)
  } else {
    console.warn(`${YELLOW}⚠  No balance events${RESET}`)
  }

  try {
    await wsAdapter.disconnect()
    pass('WS disconnected cleanly')
  } catch (err) {
    fail('WS disconnect', err)
  }

  await restAdapter.dispose()

  const total = passed + failed
  console.log(
    `\n${BOLD}Results: ${GREEN}${String(passed)}/${String(total)} passed${failed > 0 ? `  ${RED}${String(failed)} failed` : ''}${RESET}\n`
  )

  if (failed > 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(`${RED}Fatal error:${RESET}`, err)
  process.exitCode = 1
})
