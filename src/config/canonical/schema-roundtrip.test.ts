import { describe, it, expect } from 'vitest'

import type { StrategyId } from '../../execution/strategies/types.js'
import { GeneratedBacktestStrategySchema } from './generate-backtest.js'
import { GeneratedLiveStrategySchema } from './generate-live.js'
import type { CanonicalParam } from './params.js'
import { CANONICAL_PARAMS, defaultFor, boundsFor } from './params.js'
import { STRATEGY_DEFS, ALL_STRATEGY_IDS } from './strategies.js'

// Structural fields the registry doesn't model (no canonical param row): required-with-no-
// default extras on specific strategies' btExtra/liveExtra shapes.
const STRUCTURAL_EXTRAS: Partial<Record<StrategyId, { bt?: Record<string, unknown>; live?: Record<string, unknown> }>> = {
  strategy_1: { bt: { funding_applied_on_same_second: false } },
  strategy_2: { bt: { funding_applied_on_same_second: false } },
  strategy_3a: { bt: { tp_mode: 'A', funding_applied_on_same_second: true } },
  strategy_4_1a: { bt: { funding_applied_on_same_second: false } },
  strategy_4_2a: { bt: { funding_applied_on_same_second: false } },
  strategy_6: { live: { mainSide: 'long' } },
}

// Fallback values for the 2 required-with-no-default canonical params (main_amount_usd,
// and strategy_6's leverage) — everything else is covered by defaultFor().
const REQUIRED_FIXTURE: Record<string, number> = { main_amount_usd: 20, mainAmountUsd: 20, leverage: 4 }

const paramsByName = new Map(CANONICAL_PARAMS.map(p => [p.name, p]))

/** Walks STRATEGY_DEFS[strategyId].params independently of the generators, so a generator
 * hand-edit that desyncs from the registry is still caught by the drift trip-wire below. */
function buildBaseline(strategyId: StrategyId, side: 'bt' | 'live'): Record<string, unknown> {
  const def = STRATEGY_DEFS[strategyId]
  const obj: Record<string, unknown> = side === 'bt' ? { strategy_id: strategyId } : { id: strategyId }

  for (const paramName of def.params) {
    const param = paramsByName.get(paramName)
    if (!param) throw new Error(`Unknown canonical param '${paramName}' referenced by ${strategyId}`)
    const key = side === 'bt' ? param.btKey : param.liveKey
    if (!key) continue
    const value = defaultFor(param, strategyId) ?? REQUIRED_FIXTURE[key]
    if (value === undefined) throw new Error(`No fixture value for '${key}' (${strategyId}/${side})`)
    obj[key] = value
  }

  Object.assign(obj, STRUCTURAL_EXTRAS[strategyId]?.[side] ?? {})
  return obj
}

interface BoundsCase {
  label: string
  value: number
  expectAccept: boolean
}

/** Value cases driven purely by the registry's own default/bounds data for this param+strategy. */
function casesFor(param: CanonicalParam, strategyId: StrategyId): BoundsCase[] {
  const def = defaultFor(param, strategyId)
  const bounds = boundsFor(param, strategyId)
  const epsilon = param.unit === 'integer' ? 1 : 0.001
  const cases: BoundsCase[] = []

  if (def !== undefined) cases.push({ label: 'default', value: def, expectAccept: true })

  if (bounds?.min !== undefined) {
    cases.push({ label: 'min-boundary', value: bounds.min, expectAccept: !bounds.exclusiveMin })
    if (bounds.exclusiveMin) cases.push({ label: 'min-just-past', value: bounds.min + epsilon, expectAccept: true })
    cases.push({ label: 'min-just-outside', value: bounds.min - epsilon, expectAccept: false })
  }
  if (bounds?.max !== undefined) {
    cases.push({ label: 'max-boundary', value: bounds.max, expectAccept: !bounds.exclusiveMax })
    if (bounds.exclusiveMax) cases.push({ label: 'max-just-past', value: bounds.max - epsilon, expectAccept: true })
    cases.push({ label: 'max-just-outside', value: bounds.max + epsilon, expectAccept: false })
  }
  if (bounds?.min !== undefined && bounds.max !== undefined) {
    cases.push({ label: 'mid', value: (bounds.min + bounds.max) / 2, expectAccept: true })
  }

  return cases
}

describe('schema round-trip — registry-derived (data-driven, no hand-listed param names)', () => {
  for (const strategyId of ALL_STRATEGY_IDS) {
    const def = STRATEGY_DEFS[strategyId]

    describe(strategyId, () => {
      for (const paramName of def.params) {
        const param = paramsByName.get(paramName)
        if (!param) throw new Error(`Unknown canonical param '${paramName}' referenced by ${strategyId}`)

        const btApplicable = def.hasBacktest && !!param.btKey
        const liveApplicable = !!param.liveKey
        if (!btApplicable && !liveApplicable) continue

        for (const c of casesFor(param, strategyId)) {
          it(`${param.name} / ${c.label} (${String(c.value)}) — expectAccept=${String(c.expectAccept)}`, () => {
            if (c.expectAccept) {
              let btParsed: Record<string, unknown> | undefined
              let liveParsed: Record<string, unknown> | undefined

              if (btApplicable) {
                const input = { ...buildBaseline(strategyId, 'bt'), [param.btKey!]: c.value }
                const result = GeneratedBacktestStrategySchema.safeParse(input)
                expect(result.success).toBe(true)
                if (result.success) btParsed = result.data as Record<string, unknown>
              }
              if (liveApplicable) {
                const input = { ...buildBaseline(strategyId, 'live'), [param.liveKey!]: c.value }
                const result = GeneratedLiveStrategySchema.safeParse(input)
                expect(result.success).toBe(true)
                if (result.success) liveParsed = result.data as Record<string, unknown>
              }
              // Numeric identity: the actual round-trip assertion.
              if (btParsed && liveParsed) {
                expect(btParsed[param.btKey!]).toBe(liveParsed[param.liveKey!])
              }
            } else {
              if (btApplicable) {
                const input = { ...buildBaseline(strategyId, 'bt'), [param.btKey!]: c.value }
                expect(GeneratedBacktestStrategySchema.safeParse(input).success).toBe(false)
              }
              if (liveApplicable) {
                const input = { ...buildBaseline(strategyId, 'live'), [param.liveKey!]: c.value }
                expect(GeneratedLiveStrategySchema.safeParse(input).success).toBe(false)
              }
            }
          })
        }
      }
    })
  }
})

describe('schema round-trip — drift trip-wire (generated keys must match registry)', () => {
  for (const strategyId of ALL_STRATEGY_IDS) {
    const def = STRATEGY_DEFS[strategyId]

    if (def.hasBacktest) {
      it(`${strategyId}: bt generated keys match registry`, () => {
        const baseline = buildBaseline(strategyId, 'bt')
        const parsed = GeneratedBacktestStrategySchema.parse(baseline) as Record<string, unknown>

        const expectedKeys = [
          'strategy_id',
          ...def.params.map(name => paramsByName.get(name)?.btKey).filter((k): k is string => !!k),
          ...Object.keys(def.btExtra ?? {}),
        ]
        expect(Object.keys(parsed).sort()).toEqual(expectedKeys.sort())
      })
    }

    it(`${strategyId}: live generated keys match registry`, () => {
      const baseline = buildBaseline(strategyId, 'live')
      const parsed = GeneratedLiveStrategySchema.parse(baseline) as Record<string, unknown>

      const expectedKeys = [
        'id',
        'enabled',
        ...def.params.map(name => paramsByName.get(name)?.liveKey).filter((k): k is string => !!k),
        ...Object.keys(def.liveExtra ?? {}),
      ]
      expect(Object.keys(parsed).sort()).toEqual(expectedKeys.sort())
    })
  }
})
