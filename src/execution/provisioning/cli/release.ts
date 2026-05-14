import '../../../config/env.js'

import { buildAdapter } from '../exchanges/factory.js'
import { reconcileCapital } from '../exchanges/reconcile.js'
import { loadRegistry, saveRegistry } from '../registry/loader.js'
import type { RegistryEntry } from '../registry/schema.js'

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2)
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}

async function main() {
  const strategy = getArg('--strategy')
  const exchange = getArg('--exchange') as RegistryEntry['exchange'] | undefined
  const registryPath = getArg('--registry') ?? 'live-configs/registry.yaml'

  if (!strategy || !exchange) {
    console.error('Usage: provision:release --strategy <id> --exchange <name> [--registry <path>]')
    process.exit(1)
  }

  const registry = loadRegistry(registryPath)
  const index = registry.combinations.findIndex(
    entry => entry.exchange === exchange && entry.assigned_strategy === strategy
  )
  if (index === -1) {
    console.error(`No assigned registry entry found for (${strategy}, ${exchange})`)
    process.exit(1)
  }

  const entry = registry.combinations[index]
  if (!entry) {
    console.error(`No assigned registry entry found for (${strategy}, ${exchange})`)
    process.exit(1)
  }
  const adapter = buildAdapter(exchange, entry.sub_account_label)
  console.log(`Releasing (${strategy}, ${exchange}) sub_account_id=${entry.sub_account_id}`)
  const options = exchange === 'kucoin' ? { assumedCurrentBalance: entry.allocated_capital_usdt } : {}
  const result = await reconcileCapital(adapter, entry.sub_account_id, 0, options)
  if (result.direction === 'none') {
    console.log(`No drain needed (${result.before.toFixed(2)} USDT)`)
  } else {
    console.log(`Drained ${result.transferred.toFixed(2)} USDT to master`)
  }

  entry.status = 'idle'
  entry.assigned_strategy = null
  entry.allocated_capital_usdt = 0
  entry.last_assigned_at = new Date().toISOString()
  entry.notes = ''
  registry.combinations[index] = entry
  saveRegistry(registryPath, registry)
  console.log(`Released to idle pool in ${registryPath}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
