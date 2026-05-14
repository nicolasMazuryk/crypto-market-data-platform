import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, afterEach } from 'vitest'

import { loadRegistry, saveRegistry } from './loader.js'
import { REQUIRED_IP_ALLOW_LIST } from './schema.js'
import type { Registry } from './schema.js'

const VALID_IP_LIST = [...REQUIRED_IP_ALLOW_LIST]

function makeRegistry(overrides: Partial<Registry> = {}): Registry {
  return {
    combinations: [],
    ...overrides,
  }
}

function validEntry() {
  return {
    exchange: 'bybit' as const,
    sub_account_id: '99999',
    sub_account_label: 'strat3a-bybit',
    assigned_strategy: 'strategy_3a',
    api_key: 'key123',
    api_secret: 'secret123',
    api_passphrase: null,
    ip_allow_list: VALID_IP_LIST,
    allocated_capital_usdt: 200,
    provisioning_mode: 'full_api' as const,
    status: 'active' as const,
    created_at: '2026-05-09T12:00:00Z',
    last_assigned_at: '2026-05-09T12:00:00Z',
    notes: '',
  }
}

const tmpFiles: string[] = []

function tmpPath(): string {
  const p = join(tmpdir(), `registry-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}.yaml`)
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

describe('loadRegistry', () => {
  it('loads an empty registry', () => {
    const p = tmpPath()
    writeFileSync(p, 'combinations: []\n', 'utf8')
    const registry = loadRegistry(p)
    expect(registry.combinations).toHaveLength(0)
  })

  it('loads a registry with one entry', () => {
    const p = tmpPath()
    const registry: Registry = makeRegistry({ combinations: [validEntry()] })
    saveRegistry(p, registry)
    const loaded = loadRegistry(p)
    expect(loaded.combinations).toHaveLength(1)
    expect(loaded.combinations[0]!.exchange).toBe('bybit')
  })

  it('throws on invalid registry YAML', () => {
    const p = tmpPath()
    writeFileSync(p, 'combinations:\n  - exchange: not_a_real_exchange\n    assigned_strategy: x\n', 'utf8')
    expect(() => loadRegistry(p)).toThrow()
  })
})

describe('saveRegistry', () => {
  it('round-trips an empty registry', () => {
    const p = tmpPath()
    const original = makeRegistry()
    saveRegistry(p, original)
    const loaded = loadRegistry(p)
    expect(loaded.combinations).toHaveLength(0)
  })

  it('round-trips a registry with entries', () => {
    const p = tmpPath()
    const original = makeRegistry({ combinations: [validEntry()] })
    saveRegistry(p, original)
    const loaded = loadRegistry(p)
    expect(loaded.combinations[0]!.api_key).toBe('key123')
    expect(loaded.combinations[0]!.allocated_capital_usdt).toBe(200)
  })

  it('does not leave .tmp file on success', () => {
    const p = tmpPath()
    saveRegistry(p, makeRegistry())
    expect(existsSync(`${p}.tmp`)).toBe(false)
    expect(existsSync(p)).toBe(true)
  })

  it('overwrites an existing registry', () => {
    const p = tmpPath()
    saveRegistry(p, makeRegistry({ combinations: [validEntry()] }))
    saveRegistry(p, makeRegistry())
    const loaded = loadRegistry(p)
    expect(loaded.combinations).toHaveLength(0)
  })
})
