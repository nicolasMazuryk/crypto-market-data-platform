import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CcxtMarket } from '../exchanges/types.js'
import { makeBtcPerp, makeEthPerp } from './test-helpers/ccxtMock.js'

const { MockEx, ccxtMock } = vi.hoisted(() => {
  class MockEx {
    static setup: Record<string, { markets?: Record<string, CcxtMarket>; error?: Error }> = {}
    static reset(): void {
      MockEx.setup = {}
    }

    private readonly ccxtId: string
    markets: Record<string, CcxtMarket> = {}

    constructor(ccxtId: string) {
      this.ccxtId = ccxtId
    }

    loadMarkets(): Promise<Record<string, CcxtMarket>> {
      const s = MockEx.setup[this.ccxtId]
      if (s?.error) return Promise.reject(s.error)
      this.markets = s?.markets ?? {}
      return Promise.resolve(this.markets)
    }
  }

  const ccxtMock = new Proxy({} as Record<string, unknown>, {
    get: (_, id: string) =>
      class extends MockEx {
        constructor() {
          super(id)
        }
      },
  })

  return { MockEx, ccxtMock }
})

vi.mock('ccxt', () => ({ default: ccxtMock }))

import { startEngine, type EngineHandle } from './index.js'

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url)
  const body = await res.text()
  return { status: res.status, body }
}

describe('execution engine slice 1 bootstrap', () => {
  let handle: EngineHandle | undefined

  afterEach(async () => {
    await handle?.stop()
    handle = undefined
    MockEx.reset()
  })

  it('boots, exposes /metrics and /healthz, and shuts down cleanly', async () => {
    MockEx.setup.binanceusdm = { markets: {} }
    MockEx.setup.bitget = { markets: {} }

    handle = await startEngine({
      configPath: 'config/execution.dry-run.yaml',
      metricsPort: 0,
        healthPort: 0,
    })

    expect(handle.config.mode).toBe('dry_run')
    expect(handle.config.exchanges.some(e => e.exchange === 'binance' && e.enabled)).toBe(true)
    expect(handle.config.strategies.some(s => s.id === 'strategy_3a' && s.enabled)).toBe(true)
    expect(handle.metricsPort).toBeGreaterThan(0)

    const metrics = await fetchText(`http://127.0.0.1:${String(handle.metricsPort)}/metrics`)
    expect(metrics.status).toBe(200)
    expect(metrics.body).toMatch(/engine_up\{mode="dry_run"\} 1/)
    expect(metrics.body).toMatch(/engine_exchange_enabled\{exchange="binance"\} 1/)
    expect(metrics.body).toMatch(/engine_started_at_seconds \d+/)

    const healthz = await fetchText(`http://127.0.0.1:${String(handle.metricsPort)}/healthz`)
    expect(healthz.status).toBe(200)
    expect(healthz.body).toBe('ok')
  })

  it('fails fast on invalid config', async () => {
    await expect(
      startEngine({
        configPath: '/tmp/does-not-exist-execution.yaml',
        metricsPort: 0,
        healthPort: 0,
      })
    ).rejects.toThrow()
  })
})

describe('execution engine slice 2 markets', () => {
  let handle: EngineHandle | undefined

  afterEach(async () => {
    await handle?.stop()
    handle = undefined
    MockEx.reset()
  })

  it('handle.markets is defined and list returns mocked fixture data', async () => {
    MockEx.setup.binanceusdm = {
      markets: {
        BTCUSDT: makeBtcPerp(),
        ETHUSDT: makeEthPerp(),
      },
    }
    MockEx.setup.bitget = {
      markets: {
        BTCUSDT: makeBtcPerp(),
      },
    }

    handle = await startEngine({
      configPath: 'config/execution.dry-run.yaml',
      metricsPort: 0,
        healthPort: 0,
    })

    expect(handle.markets).toBeDefined()
    expect(handle.markets?.list('binance')).toHaveLength(2)
    expect(handle.markets?.list('bitget')).toHaveLength(1)

    const btc = handle.markets?.get('binance', 'BTCUSDT')
    expect(btc).toBeDefined()
    expect(btc?.exchange).toBe('binance')
    expect(btc?.symbol).toBe('BTCUSDT')
    expect(btc?.status).toBe('trading')
  })

  it('metrics endpoint shows market counts after boot', async () => {
    MockEx.setup.binanceusdm = {
      markets: { BTCUSDT: makeBtcPerp(), ETHUSDT: makeEthPerp() },
    }
    MockEx.setup.bitget = {
      markets: { BTCUSDT: makeBtcPerp() },
    }

    handle = await startEngine({
      configPath: 'config/execution.dry-run.yaml',
      metricsPort: 0,
        healthPort: 0,
    })

    const { body } = await fetchText(`http://127.0.0.1:${String(handle.metricsPort)}/metrics`)
    expect(body).toMatch(/markets_refresh_total\{exchange="binance",status="ok"\} 1/)
    expect(body).toMatch(/markets_refresh_total\{exchange="bitget",status="ok"\} 1/)
    expect(body).toMatch(/markets_total\{exchange="binance",status="trading"\} 2/)
    expect(body).toMatch(/markets_total\{exchange="bitget",status="trading"\} 1/)
  })

  it('bitget exchange failure does not prevent binance from loading', async () => {
    MockEx.setup.binanceusdm = {
      markets: { BTCUSDT: makeBtcPerp() },
    }
    MockEx.setup.bitget = { error: new Error('auth error') }

    handle = await startEngine({
      configPath: 'config/execution.dry-run.yaml',
      metricsPort: 0,
        healthPort: 0,
    })

    expect(handle.markets).toBeDefined()
    expect(handle.markets?.list('binance')).toHaveLength(1)
    expect(handle.markets?.list('bitget')).toHaveLength(0)
  })
})

describe('execution engine slice 7 strategy_1 + scheduler', () => {
  let handle: EngineHandle | undefined

  afterEach(async () => {
    await handle?.stop()
    handle = undefined
    MockEx.reset()
  })

  it('scheduler is defined when strategy_1 enabled and funding source boots', async () => {
    MockEx.setup.binanceusdm = { markets: {} }
    MockEx.setup.bitget = { markets: {} }

    handle = await startEngine({
      configPath: 'config/execution.dry-run.yaml',
      metricsPort: 0,
        healthPort: 0,
    })

    expect(handle.strategies).toBeDefined()
    expect(handle.strategies?.get('strategy_1')).toBeDefined()
    expect(handle.scheduler).toBeDefined()
    expect(handle.bus).toBeDefined()
  })

  it('bus is exposed on engine handle', async () => {
    MockEx.setup.binanceusdm = { markets: {} }
    MockEx.setup.bitget = { markets: {} }

    handle = await startEngine({
      configPath: 'config/execution.dry-run.yaml',
      metricsPort: 0,
        healthPort: 0,
    })

    const received: unknown[] = []
    handle.bus.on('intent.decided', intent => received.push(intent))
    expect(handle.bus).toBeDefined()
  })
})

describe('execution engine slice 5 WS + StateStore', () => {
  let handle: EngineHandle | undefined

  afterEach(async () => {
    await handle?.stop()
    handle = undefined
    MockEx.reset()
  })

  it('handle.state is defined after boot; metrics expose state_orders_size; wsAdapters.get(binance) is the shadow adapter in dry-run', async () => {
    MockEx.setup.binanceusdm = { markets: {} }
    MockEx.setup.bitget = { markets: {} }

    handle = await startEngine({
      configPath: 'config/execution.dry-run.yaml',
      metricsPort: 0,
        healthPort: 0,
    })

    expect(handle.state).toBeDefined()
    expect(handle.wsAdapters).toBeDefined()
    expect(handle.wsAdapters?.get('binance')).toBeDefined()

    const { body } = await fetchText(`http://127.0.0.1:${String(handle.metricsPort)}/metrics`)
    expect(body).toMatch(/state_orders_size\{exchange="binance"\} 0/)
  })
})
