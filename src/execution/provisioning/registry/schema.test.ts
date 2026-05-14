import { describe, it, expect } from 'vitest'

import { RegistryEntrySchema, RegistrySchema, REQUIRED_IP_ALLOW_LIST } from './schema.js'

const VALID_IP_LIST = [...REQUIRED_IP_ALLOW_LIST]

function baseEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exchange: 'bybit',
    sub_account_id: '12345',
    sub_account_label: 'strat3a-bybit',
    assigned_strategy: 'strategy_3a',
    api_key: 'key123',
    api_secret: 'secret123',
    api_passphrase: null,
    ip_allow_list: VALID_IP_LIST,
    allocated_capital_usdt: 200,
    provisioning_mode: 'full_api',
    status: 'active',
    created_at: '2026-05-09T12:00:00Z',
    last_assigned_at: '2026-05-09T12:00:00Z',
    notes: '',
    ...overrides,
  }
}

describe('RegistryEntrySchema', () => {
  it('parses a valid bybit entry', () => {
    const result = RegistryEntrySchema.parse(baseEntry())
    expect(result.exchange).toBe('bybit')
    expect(result.status).toBe('active')
  })

  it('parses a valid okx entry with passphrase', () => {
    const result = RegistryEntrySchema.parse(
      baseEntry({ exchange: 'okx', api_passphrase: 'mypass', provisioning_mode: 'manual_register' })
    )
    expect(result.api_passphrase).toBe('mypass')
  })

  it('rejects missing passphrase for okx (active entry)', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ exchange: 'okx', api_passphrase: null }))).toThrow()
  })

  it('allows missing passphrase for bitget (active entry)', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ exchange: 'bitget', api_passphrase: null }))).not.toThrow()
  })

  it('rejects missing passphrase for kucoin (active entry)', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ exchange: 'kucoin', api_passphrase: null }))).toThrow()
  })

  it('allows missing passphrase for okx when status is failed', () => {
    expect(() =>
      RegistryEntrySchema.parse(
        baseEntry({ exchange: 'okx', api_passphrase: null, status: 'failed', api_key: '', api_secret: '' })
      )
    ).not.toThrow()
  })

  it('does not require passphrase for bybit', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ exchange: 'bybit', api_passphrase: null }))).not.toThrow()
  })

  it('rejects wrong ip_allow_list', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ ip_allow_list: ['1.2.3.4'] }))).toThrow(/ip_allow_list/)
  })

  it('rejects ip_allow_list with extra IPs', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ ip_allow_list: [...VALID_IP_LIST, '10.0.0.1'] }))).toThrow(
      /ip_allow_list/
    )
  })

  it('accepts ip_allow_list in reverse order', () => {
    const reversed = [...VALID_IP_LIST].reverse()
    expect(() => RegistryEntrySchema.parse(baseEntry({ ip_allow_list: reversed }))).not.toThrow()
  })

  it('allows zero allocated_capital_usdt for idle entries', () => {
    expect(() =>
      RegistryEntrySchema.parse(
        baseEntry({
          assigned_strategy: null,
          allocated_capital_usdt: 0,
          api_key: '',
          api_secret: '',
          status: 'idle',
          last_assigned_at: null,
        })
      )
    ).not.toThrow()
  })

  it('rejects negative allocated_capital_usdt', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ allocated_capital_usdt: -50 }))).toThrow()
  })

  it('rejects invalid status', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ status: 'retired' }))).toThrow()
  })

  it('rejects unknown exchange', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ exchange: 'kraken' }))).toThrow()
  })

  it('rejects active entries without assigned_strategy', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ assigned_strategy: null, status: 'active' }))).toThrow(
      /assigned_strategy/
    )
  })

  it('rejects idle entries with assigned_strategy or capital', () => {
    expect(() => RegistryEntrySchema.parse(baseEntry({ status: 'idle', allocated_capital_usdt: 0 }))).toThrow()
    expect(() =>
      RegistryEntrySchema.parse(baseEntry({ status: 'idle', assigned_strategy: null, allocated_capital_usdt: 1 }))
    ).toThrow(/allocated_capital_usdt/)
  })
})

describe('RegistrySchema', () => {
  it('parses an empty registry', () => {
    const result = RegistrySchema.parse({ combinations: [] })
    expect(result.combinations).toHaveLength(0)
  })

  it('parses registry with default empty combinations', () => {
    const result = RegistrySchema.parse({})
    expect(result.combinations).toHaveLength(0)
  })

  it('treats null combinations as empty', () => {
    const result = RegistrySchema.parse({ combinations: null })
    expect(result.combinations).toHaveLength(0)
  })

  it('parses a valid multi-entry registry', () => {
    const result = RegistrySchema.parse({
      combinations: [baseEntry(), baseEntry({ exchange: 'mexc' })],
    })
    expect(result.combinations).toHaveLength(2)
  })

  it('rejects duplicate active (assigned_strategy, exchange) pairs', () => {
    expect(() =>
      RegistrySchema.parse({
        combinations: [baseEntry(), baseEntry()],
      })
    ).toThrow(/duplicate/)
  })

  it('allows multiple idle entries on the same exchange', () => {
    expect(() =>
      RegistrySchema.parse({
        combinations: [
          baseEntry({
            sub_account_id: 'idle-1',
            assigned_strategy: null,
            status: 'idle',
            allocated_capital_usdt: 0,
            api_key: '',
            api_secret: '',
            last_assigned_at: null,
          }),
          baseEntry({
            sub_account_id: 'idle-2',
            assigned_strategy: null,
            status: 'idle',
            allocated_capital_usdt: 0,
            api_key: '',
            api_secret: '',
            last_assigned_at: null,
          }),
        ],
      })
    ).not.toThrow()
  })

  it('rejects duplicate (exchange, sub_account_id) pairs', () => {
    expect(() =>
      RegistrySchema.parse({
        combinations: [baseEntry(), baseEntry({ assigned_strategy: 'strategy_4a' })],
      })
    ).toThrow(/duplicate/)
  })

  it('allows same strategy on different exchanges', () => {
    expect(() =>
      RegistrySchema.parse({
        combinations: [baseEntry({ exchange: 'bybit' }), baseEntry({ exchange: 'mexc' })],
      })
    ).not.toThrow()
  })

  it('allows same exchange for different strategies', () => {
    expect(() =>
      RegistrySchema.parse({
        combinations: [
          baseEntry({ assigned_strategy: 'strategy_1', exchange: 'bybit', sub_account_id: '1' }),
          baseEntry({ assigned_strategy: 'strategy_3a', exchange: 'bybit', sub_account_id: '2' }),
        ],
      })
    ).not.toThrow()
  })
})
