import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

import { RegistrySchema, type Registry } from './schema.js'

const EXCHANGE_ORDER = ['binance', 'bybit', 'okx', 'gateio', 'kucoin', 'bitget', 'mexc'] as const
const STATUS_ORDER = ['active', 'provisioning', 'failed', 'idle'] as const

function orderIndex(values: readonly string[], value: string): number {
  const index = values.indexOf(value)
  return index === -1 ? values.length : index
}

function strategyOrder(strategy: string | null): string {
  return strategy ?? 'zzzz'
}

function sortRegistry(registry: Registry): Registry {
  return {
    combinations: [...registry.combinations].sort((a, b) => {
      const byExchange = orderIndex(EXCHANGE_ORDER, a.exchange) - orderIndex(EXCHANGE_ORDER, b.exchange)
      if (byExchange !== 0) return byExchange

      const byStatus = orderIndex(STATUS_ORDER, a.status) - orderIndex(STATUS_ORDER, b.status)
      if (byStatus !== 0) return byStatus

      const byStrategy = strategyOrder(a.assigned_strategy).localeCompare(strategyOrder(b.assigned_strategy))
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
  const yaml = YAML.stringify(normalized, { lineWidth: 0 })
  writeFileSync(tmpPath, yaml, 'utf8')
  renameSync(tmpPath, resolvedPath)
}
