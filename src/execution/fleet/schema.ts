import { z } from 'zod'

const ExchangeNameEnum = z.enum(['binance', 'bybit', 'okx', 'mexc', 'bitget', 'gateio', 'kucoin'])
const StrategyNameEnum = z.enum([
  'strategy_1',
  'strategy_1_ws',
  'strategy_2',
  'strategy_3a',
  'strategy_3b',
  'strategy_4_1a',
  'strategy_4_2a',
  'strategy_4_3a',
  'strategy_6',
])

export const METRICS_PORT_RANGE = { min: 9500, max: 9599 } as const
export const HEALTH_PORT_RANGE = { min: 9600, max: 9699 } as const

const FleetRuntimeSchema = z.object({
  metrics_port: z.number().int().min(METRICS_PORT_RANGE.min).max(METRICS_PORT_RANGE.max),
  health_port: z.number().int().min(HEALTH_PORT_RANGE.min).max(HEALTH_PORT_RANGE.max),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

const FleetRiskSchema = z.object({
  maxConcurrentIntents: z.number().int().positive().optional(),
  maxNotionalUsd: z.number().positive().optional(),
})

export const FleetEntrySchema = z.object({
  id: z.string().min(1),
  strategy: StrategyNameEnum,
  exchange: ExchangeNameEnum,
  enabled: z.boolean().default(true),
  strategy_config: z.string().min(1),
  runtime: FleetRuntimeSchema,
  risk: FleetRiskSchema.default({}),
})

export type FleetEntry = z.infer<typeof FleetEntrySchema>

export const FleetSchema = z
  .object({
    combinations: z.array(FleetEntrySchema).default([]),
  })
  .superRefine((fleet, ctx) => {
    const seenIds = new Set<string>()
    const seenCombos = new Set<string>()
    const seenPorts = new Map<number, string>()

    for (let i = 0; i < fleet.combinations.length; i++) {
      const entry = fleet.combinations[i]
      if (!entry) continue

      if (seenIds.has(entry.id)) {
        ctx.addIssue({ code: 'custom', path: ['combinations', i, 'id'], message: `duplicate id: ${entry.id}` })
      }
      seenIds.add(entry.id)

      const comboKey = `${entry.strategy}:${entry.exchange}`
      if (seenCombos.has(comboKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['combinations', i],
          message: `duplicate (strategy, exchange): ${comboKey}`,
        })
      }
      seenCombos.add(comboKey)

      const expectedId = `${entry.strategy}-${entry.exchange}`
      if (entry.id !== expectedId) {
        ctx.addIssue({
          code: 'custom',
          path: ['combinations', i, 'id'],
          message: `id must be "${expectedId}" (got "${entry.id}")`,
        })
      }

      for (const [port, label] of [
        [entry.runtime.metrics_port, 'runtime.metrics_port'],
        [entry.runtime.health_port, 'runtime.health_port'],
      ] as [number, string][]) {
        const collision = seenPorts.get(port)
        if (collision) {
          ctx.addIssue({
            code: 'custom',
            path: ['combinations', i, label],
            message: `port ${port.toString()} already used by ${collision}`,
          })
        }
        seenPorts.set(port, `${entry.id}.${label}`)
      }
    }
  })

export type Fleet = z.infer<typeof FleetSchema>
