import '../../../config/env.js'

import { buildAdapter } from '../exchanges/factory.js'
import { loadRegistry, saveRegistry } from '../registry/loader.js'
import type { RegistryEntry } from '../registry/schema.js'

const EXCHANGES: Array<RegistryEntry['exchange']> = ['binance', 'bybit', 'okx', 'gateio', 'kucoin', 'bitget']
const registryPath = process.argv[2] ?? 'live-configs/registry.yaml'

async function main() {
  const registry = loadRegistry(registryPath)
  let totalUpdated = 0

  for (const exchange of EXCHANGES) {
    try {
      const adapter = buildAdapter(exchange, `refresh-labels-${exchange}`)
      const discovered = await adapter.listSubAccounts()
      const labelMap = new Map(discovered.map(s => [s.subAccountId, s.label]))

      let updated = 0
      for (const entry of registry.combinations) {
        if (entry.exchange !== exchange) continue
        const label = labelMap.get(entry.sub_account_id)
        if (label && label !== entry.sub_account_label) {
          console.log(`${exchange} ${entry.sub_account_id}: "${entry.sub_account_label}" → "${label}"`)
          entry.sub_account_label = label
          updated++
        }
      }
      console.log(`${exchange}: ${String(updated)} labels updated (${String(discovered.length)} sub-accounts fetched)`)
      totalUpdated += updated
    } catch (err) {
      console.error(`${exchange}: FAILED — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  saveRegistry(registryPath, registry)
  console.log(`\nDone. Total labels updated: ${String(totalUpdated)}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
