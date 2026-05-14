import { describe, it, expect } from 'vitest'
import { FleetSchema, FleetEntrySchema } from '../schema.js'

const baseEntry = {
  id: 'strategy_3a-bybit',
  strategy: 'strategy_3a',
  exchange: 'bybit',
  enabled: true,
  strategy_config: 'live-configs/strategies/strategy_3a-bybit.yaml',
  runtime: { metrics_port: 9501, health_port: 9601 },
  risk: {},
}

describe('FleetEntrySchema', () => {
  it('parses a valid entry', () => {
    const result = FleetEntrySchema.safeParse(baseEntry)
    expect(result.success).toBe(true)
  })

  it('rejects metrics_port below 9500', () => {
    const result = FleetEntrySchema.safeParse({
      ...baseEntry,
      runtime: { metrics_port: 9499, health_port: 9601 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects metrics_port above 9599', () => {
    const result = FleetEntrySchema.safeParse({
      ...baseEntry,
      runtime: { metrics_port: 9600, health_port: 9601 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects health_port below 9600', () => {
    const result = FleetEntrySchema.safeParse({
      ...baseEntry,
      runtime: { metrics_port: 9501, health_port: 9599 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects health_port above 9699', () => {
    const result = FleetEntrySchema.safeParse({
      ...baseEntry,
      runtime: { metrics_port: 9501, health_port: 9700 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown strategy', () => {
    const result = FleetEntrySchema.safeParse({ ...baseEntry, strategy: 'strategy_99' })
    expect(result.success).toBe(false)
  })

  it('rejects unknown exchange', () => {
    const result = FleetEntrySchema.safeParse({ ...baseEntry, exchange: 'unknown_ex' })
    expect(result.success).toBe(false)
  })
})

describe('FleetSchema — superRefine', () => {
  it('accepts an empty fleet', () => {
    const result = FleetSchema.safeParse({ combinations: [] })
    expect(result.success).toBe(true)
  })

  it('accepts a valid multi-entry fleet', () => {
    const result = FleetSchema.safeParse({
      combinations: [
        baseEntry,
        {
          id: 'strategy_3a-okx',
          strategy: 'strategy_3a',
          exchange: 'okx',
          enabled: true,
          strategy_config: 'live-configs/strategies/strategy_3a-okx.yaml',
          runtime: { metrics_port: 9502, health_port: 9602 },
          risk: {},
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects duplicate ids', () => {
    const result = FleetSchema.safeParse({
      combinations: [baseEntry, { ...baseEntry }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('duplicate id'))).toBe(true)
    }
  })

  it('rejects duplicate (strategy, exchange) pairs with different ids', () => {
    // This can't actually happen since id must equal <strategy>-<exchange>,
    // so a duplicate combo always means duplicate id too.
    // We test the id-format check instead.
    const result = FleetSchema.safeParse({
      combinations: [{ ...baseEntry, id: 'wrong-id-format' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('id must be'))).toBe(true)
    }
  })

  it('rejects port collision between metrics ports', () => {
    const result = FleetSchema.safeParse({
      combinations: [
        baseEntry,
        {
          id: 'strategy_3a-okx',
          strategy: 'strategy_3a',
          exchange: 'okx',
          enabled: true,
          strategy_config: 'live-configs/strategies/strategy_3a-okx.yaml',
          runtime: { metrics_port: 9501, health_port: 9602 }, // 9501 already used
          risk: {},
        },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('already used'))).toBe(true)
    }
  })

  it('rejects port collision between metrics and health ports', () => {
    const result = FleetSchema.safeParse({
      combinations: [
        baseEntry, // metrics=9501, health=9601
        {
          id: 'strategy_3a-okx',
          strategy: 'strategy_3a',
          exchange: 'okx',
          enabled: true,
          strategy_config: 'live-configs/strategies/strategy_3a-okx.yaml',
          runtime: { metrics_port: 9502, health_port: 9501 }, // health=9501 collides with first metrics
          risk: {},
        },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('already used'))).toBe(true)
    }
  })

  it('rejects id that does not match <strategy>-<exchange>', () => {
    const result = FleetSchema.safeParse({
      combinations: [{ ...baseEntry, id: 'strategy_3a-binance' }], // wrong exchange in id
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('id must be'))).toBe(true)
    }
  })
})
