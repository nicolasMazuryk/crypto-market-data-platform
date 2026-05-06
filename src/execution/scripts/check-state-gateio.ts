/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion */
async function main() {
  const { createClock } = await import('../core/clock.js')
  const { createIds } = await import('../core/ids.js')
  const { createRateLimiter } = await import('../core/ratelimit/tokenBucket.js')
  const { MetricsRegistry, registerRestMetrics, registerRateLimitMetrics } = await import('../observability/metrics.js')
  const { createGateioRestAdapter } = await import('../adapters/rest/gateio.js')
  const cfg = {
    exchange: 'gateio' as const,
    enabled: true,
    credentialsEnvPrefix: 'GATEIO',
    marketRefreshMs: 60000,
    fundingPullMs: 15000,
    rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    credentials: { apiKey: process.env.GATEIO_API_KEY!, apiSecret: process.env.GATEIO_API_SECRET! },
  } as any
  const registry = new MetricsRegistry()
  const adapter = createGateioRestAdapter({
    config: cfg,
    limiter: createRateLimiter({
      profile: cfg.rateLimits,
      metrics: registerRateLimitMetrics(registry),
      logger: console as never,
    }),
    clock: createClock(),
    ids: createIds(),
    logger: console as never,
    metrics: registerRestMetrics(registry),
  })
  const positions = await adapter.getPositions()
  const balance = await adapter.getBalance('USDT')
  console.log('POSITIONS:', JSON.stringify(positions, null, 2))
  console.log('BALANCE:', JSON.stringify(balance, null, 2))
  const openOrders = await adapter.getOpenOrders('SOLVUSDT')
  console.log('OPEN_ORDERS SOLVUSDT:', JSON.stringify(openOrders, null, 2))
  await adapter.dispose()
}
main().catch(console.error)
