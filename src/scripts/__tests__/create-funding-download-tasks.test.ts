import { describe, expect, it } from 'vitest'

import { isListedOnDate, parseConfig, previousDay } from '../create-funding-download-tasks.js'
import type { MarketRow } from '../../db/types.js'

describe('previousDay', () => {
  it('returns the day before a given date', () => {
    expect(previousDay('2025-06-15')).toBe('2025-06-14')
  })

  it('handles month boundary', () => {
    expect(previousDay('2025-03-01')).toBe('2025-02-28')
  })

  it('handles year boundary', () => {
    expect(previousDay('2025-01-01')).toBe('2024-12-31')
  })

  it('handles leap year', () => {
    expect(previousDay('2024-03-01')).toBe('2024-02-29')
  })
})

function makeMarket(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchange_symbol: 'BTCUSDT',
    type: 'swap',
    listing_date: null,
    delisting_date: null,
    is_active: true,
    ...overrides,
  }
}

describe('isListedOnDate', () => {
  it('returns true when no listing or delisting date', () => {
    expect(isListedOnDate(makeMarket(), '2025-06-15')).toBe(true)
  })

  it('returns true when date is after listing date', () => {
    const market = makeMarket({ listing_date: '2025-01-01 00:00:00' })
    expect(isListedOnDate(market, '2025-06-15')).toBe(true)
  })

  it('returns false when date is before listing date', () => {
    const market = makeMarket({ listing_date: '2025-06-20 00:00:00' })
    expect(isListedOnDate(market, '2025-06-15')).toBe(false)
  })

  it('returns true when date equals listing date', () => {
    const market = makeMarket({ listing_date: '2025-06-15 00:00:00' })
    expect(isListedOnDate(market, '2025-06-15')).toBe(true)
  })

  it('returns false when date is after delisting date', () => {
    const market = makeMarket({ delisting_date: '2025-06-10 00:00:00' })
    expect(isListedOnDate(market, '2025-06-15')).toBe(false)
  })

  it('returns true when date equals delisting date', () => {
    const market = makeMarket({ delisting_date: '2025-06-15 00:00:00' })
    expect(isListedOnDate(market, '2025-06-15')).toBe(true)
  })

  it('returns true when date is between listing and delisting', () => {
    const market = makeMarket({
      listing_date: '2025-01-01 00:00:00',
      delisting_date: '2025-12-31 00:00:00',
    })
    expect(isListedOnDate(market, '2025-06-15')).toBe(true)
  })

  it('handles ISO format listing dates', () => {
    const market = makeMarket({ listing_date: '2025-06-20T00:00:00Z' })
    expect(isListedOnDate(market, '2025-06-15')).toBe(false)
  })
})

describe('parseConfig', () => {
  const configEnvKeys = [
    'MODE',
    'FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START',
    'FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END',
    'FUNDING_DOWNLOAD_TASKS_THRESHOLD',
    'FUNDING_DOWNLOAD_TASKS_DRY_RUN',
    'FUNDING_DOWNLOAD_TASKS_EXCLUDED_EXCHANGES',
  ] as const

  function withEnv(vars: Record<string, string>, fn: () => void): void {
    const saved = new Map<string, string | undefined>()
    for (const key of configEnvKeys) {
      saved.set(key, process.env[key])
      Reflect.deleteProperty(process.env, key)
    }
    for (const [key, value] of Object.entries(vars)) {
      process.env[key] = value
    }
    try {
      fn()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key)
        } else {
          process.env[key] = value
        }
      }
    }
  }

  it('parses analyze mode config', () => {
    withEnv(
      {
        MODE: 'analyze',
        FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START: '2025-01-01',
        FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END: '2025-12-31',
      },
      () => {
        const config = parseConfig()
        expect(config.mode).toBe('analyze')
        expect(config.dateRangeStart).toBe('2025-01-01')
        expect(config.dateRangeEnd).toBe('2025-12-31')
        expect(config.fundingThreshold).toBeNull()
        expect(config.excludedExchanges).toEqual(['mexc'])
        expect(config.dryRun).toBe(false)
      }
    )
  })

  it('parses create mode config with threshold', () => {
    withEnv(
      {
        MODE: 'create',
        FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START: '2025-01-01',
        FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END: '2025-06-30',
        FUNDING_DOWNLOAD_TASKS_THRESHOLD: '-0.005',
        FUNDING_DOWNLOAD_TASKS_DRY_RUN: 'true',
        FUNDING_DOWNLOAD_TASKS_EXCLUDED_EXCHANGES: 'mexc,gateio',
      },
      () => {
        const config = parseConfig()
        expect(config.mode).toBe('create')
        expect(config.fundingThreshold).toBe(-0.005)
        expect(config.dryRun).toBe(true)
        expect(config.excludedExchanges).toEqual(['mexc', 'gateio'])
      }
    )
  })

  it('throws when FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START is missing', () => {
    withEnv(
      {
        MODE: 'analyze',
        FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END: '2025-12-31',
      },
      () => {
        Reflect.deleteProperty(process.env, 'FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START')
        expect(() => parseConfig()).toThrow('FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START')
      }
    )
  })

  it('throws when FUNDING_DOWNLOAD_TASKS_THRESHOLD is missing in create mode', () => {
    withEnv(
      {
        MODE: 'create',
        FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START: '2025-01-01',
        FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END: '2025-12-31',
      },
      () => {
        Reflect.deleteProperty(process.env, 'FUNDING_DOWNLOAD_TASKS_THRESHOLD')
        expect(() => parseConfig()).toThrow('FUNDING_DOWNLOAD_TASKS_THRESHOLD')
      }
    )
  })

  it('defaults mode to create', () => {
    withEnv(
      {
        FUNDING_DOWNLOAD_TASKS_DATE_RANGE_START: '2025-01-01',
        FUNDING_DOWNLOAD_TASKS_DATE_RANGE_END: '2025-12-31',
        FUNDING_DOWNLOAD_TASKS_THRESHOLD: '-0.005',
      },
      () => {
        Reflect.deleteProperty(process.env, 'MODE')
        const config = parseConfig()
        expect(config.mode).toBe('create')
      }
    )
  })
})
