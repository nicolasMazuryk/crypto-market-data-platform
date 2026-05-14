import '../../../config/env.js'

import { buildAdapter } from '../exchanges/factory.js'
import { loadRegistry, saveRegistry } from '../registry/loader.js'
import { REQUIRED_IP_ALLOW_LIST, type RegistryEntry } from '../registry/schema.js'

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2)
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}

async function main() {
  const exchange = getArg('--exchange') as RegistryEntry['exchange'] | undefined
  const registryPath = getArg('--registry') ?? 'live-configs/registry.yaml'
  if (!exchange) {
    console.error('Usage: provision:sync --exchange <name> [--registry <path>]')
    process.exit(1)
  }

  const registry = loadRegistry(registryPath)
  const adapter = buildAdapter(exchange, `sync-${exchange}`)
  const discovered = await adapter.listSubAccounts()
  const known = new Set(
    registry.combinations.filter(entry => entry.exchange === exchange).map(entry => entry.sub_account_id)
  )
  const discoveredIds = new Set(discovered.map(sub => sub.subAccountId))
  const now = new Date().toISOString()

  let added = 0
  let updated = 0
  for (const sub of discovered) {
    if (known.has(sub.subAccountId)) {
      const entry = registry.combinations.find(
        item => item.exchange === exchange && item.sub_account_id === sub.subAccountId
      )
      if (entry?.status === 'idle' && sub.label && entry.sub_account_label !== sub.label) {
        entry.sub_account_label = sub.label
        updated++
      }
      continue
    }
    registry.combinations.push({
      exchange,
      sub_account_id: sub.subAccountId,
      sub_account_label: sub.label,
      assigned_strategy: null,
      api_key: '',
      api_secret: '',
      api_passphrase: null,
      ip_allow_list: [...REQUIRED_IP_ALLOW_LIST],
      allocated_capital_usdt: 0,
      provisioning_mode: adapter.mode,
      status: 'idle',
      created_at: now,
      last_assigned_at: null,
      notes: 'added by provision:sync; API keys unknown',
    })
    added++
  }

  const missing = registry.combinations.filter(
    entry => entry.exchange === exchange && !discoveredIds.has(entry.sub_account_id)
  )
  for (const entry of missing) {
    console.warn(`Registry entry not found on ${exchange}: ${entry.sub_account_id} (${entry.sub_account_label})`)
  }

  saveRegistry(registryPath, registry)
  console.log(`Sync complete: added ${String(added)}, updated ${String(updated)}, missing ${String(missing.length)}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
