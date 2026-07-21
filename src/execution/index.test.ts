import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'

import type { CcxtMarket } from '../exchanges/types.js'
import { makeBtcPerp, makeEthPerp } from './test-helpers/ccxtMock.js'
import { REQUIRED_IP_ALLOW_LIST } from './provisioning/registry/schema.js'
import type * as ManagerModule from './execution/manager.js'

const { createExecutionManagerSpy } = vi.hoisted(() => ({ createExecutionManagerSpy: vi.fn() }))

const { MockEx, ccxtMock, loggerInfo } = vi.hoisted(() => {
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

  const loggerInfo = vi.fn()

  return { MockEx, ccxtMock, loggerInfo }
})

vi.mock('ccxt', () => ({ default: ccxtMock }))
vi.mock('./core/logger.js', () => {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: loggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger),
    childFor: vi.fn(() => logger),
    childForIntent: vi.fn(() => logger),
  }
  return { createExecutionLogger: () => logger }
})
vi.mock('./execution/manager.js', async importOriginal => {
  const actual = await importOriginal<typeof ManagerModule>()
  return {
    ...actual,
    createExecutionManager: (opts: Parameters<typeof actual.createExecutionManager>[0]) => {
      createExecutionManagerSpy(opts)
      return actual.createExecutionManager(opts)
    },
  }
})

import { startEngine, type EngineHandle } from './index.js'

const tmpPaths: string[] = []

function tmpPath(name: string): string {
  const p = join(tmpdir(), `execution-index-test-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(p, { recursive: true })
  tmpPaths.push(p)
  return join(p, name)
}

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
    loggerInfo.mockClear()
    createExecutionManagerSpy.mockClear()
    for (const p of tmpPaths.splice(0)) {
      const dir = p.endsWith('.yaml') ? p.slice(0, p.lastIndexOf('/')) : p
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
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

  it('configures submissionStaggerMs for all supported exchanges', async () => {
    MockEx.setup.binanceusdm = { markets: {} }
    MockEx.setup.bitget = { markets: {} }

    handle = await startEngine({
      configPath: 'config/execution.dry-run.yaml',
      metricsPort: 0,
      healthPort: 0,
    })

    expect(createExecutionManagerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionStaggerMs: { bybit: 150, binance: 100, okx: 100, gateio: 100, kucoin: 100, bitget: 100 },
      })
    )
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

  it('rejects live startup when an exchange is enabled but no strategy is enabled', async () => {
    const configPath = tmpPath('execution.empty-strategies.yaml')
    writeFileSync(
      configPath,
      YAML.stringify({
        mode: 'live',
        exchanges: [
          {
            exchange: 'binance',
            enabled: true,
            credentialsEnvPrefix: 'BINANCE',
          },
        ],
        strategies: [],
      }),
      'utf8'
    )

    await expect(
      startEngine({
        configPath,
        metricsPort: 0,
        healthPort: 0,
      })
    ).rejects.toThrow(/1 exchange\(s\) enabled but 0 strategies enabled/)
  })

  it('logs identity fields in engine.started when identity is resolved', async () => {
    MockEx.setup.binanceusdm = { markets: {} }

    const configPath = tmpPath('execution.identity.yaml')
    const registryPath = tmpPath('registry.yaml')
    writeFileSync(
      configPath,
      YAML.stringify({
        mode: 'dry_run',
        exchanges: [
          {
            exchange: 'binance',
            enabled: true,
            credentialsEnvPrefix: 'BINANCE',
          },
        ],
        strategies: [
          {
            id: 'strategy_3a',
            enabled: true,
          },
        ],
      }),
      'utf8'
    )
    writeFileSync(
      registryPath,
      YAML.stringify({
        combinations: [
          {
            exchange: 'binance',
            sub_account_id: 'sub-123',
            sub_account_label: 'strategy_3a-binance',
            assigned_strategy: 'strategy_3a',
            api_key: 'registry-key',
            api_secret: 'registry-secret',
            api_passphrase: null,
            ip_allow_list: [...REQUIRED_IP_ALLOW_LIST],
            allocated_capital_usdt: 200,
            provisioning_mode: 'full_api',
            status: 'active',
            created_at: '2026-05-09T12:00:00Z',
            last_assigned_at: '2026-05-09T12:00:00Z',
            notes: '',
          },
        ],
      }),
      'utf8'
    )

    handle = await startEngine({
      configPath,
      registryPath,
      metricsPort: 0,
      healthPort: 0,
    })

    const startedPayload = loggerInfo.mock.calls
      .map(call => call[0] as Record<string, unknown>)
      .find(payload => payload.event === 'engine.started')

    expect(startedPayload).toMatchObject({
      strategy: 'strategy_3a',
      exchange: 'binance',
      subAccountId: 'sub-123',
      combinationId: 'strategy_3a-binance',
    })
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
