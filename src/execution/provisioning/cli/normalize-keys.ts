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
    console.error('Usage: provision:normalize-keys --exchange <name> [--registry <path>]')
    process.exit(1)
  }

  const registry = loadRegistry(registryPath)
  const entries = registry.combinations.filter(entry => entry.exchange === exchange)
  let changed = 0
  let failed = 0

  for (const entry of entries) {
    const adapter = buildAdapter(exchange, entry.sub_account_label)
    entry.ip_allow_list = [...REQUIRED_IP_ALLOW_LIST]

    try {
      if (!entry.api_key || !entry.api_secret) {
        console.log(`${exchange} ${entry.sub_account_id}: creating API key`)
        const key = await adapter.createApiKey(entry.sub_account_id, entry.ip_allow_list)
        entry.api_key = key.apiKey
        entry.api_secret = key.apiSecret
        entry.api_passphrase = key.apiPassphrase ?? entry.api_passphrase
        changed++
      }

      if (adapter.ensureApiKeyPermissions && entry.api_key) {
        console.log(`${exchange} ${entry.sub_account_id}: ensuring API key permissions`)
        await adapter.ensureApiKeyPermissions(
          entry.sub_account_id,
          entry.api_key,
          entry.api_passphrase,
          entry.ip_allow_list
        )
        changed++
      } else {
        console.log(`${exchange} ${entry.sub_account_id}: no permission-normalizer available`)
      }

      if (entry.status === 'failed' && entry.api_key && entry.api_secret && entry.allocated_capital_usdt > 0) {
        entry.status = 'active'
        entry.notes = ''
      }
    } catch (err) {
      failed++
      entry.status = entry.status === 'idle' ? 'idle' : 'failed'
      entry.notes = err instanceof Error ? err.message : String(err)
      console.warn(`${exchange} ${entry.sub_account_id}: ${entry.notes}`)
    }
  }

  saveRegistry(registryPath, registry)
  console.log(`Normalize complete for ${exchange}: changed ${String(changed)}, failed ${String(failed)}`)
  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
