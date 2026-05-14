import { loadFleet } from '../loader.js'
import { loadRegistry } from '../../provisioning/registry/loader.js'
import { validateFleet } from '../validate.js'

const args = process.argv.slice(2)
const fleetPath = args[args.indexOf('--fleet') + 1] ?? 'live-configs/fleet.yaml'
const registryPath = args[args.indexOf('--registry') + 1] ?? 'live-configs/registry.yaml'

try {
  const registry = loadRegistry(registryPath)
  const fleet = loadFleet(fleetPath, { registry })
  const result = validateFleet(fleet, registry)

  const total = fleet.combinations.length
  const enabled = fleet.combinations.filter(e => e.enabled).length

  if (result.warnings.length > 0) {
    for (const w of result.warnings) console.warn(`  warning: ${w}`)
  }

  if (result.valid) {
    console.log(`Fleet is valid (${total.toString()} combinations, ${enabled.toString()} enabled)`)
    process.exit(0)
  } else {
    console.error(
      `Fleet validation failed (${result.errors.length.toString()} error${result.errors.length !== 1 ? 's' : ''})`
    )
    for (const err of result.errors) console.error(`  ${err}`)
    process.exit(1)
  }
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
