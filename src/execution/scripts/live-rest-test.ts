/**
 * Live end-to-end integration test for the Binance REST adapter on mainnet.
 *
 * Uses real credentials from .env. Places a tiny limit order far from market
 * (BTCUSDT buy @ $1,000) to exercise the full create→verify→cancel cycle
 * without risk of fills.
 *
 * Run with:
 *   tsx --env-file=.env src/execution/scripts/live-rest-test.ts
 */

import { config as loadDotenv } from 'dotenv'
import { randomUUID } from 'node:crypto'

import { createClock } from '../core/clock.js'
import { createIds } from '../core/ids.js'
import { createRateLimiter } from '../core/ratelimit/tokenBucket.js'
import { MetricsRegistry, registerRestMetrics, registerRateLimitMetrics } from '../observability/metrics.js'
import { createBinanceRestAdapter } from '../adapters/rest/binance.js'
import type { ExchangeConfig } from '../config/types.js'

loadDotenv()

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────

function buildAdapter() {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET

  if (!apiKey || !apiSecret) {
    throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET must be set in .env')
  }

  const cfg = {
    exchange: 'binance' as const,
    enabled: true,
    credentialsEnvPrefix: 'BINANCE',
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

  const adapter = createBinanceRestAdapter({
    config: cfg,
    limiter,
    clock,
    ids,
    logger: console as never,
    metrics: restMetrics,
  })

  return { adapter, clock }
}

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${BOLD}${CYAN}=== Binance REST adapter — live mainnet test ===${RESET}\n`)

  const { adapter, clock } = buildAdapter()

  // 1. Server time + clock skew
  let serverTime = 0
  await run('getServerTime() returns a recent timestamp', async () => {
    serverTime = await adapter.getServerTime()
    const skew = clock.skewMs('binance')
    pass('getServerTime()', `serverTime=${new Date(serverTime).toISOString()}, skewMs=${String(skew)}`)
    assert(serverTime > Date.now() - 5000, 'server time should be within 5 s of local')
    assert(Math.abs(skew) < 5000, `clock skew ${String(skew)}ms should be < 5 s`)
  })

  // 2. Balance
  let usdtBalance = 0
  await run('getBalance() returns USDT balance', async () => {
    const balances = await adapter.getBalance('USDT')
    pass('getBalance(USDT)', `${String(balances.length)} entries — ${JSON.stringify(balances)}`)
    assert(Array.isArray(balances), 'should return an array')
    if (balances.length > 0) {
      const usdt = balances.find(b => b.asset === 'USDT')
      assert(usdt !== undefined, 'USDT entry present')
      usdtBalance = usdt?.available ?? 0
      assert(typeof usdtBalance === 'number', 'available should be a number')
    }
  })

  // 3. Positions
  await run('getPositions() returns array (may be empty)', async () => {
    const positions = await adapter.getPositions()
    pass('getPositions()', `${String(positions.length)} open positions`)
    assert(Array.isArray(positions), 'should return an array')
    for (const p of positions) {
      assert(p.qty > 0, `position qty should be > 0: ${JSON.stringify(p)}`)
      assert(['long', 'short'].includes(p.side), `position side must be long|short: ${p.side}`)
    }
  })

  // 4. Open orders before test
  await run('getOpenOrders(BTCUSDT) baseline (should be empty or have prior orders)', async () => {
    const orders = await adapter.getOpenOrders('BTCUSDT')
    pass('getOpenOrders(BTCUSDT) baseline', `${String(orders.length)} orders`)
    assert(Array.isArray(orders), 'should return an array')
  })

  // 5. Create a tiny limit buy far from market
  //    BTCUSDT: minimum notional $50, minimum qty step 0.001 BTC
  //    Price $10,000 × qty 0.006 = $60 notional (passes minimum)
  //    $10,000 is ~9× below market (~$93k) — safe from accidental fill
  const intentId = randomUUID()
  const clientOrderId = `livetest-${intentId.slice(0, 16)}`
  let exchangeOrderId = ''

  const orderOk = await run('createOrder() places a GTC limit buy far from market', async () => {
    const ack = await adapter.createOrder({
      intentId,
      clientOrderId,
      exchange: 'binance',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      qty: 0.006,
      price: 10000,
      timeInForce: 'GTC',
      leverage: 1,
    })
    pass('createOrder()', `status=${ack.status}, exchangeOrderId=${ack.exchangeOrderId}`)
    assert(ack.status === 'accepted', `expected accepted, got ${ack.status}: ${ack.rejectReason ?? ''}`)
    assert(ack.exchangeOrderId.length > 0, 'exchangeOrderId must be non-empty')
    assert(ack.clientOrderId === clientOrderId, 'clientOrderId round-trips correctly')
    exchangeOrderId = ack.exchangeOrderId
  })

  if (!orderOk) {
    console.log(`\n${YELLOW}⚠  Skipping order-dependent tests (createOrder failed)${RESET}\n`)
  } else {
    // 6. Verify open orders list contains the new order
    await run('getOpenOrders() shows the newly placed order', async () => {
      const orders = await adapter.getOpenOrders('BTCUSDT')
      const found = orders.find(o => o.exchangeOrderId === exchangeOrderId)
      pass('getOpenOrders() post-create', `${String(orders.length)} orders, found=${String(found !== undefined)}`)
      if (found === undefined) throw new Error(`order ${exchangeOrderId} not found in open orders`)
      assert(found.status === 'new' || found.status === 'partially_filled', `unexpected status: ${found.status}`)
    })

    // 7. getOrder by ref
    await run('getOrder() retrieves the order by ref', async () => {
      const order = await adapter.getOrder({ symbol: 'BTCUSDT', exchangeOrderId, clientOrderId })
      pass('getOrder()', `found=${String(order !== undefined)}, status=${order?.status ?? 'unknown'}`)
      if (order === undefined) throw new Error('getOrder should find the order')
      assert(order.exchangeOrderId === exchangeOrderId, 'exchangeOrderId matches')
    })

    // 8. Duplicate clientOrderId handling: the adapter must not throw regardless of exchange response.
    //    The -2010 idempotency path fires on network errors; deliberate re-POST may get a different
    //    rejection code from USDT-M futures. Either way the adapter must return an OrderAck.
    await run('createOrder() with duplicate clientOrderId returns OrderAck (no throw)', async () => {
      const ack2 = await adapter.createOrder({
        intentId,
        clientOrderId,
        exchange: 'binance',
        symbol: 'BTCUSDT',
        side: 'buy',
        type: 'limit',
        qty: 0.006,
        price: 10000,
        timeInForce: 'GTC',
        leverage: 1,
      })
      pass(
        'duplicate clientOrderId handled gracefully',
        `status=${ack2.status}, rejectReason=${ack2.rejectReason ?? 'none'}`
      )
      assert(['accepted', 'rejected'].includes(ack2.status), `status must be accepted|rejected, got ${ack2.status}`)
      // If the -2010 idempotency path fired it should resolve to the same exchangeOrderId
      if (ack2.status === 'accepted') {
        assert(ack2.exchangeOrderId === exchangeOrderId, `idempotency: expected same exchangeOrderId`)
      }
    })

    // 9. Cancel the order
    await run('cancelOrder() removes the order', async () => {
      await adapter.cancelOrder({ symbol: 'BTCUSDT', exchangeOrderId, clientOrderId })
      pass('cancelOrder()', `cancelled ${exchangeOrderId}`)
    })

    // 10. Verify open orders no longer contains it
    await run('getOpenOrders() after cancel shows order gone', async () => {
      const orders = await adapter.getOpenOrders('BTCUSDT')
      const found = orders.find(o => o.exchangeOrderId === exchangeOrderId)
      pass('getOpenOrders() post-cancel', `${String(orders.length)} orders, found=${String(found !== undefined)}`)
      assert(found === undefined, `order ${exchangeOrderId} should be gone from open orders`)
    })

    // 11. cancelOrder on already-cancelled order resolves (no throw)
    await run('cancelOrder() on missing order resolves gracefully', async () => {
      await adapter.cancelOrder({ symbol: 'BTCUSDT', exchangeOrderId, clientOrderId })
      pass('cancelOrder() on missing order', 'resolved without throw')
    })
  }

  // 12. Dispose
  await run('dispose() closes the CCXT client cleanly', async () => {
    await adapter.dispose()
    pass('dispose()', 'clean shutdown')
  })

  // ──────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────
  const total = passed + failed
  console.log(
    `\n${BOLD}Results: ${GREEN}${String(passed)}/${String(total)} passed${failed > 0 ? `  ${RED}${String(failed)} failed` : ''}${RESET}\n`
  )

  if (failed > 0) process.exitCode = 1
  process.exit(process.exitCode ?? 0)
}

main().catch((err: unknown) => {
  console.error(`${RED}Fatal error:${RESET}`, err)
  process.exitCode = 1
})
