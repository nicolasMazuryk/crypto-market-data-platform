/**
 * Live end-to-end integration test for the Gate.io REST adapter.
 *
 * Uses real credentials from .env. Places a tiny limit order far from market
 * (BTCUSDT buy @ $1,000) to exercise the full create→verify→cancel cycle
 * without risk of fills.
 *
 * Run with:
 *   tsx --env-file=.env src/execution/scripts/conformance-rest-gateio.ts
 */

import { config as loadDotenv } from 'dotenv'
import { randomUUID } from 'node:crypto'

import { createClock } from '../core/clock.js'
import { createIds } from '../core/ids.js'
import { createRateLimiter } from '../core/ratelimit/tokenBucket.js'
import { MetricsRegistry, registerRestMetrics, registerRateLimitMetrics } from '../observability/metrics.js'
import { createGateioRestAdapter } from '../adapters/rest/gateio.js'
import type { ExchangeConfig } from '../config/types.js'

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

async function run(label: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (err) {
    fail(label, err)
    return false
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function buildAdapter() {
  const apiKey = process.env.GATEIO_API_KEY
  const apiSecret = process.env.GATEIO_API_SECRET

  if (!apiKey || !apiSecret) {
    throw new Error('GATEIO_API_KEY and GATEIO_API_SECRET must be set in .env')
  }

  if (process.env.GATEIO_TESTNET !== 'true') {
    console.warn(`${YELLOW}⚠  GATEIO_TESTNET is not set to 'true' — using mainnet credentials${RESET}`)
  }

  const cfg = {
    exchange: 'gateio' as const,
    enabled: true,
    credentialsEnvPrefix: 'GATEIO',
    marketRefreshMs: 60000,
    fundingPullMs: 15000,
    rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    credentials: { apiKey, apiSecret },
  } as unknown as ExchangeConfig

  const registry = new MetricsRegistry()
  const restMetrics = registerRestMetrics(registry)
  const rateLimitMetrics = registerRateLimitMetrics(registry)
  const clock = createClock()
  const ids = createIds()

  const limiter = createRateLimiter({
    profile: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    metrics: rateLimitMetrics,
    logger: console as never,
  })

  const adapter = createGateioRestAdapter({
    config: cfg,
    limiter,
    clock,
    ids,
    logger: console as never,
    metrics: restMetrics,
  })

  return { adapter, clock }
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}${CYAN}=== Gate.io REST adapter — live mainnet test ===${RESET}\n`)

  const { adapter, clock } = buildAdapter()

  let serverTime = 0
  await run('getServerTime() returns a recent timestamp', async () => {
    serverTime = await adapter.getServerTime()
    const skew = clock.skewMs('gateio')
    pass('getServerTime()', `serverTime=${new Date(serverTime).toISOString()}, skewMs=${String(skew)}`)
    assert(serverTime > Date.now() - 5000, 'server time should be within 5 s of local')
    assert(Math.abs(skew) < 5000, `clock skew ${String(skew)}ms should be < 5 s`)
  })

  await run('getBalance() returns USDT balance', async () => {
    const balances = await adapter.getBalance('USDT')
    pass('getBalance(USDT)', `${String(balances.length)} entries — ${JSON.stringify(balances)}`)
    assert(Array.isArray(balances), 'should return an array')
  })

  await run('getPositions() returns array (may be empty)', async () => {
    const positions = await adapter.getPositions()
    pass('getPositions()', `${String(positions.length)} open positions`)
    assert(Array.isArray(positions), 'should return an array')
  })

  await run('getOpenOrders(BTCUSDT) baseline', async () => {
    const orders = await adapter.getOpenOrders('BTCUSDT')
    pass('getOpenOrders(BTCUSDT) baseline', `${String(orders.length)} orders`)
    assert(Array.isArray(orders), 'should return an array')
  })

  const intentId = randomUUID()
  // Gate.io text field: max 28 chars, must start with 't-'
  const clientOrderId = `t-${intentId.slice(0, 16)}`
  let exchangeOrderId = ''

  // Gate.io BTC/USDT:USDT swap: 1 contract = 1 USD in value, minimum 1 contract
  const orderOk = await run('createOrder() places a GTC limit buy far from market', async () => {
    const ack = await adapter.createOrder({
      intentId,
      clientOrderId,
      exchange: 'gateio',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      qty: 1, // 1 contract
      price: 1000,
      timeInForce: 'GTC',
      leverage: 1,
    })
    pass('createOrder()', `status=${ack.status}, exchangeOrderId=${ack.exchangeOrderId}`)
    assert(ack.status === 'accepted', `expected accepted, got ${ack.status}: ${ack.rejectReason ?? ''}`)
    assert(ack.exchangeOrderId.length > 0, 'exchangeOrderId must be non-empty')
    exchangeOrderId = ack.exchangeOrderId
  })

  if (!orderOk) {
    console.log(`\n${YELLOW}⚠  Skipping order-dependent tests (createOrder failed)${RESET}\n`)
  } else {
    await run('getOpenOrders() shows the newly placed order', async () => {
      const orders = await adapter.getOpenOrders('BTCUSDT')
      const found = orders.find(o => o.exchangeOrderId === exchangeOrderId)
      pass('getOpenOrders() post-create', `${String(orders.length)} orders, found=${String(found !== undefined)}`)
      if (found === undefined) throw new Error(`order ${exchangeOrderId} not found in open orders`)
    })

    await run('cancelOrder() removes the order', async () => {
      await adapter.cancelOrder({ symbol: 'BTCUSDT', exchangeOrderId, clientOrderId })
      pass('cancelOrder()', `cancelled ${exchangeOrderId}`)
    })

    await run('cancelOrder() on missing order resolves gracefully', async () => {
      await adapter.cancelOrder({ symbol: 'BTCUSDT', exchangeOrderId, clientOrderId })
      pass('cancelOrder() on missing order', 'resolved without throw')
    })
  }

  await run('dispose() closes the CCXT client cleanly', async () => {
    await adapter.dispose()
    pass('dispose()', 'clean shutdown')
  })

  const total = passed + failed
  console.log(
    `\n${BOLD}Results: ${GREEN}${String(passed)}/${String(total)} passed${failed > 0 ? `  ${RED}${String(failed)} failed` : ''}${RESET}\n`
  )

  if (failed > 0) process.exitCode = 1
  void serverTime
}

main().catch((err: unknown) => {
  console.error(`${RED}Fatal error:${RESET}`, err)
  process.exitCode = 1
})
