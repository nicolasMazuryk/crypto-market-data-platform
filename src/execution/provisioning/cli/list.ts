import { loadRegistry } from '../registry/loader.js'

const registryPath = process.argv[2] ?? 'live-configs/registry.yaml'

try {
  const registry = loadRegistry(registryPath)
  const exchanges = [...new Set(registry.combinations.map(entry => entry.exchange))].sort()

  for (const exchange of exchanges) {
    const entries = registry.combinations.filter(entry => entry.exchange === exchange)
    const active = entries.filter(entry => entry.status === 'active')
    const idle = entries.filter(entry => entry.status === 'idle')
    const other = entries.filter(entry => entry.status !== 'active' && entry.status !== 'idle')

    console.log(exchange)
    for (const entry of active) {
      console.log(
        `  active  ${entry.sub_account_id}  ${entry.assigned_strategy ?? '-'}  ${entry.allocated_capital_usdt.toFixed(2)} USDT  ${entry.sub_account_label}`
      )
    }
    for (const entry of idle) {
      const last = entry.last_assigned_at ?? 'never'
      console.log(`  idle    ${entry.sub_account_id}  last_assigned=${last}  ${entry.sub_account_label}`)
    }
    for (const entry of other) {
      console.log(
        `  ${entry.status.padEnd(7)} ${entry.sub_account_id}  ${entry.assigned_strategy ?? '-'}  ${entry.notes}`
      )
    }
  }

  if (exchanges.length === 0) console.log('Registry is empty')
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
