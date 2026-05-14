import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import YAML from 'yaml'

import { loadRegistry } from '../loader.js'
import { validateRegistry } from '../validate.js'

function loadKnownStrategies(strategiesDir: string): Set<string> {
  const strategies = new Set<string>()
  try {
    const files = readdirSync(strategiesDir)
    for (const f of files) {
      if (!f.endsWith('.yaml')) continue
      const raw = YAML.parse(readFileSync(join(strategiesDir, f), 'utf8')) as Record<string, unknown> | null
      if (raw?.strategy_id && typeof raw.strategy_id === 'string') {
        strategies.add(raw.strategy_id)
      }
    }
  } catch {
    // If directory is unreadable, skip strategy validation
  }
  return strategies
}

const registryPath = process.argv[2] ?? 'live-configs/registry.yaml'
const strategiesDir = process.argv[3] ?? 'config/strategies'

try {
  const registry = loadRegistry(registryPath)
  const knownStrategies = loadKnownStrategies(resolve(strategiesDir))
  const result = validateRegistry(registry, knownStrategies.size > 0 ? knownStrategies : undefined)

  if (result.valid) {
    const active = registry.combinations.filter(entry => entry.status === 'active').length
    const idle = registry.combinations.filter(entry => entry.status === 'idle').length
    console.log(
      `Registry is valid (${String(registry.combinations.length)} sub-accounts: ${String(active)} active, ${String(idle)} idle)`
    )
    process.exit(0)
  } else {
    console.error(
      `Registry validation failed (${String(result.errors.length)} error${result.errors.length !== 1 ? 's' : ''})`
    )
    for (const err of result.errors) {
      console.error(`  ${err}`)
    }
    process.exit(1)
  }
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
