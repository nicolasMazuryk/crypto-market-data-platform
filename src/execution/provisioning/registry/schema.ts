import { z } from 'zod'

export const REQUIRED_IP_ALLOW_LIST = ['203.0.113.10', '203.0.113.12'] as const

// okx and kucoin always require a passphrase; bitget is optional (depends on account setup)
const PASSPHRASE_REQUIRED_EXCHANGES = new Set(['okx', 'kucoin'])

const ExchangeNameEnum = z.enum(['binance', 'bybit', 'okx', 'mexc', 'bitget', 'gateio', 'kucoin'])

export const RegistryEntrySchema = z
  .object({
    exchange: ExchangeNameEnum,
    sub_account_id: z.string().min(1),
    sub_account_label: z.string().min(1),
    assigned_strategy: z.string().min(1).nullable(),
    api_key: z.string(),
    api_secret: z.string(),
    api_passphrase: z.string().nullable().default(null),
    ip_allow_list: z.array(z.string()),
    allocated_capital_usdt: z.number().min(0),
    provisioning_mode: z.enum(['full_api', 'manual_register']),
    status: z.enum(['idle', 'active', 'failed', 'provisioning']),
    created_at: z.string().min(1),
    last_assigned_at: z.string().min(1).nullable(),
    notes: z.string().default(''),
  })
  .superRefine((entry, ctx) => {
    const sorted = [...entry.ip_allow_list].sort()
    const required = [...REQUIRED_IP_ALLOW_LIST].sort()
    if (JSON.stringify(sorted) !== JSON.stringify(required)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ip_allow_list'],
        message: `must be exactly ${JSON.stringify(REQUIRED_IP_ALLOW_LIST)}`,
      })
    }

    if (entry.status === 'active') {
      if (entry.assigned_strategy === null) {
        ctx.addIssue({ code: 'custom', path: ['assigned_strategy'], message: 'required for active entries' })
      }
      if (!entry.api_key) {
        ctx.addIssue({ code: 'custom', path: ['api_key'], message: 'required for active entries' })
      }
      if (!entry.api_secret) {
        ctx.addIssue({ code: 'custom', path: ['api_secret'], message: 'required for active entries' })
      }
      if (PASSPHRASE_REQUIRED_EXCHANGES.has(entry.exchange) && !entry.api_passphrase) {
        ctx.addIssue({
          code: 'custom',
          path: ['api_passphrase'],
          message: `required for exchange ${entry.exchange}`,
        })
      }
    }

    if (entry.status === 'idle') {
      if (entry.assigned_strategy !== null) {
        ctx.addIssue({ code: 'custom', path: ['assigned_strategy'], message: 'must be null for idle entries' })
      }
      if (entry.allocated_capital_usdt !== 0) {
        ctx.addIssue({ code: 'custom', path: ['allocated_capital_usdt'], message: 'must be 0 for idle entries' })
      }
    }
  })

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>

export const RegistrySchema = z
  .object({
    combinations: z.preprocess(value => value ?? [], z.array(RegistryEntrySchema).default([])),
  })
  .superRefine((registry, ctx) => {
    const seenSubAccounts = new Set<string>()
    const seenAssignments = new Set<string>()
    for (let i = 0; i < registry.combinations.length; i++) {
      const combo = registry.combinations[i]
      if (!combo) continue
      const subAccountKey = `${combo.exchange}:${combo.sub_account_id}`
      if (seenSubAccounts.has(subAccountKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['combinations', i],
          message: `duplicate (exchange, sub_account_id) combination: ${subAccountKey}`,
        })
      }
      seenSubAccounts.add(subAccountKey)

      if (combo.assigned_strategy !== null) {
        const assignmentKey = `${combo.exchange}:${combo.assigned_strategy}`
        if (seenAssignments.has(assignmentKey)) {
          ctx.addIssue({
            code: 'custom',
            path: ['combinations', i],
            message: `duplicate (exchange, assigned_strategy) combination: ${assignmentKey}`,
          })
        }
        seenAssignments.add(assignmentKey)
      }
    }
  })

export type Registry = z.infer<typeof RegistrySchema>
