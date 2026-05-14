import { copyFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

import { saveRegistry } from './loader.js'
import { RegistrySchema, type RegistryEntry } from './schema.js'

const registryPath = process.argv[2] ?? 'live-configs/registry.yaml'
const resolved = resolve(registryPath)
const backup = `${resolved}.bak`

const source = readFileSync(resolved, 'utf8')
copyFileSync(resolved, backup)

const raw = (YAML.parse(source) ?? {}) as { combinations?: Record<string, unknown>[] }
const migrated = (raw.combinations ?? [])
  .filter(entry => entry.status !== 'retired')
  .map(entry => {
    const status = entry.status === 'active' ? 'active' : entry.status === 'failed' ? 'failed' : 'idle'
    const assignedStrategy =
      typeof entry.assigned_strategy === 'string'
        ? entry.assigned_strategy
        : typeof entry.strategy === 'string'
          ? entry.strategy
          : null
    const isIdle = status === 'idle'
    const exchange = String(entry.exchange)
    const provisioningMode =
      exchange === 'binance' || exchange === 'okx' || exchange === 'gateio'
        ? 'full_api'
        : (entry.provisioning_mode ?? 'full_api')

    return {
      exchange: entry.exchange,
      sub_account_id: entry.sub_account_id,
      sub_account_label: entry.sub_account_label,
      assigned_strategy: isIdle ? null : assignedStrategy,
      api_key: entry.api_key ?? '',
      api_secret: entry.api_secret ?? '',
      api_passphrase: entry.api_passphrase ?? null,
      ip_allow_list: entry.ip_allow_list,
      allocated_capital_usdt: isIdle ? 0 : entry.allocated_capital_usdt,
      provisioning_mode: provisioningMode,
      status,
      created_at: entry.created_at,
      last_assigned_at:
        entry.last_assigned_at ?? (status === 'active' || status === 'failed' ? (entry.created_at ?? null) : null),
      notes: entry.notes ?? '',
    } satisfies Record<keyof RegistryEntry, unknown>
  })

const registry = RegistrySchema.parse({ combinations: migrated })
saveRegistry(registryPath, registry)
console.log(`Migrated ${String(registry.combinations.length)} entries; backup written to ${backup}`)
