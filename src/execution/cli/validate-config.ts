#!/usr/bin/env node
/**
 * Validate an execution engine config from a built Docker image.
 *
 * Supports either:
 *   node dist/execution/cli/validate-config.js /opt/arbinet/config/execution.foo.yaml.new
 *   node dist/execution/cli/validate-config.js --config /opt/arbinet/config/execution.foo.yaml.new
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import YAML from 'yaml'

import { deepMerge, validateForLiveStart } from '../config/loader.js'
import { ConfigError, EngineConfigRawSchema, parseEngineConfig } from '../config/schema.js'

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string' },
    base: { type: 'string' },
  },
  allowPositionals: true,
  strict: true,
})

const requestedConfig = values.config ?? positionals[0]
if (!requestedConfig) {
  console.error('usage: node dist/execution/cli/validate-config.js <config-path> [--base <base-config>]')
  process.exit(1)
}

const configPath = resolve(requestedConfig)
if (!existsSync(configPath)) {
  console.error(`config file not found: ${requestedConfig}`)
  process.exit(1)
}

const modeSource = readFileSync(configPath, 'utf8')
const modeRaw = (YAML.parse(modeSource) ?? {}) as Record<string, unknown>

const autoBasePath = resolve(dirname(configPath), 'execution.base.yaml')
const basePath = values.base ? resolve(values.base) : existsSync(autoBasePath) ? autoBasePath : null

let merged: Record<string, unknown> = modeRaw
if (basePath) {
  const baseSource = readFileSync(basePath, 'utf8')
  const baseRaw = (YAML.parse(baseSource) ?? {}) as Record<string, unknown>
  merged = deepMerge(baseRaw, modeRaw)
}

const structuralResult = EngineConfigRawSchema.safeParse(merged)
if (!structuralResult.success) {
  console.error(`Config validation failed: ${requestedConfig}\n`)
  for (const issue of structuralResult.error.issues) {
    const path = issue.path.map(String).join('.') || '(root)'
    console.error(`  [${path}]: ${issue.message}`)
  }
  process.exit(1)
}

try {
  validateForLiveStart(parseEngineConfig(merged))
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`Config validation failed: ${requestedConfig}\n`)
  console.error(`  ${msg}`)
  if (err instanceof ConfigError) {
    // Already formatted as config[path]: message.
  }
  process.exit(1)
}

const baseLabel = basePath ? ` (base: ${basePath})` : ''
console.log(`Config valid: ${requestedConfig}${baseLabel}`)
process.exit(0)
