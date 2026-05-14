import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadFleet } from '../loader.js'
import { loadRegistry } from '../../provisioning/registry/loader.js'
import { generateInstanceConfig } from '../generate-instance-config.js'

const args = process.argv.slice(2)
const fleetPath = args[args.indexOf('--fleet') + 1] ?? 'live-configs/fleet.yaml'
const registryPath = args[args.indexOf('--registry') + 1] ?? 'live-configs/registry.yaml'
const outDir = args[args.indexOf('--out-dir') + 1] ?? 'config'
const basePath = args[args.indexOf('--base') + 1] ?? 'config/execution.base.yaml'
const dryRun = args.includes('--dry-run')

try {
  const registry = loadRegistry(registryPath)
  const fleet = loadFleet(fleetPath, { registry })

  if (!dryRun) mkdirSync(outDir, { recursive: true })

  let generated = 0
  for (const entry of fleet.combinations) {
    if (!entry.enabled) continue

    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const outPath = join(outDir, result.filename)

    if (dryRun) {
      console.log(`[dry-run] Would write ${outPath}`)
    } else {
      writeFileSync(outPath, result.content, 'utf8')
      console.log(`Generated ${outPath}`)
    }
    generated++
  }

  console.log(`Done: ${generated.toString()} config(s) ${dryRun ? 'previewed' : 'generated'}`)
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
