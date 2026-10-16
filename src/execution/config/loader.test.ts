import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, it, expect, afterEach } from 'vitest'
import YAML from 'yaml'

import { loadEngineConfig, validateForLiveStart } from './loader.js'
import { parseEngineConfig } from './schema.js'
import type { ExchangeConfig, ExchangeCredentials } from './types.js'
import { REQUIRED_IP_ALLOW_LIST } from '../provisioning/registry/schema.js'

type ExchangeWithCredentials = ExchangeConfig & { credentials?: ExchangeCredentials }

const VALID_IP_LIST = [...REQUIRED_IP_ALLOW_LIST]

const tmpFiles: string[] = []

function tmp(suffix = '.yaml'): string {
  const p = join(tmpdir(), `loader-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}${suffix}`)
  tmpFiles.push(p)
  return p
}

afterEach(() => {
  for (const f of tmpFiles) {
    if (existsSync(f)) unlinkSync(f)
    if (existsSync(`${f}.tmp`)) unlinkSync(`${f}.tmp`)
  }
  tmpFiles.length = 0
})

const BASE_CONFIG = {
  mode: 'dry_run',
  exchanges: [
    {
      exchange: 'bybit',
      enabled: true,
      credentialsEnvPrefix: 'BYBIT',
    },
  ],
  strategies: [],
}

describe('loadEngineConfig — registry credential resolution', () => {
  it('uses registry credentials over env vars when registry has an active entry', () => {
    const configPath = tmp()
    writeFileSync(configPath, YAML.stringify(BASE_CONFIG), 'utf8')

    const registryPath = tmp()
    const registry = {
      combinations: [
        {
          exchange: 'bybit',
          sub_account_id: '99999',
          sub_account_label: 'strat3a-bybit',
          assigned_strategy: 'strategy_3a',
          api_key: 'registry-key',
          api_secret: 'registry-secret',
          api_passphrase: null,
          ip_allow_list: VALID_IP_LIST,
          allocated_capital_usdt: 200,
          provisioning_mode: 'full_api',
          status: 'active',
          created_at: '2026-05-09T12:00:00Z',
          last_assigned_at: '2026-05-09T12:00:00Z',
          notes: '',
        },
      ],
    }
    writeFileSync(registryPath, YAML.stringify(registry), 'utf8')

    const env = {
      BYBIT_API_KEY: 'env-key',
      BYBIT_API_SECRET: 'env-secret',
    }

    const config = loadEngineConfig({
      configPath,
      basePath: '',
      env,
      registryPath,
    })

    const bybit = config.exchanges.find(e => e.exchange === 'bybit') as ExchangeWithCredentials | undefined
    expect(bybit?.credentials?.apiKey).toBe('registry-key')
    expect(bybit?.credentials?.apiSecret).toBe('registry-secret')
  })

  it('falls back to env vars when registry has no active entry for the exchange', () => {
    const configPath = tmp()
    writeFileSync(configPath, YAML.stringify(BASE_CONFIG), 'utf8')

    const registryPath = tmp()
    writeFileSync(registryPath, YAML.stringify({ combinations: [] }), 'utf8')

    const env = {
      BYBIT_API_KEY: 'env-key',
      BYBIT_API_SECRET: 'env-secret',
    }

    const config = loadEngineConfig({
      configPath,
      basePath: '',
      env,
      registryPath,
    })

    const bybit = config.exchanges.find(e => e.exchange === 'bybit') as ExchangeWithCredentials | undefined
    expect(bybit?.credentials?.apiKey).toBe('env-key')
    expect(bybit?.credentials?.apiSecret).toBe('env-secret')
  })

  it('falls back to env vars when registry entry is idle', () => {
    const configPath = tmp()
    writeFileSync(configPath, YAML.stringify(BASE_CONFIG), 'utf8')

    const registryPath = tmp()
    const registry = {
      combinations: [
        {
          exchange: 'bybit',
          sub_account_id: '99999',
          sub_account_label: 'strat3a-bybit',
          assigned_strategy: null,
          api_key: 'registry-key',
          api_secret: 'registry-secret',
          api_passphrase: null,
          ip_allow_list: VALID_IP_LIST,
          allocated_capital_usdt: 0,
          provisioning_mode: 'full_api',
          status: 'idle',
          created_at: '2026-05-09T12:00:00Z',
          last_assigned_at: null,
          notes: '',
        },
      ],
    }
    writeFileSync(registryPath, YAML.stringify(registry), 'utf8')

    const env = {
      BYBIT_API_KEY: 'env-key',
      BYBIT_API_SECRET: 'env-secret',
    }

    const config = loadEngineConfig({
      configPath,
      basePath: '',
      env,
      registryPath,
    })

    const bybit = config.exchanges.find(e => e.exchange === 'bybit') as ExchangeWithCredentials | undefined
    expect(bybit?.credentials?.apiKey).toBe('env-key')
  })

  it('picks the registry entry matching the active strategy when multiple entries exist for the same exchange', () => {
    const configPath = tmp()
    const configWithStrategy = {
      mode: 'dry_run',
      exchanges: [{ exchange: 'bybit', enabled: true, credentialsEnvPrefix: 'BYBIT' }],
      strategies: [
        {
          id: 'strategy_6',
          enabled: true,
          mainSide: 'long',
          mainAmountUsd: 100,
          leverage: 5,
        },
      ],
    }
    writeFileSync(configPath, YAML.stringify(configWithStrategy), 'utf8')

    const registryPath = tmp()
    const makeEntry = (assignedStrategy: string, apiKey: string) => ({
      exchange: 'bybit',
      sub_account_id: assignedStrategy,
      sub_account_label: assignedStrategy,
      assigned_strategy: assignedStrategy,
      api_key: apiKey,
      api_secret: `${apiKey}-secret`,
      api_passphrase: null,
      ip_allow_list: VALID_IP_LIST,
      allocated_capital_usdt: 100,
      provisioning_mode: 'full_api',
      status: 'active',
      created_at: '2026-05-09T12:00:00Z',
      last_assigned_at: '2026-05-09T12:00:00Z',
      notes: '',
    })
    const registry = {
      combinations: [makeEntry('strategy_1', 'strategy1-key'), makeEntry('strategy_6', 'strategy6-key')],
    }
    writeFileSync(registryPath, YAML.stringify(registry), 'utf8')

    const config = loadEngineConfig({ configPath, basePath: '', env: {}, registryPath })
    const bybit = config.exchanges.find(e => e.exchange === 'bybit') as ExchangeWithCredentials | undefined
    expect(bybit?.credentials?.apiKey).toBe('strategy6-key')
  })

  it('works without registryPath (backward compat)', () => {
    const configPath = tmp()
    writeFileSync(configPath, YAML.stringify(BASE_CONFIG), 'utf8')

    const env = {
      BYBIT_API_KEY: 'env-key',
      BYBIT_API_SECRET: 'env-secret',
    }

    const config = loadEngineConfig({ configPath, basePath: '', env })
    const bybit = config.exchanges.find(e => e.exchange === 'bybit') as ExchangeWithCredentials | undefined
    expect(bybit?.credentials?.apiKey).toBe('env-key')
  })
})

describe('validateForLiveStart', () => {
  it('throws in live mode when an exchange is enabled but no strategy is enabled', () => {
    const config = parseEngineConfig({
      mode: 'live',
      exchanges: [
        {
          exchange: 'bybit',
          enabled: true,
          credentialsEnvPrefix: 'BYBIT',
        },
      ],
      strategies: [],
    })

    expect(() => {
      validateForLiveStart(config)
    }).toThrow(/1 exchange\(s\) enabled but 0 strategies enabled/)
  })
})

describe('strategy_1 live YAMLs (Task 06 exitOffsetSeconds >=6 migration)', () => {
  it('rejects exitOffsetSeconds=4 (below the new >=6 bound, R2)', () => {
    expect(() =>
      parseEngineConfig({
        mode: 'dry_run',
        exchanges: [],
        strategies: [
          {
            id: 'strategy_1',
            enabled: true,
            negativeFundingThresholdPercent: -0.1,
            entryOffsetSeconds: 3,
            exitOffsetSeconds: 4,
            amountUsd: 10,
            leverage: 5,
          },
        ],
      })
    ).toThrow()
  })
})

// Task 22 (F8/R9): OKX per-exchange deltas (§8) are config-driven via per-exchange YAML, not
// hardcoded engine constants — assert the canonical params load straight through with no fallback.
describe('OKX per-exchange deltas load from live-configs YAML (F8/R9, verification only)', () => {
  it.each(['strategy_1_ws', 'strategy_6'])('%s-okx.yaml sets fundingFeeTimeoutSeconds=45 (binance=10)', strategyId => {
    const yamlPath = resolve(process.cwd(), 'live-configs', 'strategies', `${strategyId}-okx.yaml`)
    const raw = YAML.parse(readFileSync(yamlPath, 'utf8')) as Record<string, unknown>
    const config = parseEngineConfig({ mode: 'dry_run', exchanges: [], ...raw })

    expect(config.strategies[0]?.id).toBe(strategyId)
    expect((config.strategies[0] as { fundingFeeTimeoutSeconds?: number }).fundingFeeTimeoutSeconds).toBe(45)
  })
})
