import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

import { RegistrySchema, type Registry, type RegistryEntry } from './schema.js'

const EXCHANGE_ORDER = ['binance', 'bybit', 'okx', 'gateio', 'kucoin', 'bitget', 'mexc'] as const
const STRATEGY_ORDER = ['strategy_1', 'strategy_1_ws', 'strategy_2', 'strategy_4_1a', 'strategy_6'] as const

const FIELD_ORDER: Array<keyof RegistryEntry> = [
  'exchange',
  'assigned_strategy',
  'allocated_capital_usdt',
  'status',
  'sub_account_id',
  'sub_account_label',
  'api_key',
  'api_secret',
  'api_passphrase',
  'ip_allow_list',
  'provisioning_mode',
  'created_at',
  'last_assigned_at',
  'notes',
]

function reorderFields(entry: RegistryEntry): RegistryEntry {
  const result: Record<string, unknown> = {}
  for (const key of FIELD_ORDER) {
    result[key] = entry[key]
  }
  return result as RegistryEntry
}

function orderIndex(values: readonly string[], value: string): number {
  const index = values.indexOf(value)
  return index === -1 ? values.length : index
}

function sortRegistry(registry: Registry): Registry {
  return {
    combinations: [...registry.combinations].sort((a, b) => {
      const byExchange = orderIndex(EXCHANGE_ORDER, a.exchange) - orderIndex(EXCHANGE_ORDER, b.exchange)
      if (byExchange !== 0) return byExchange

      const byStrategy = orderIndex(STRATEGY_ORDER, a.assigned_strategy ?? '') - orderIndex(STRATEGY_ORDER, b.assigned_strategy ?? '')
      if (byStrategy !== 0) return byStrategy

      return a.sub_account_id.localeCompare(b.sub_account_id)
    }),
  }
}

export function loadRegistry(path: string): Registry {
  const source = readFileSync(resolve(path), 'utf8')
  const raw = (YAML.parse(source) ?? {}) as Record<string, unknown>
  return RegistrySchema.parse(raw)
}

export function saveRegistry(path: string, registry: Registry): void {
  const resolvedPath = resolve(path)
  const tmpPath = `${resolvedPath}.tmp`
  const normalized = sortRegistry(RegistrySchema.parse(registry))
  const ordered = { combinations: normalized.combinations.map(reorderFields) }
  const yaml = YAML.stringify(ordered, { lineWidth: 0 })
  writeFileSync(tmpPath, yaml, 'utf8')
  renameSync(tmpPath, resolvedPath)
}
