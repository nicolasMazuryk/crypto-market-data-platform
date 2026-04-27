#!/usr/bin/env tsx
/**
 * Validate an execution engine config file without starting the engine.
 *
 * Usage:
 *   npm run config:validate -- --config config/execution.dry-run.yaml
 *   npm run config:validate -- --config config/execution.live.yaml
 *
 * Exit 0 if valid, exit 1 with all errors printed if invalid.
 * Base config (execution.base.yaml) is auto-detected from the same directory.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import YAML from 'yaml'

import { ConfigError, EngineConfigRawSchema, parseEngineConfig } from '../config/schema.js'
import { deepMerge } from '../config/loader.js'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string' },
    base: { type: 'string' },
  },
  strict: true,
})

if (!values.config) {
  console.error('usage: npm run config:validate -- --config <path> [--base <base-config>]')
  process.exit(1)
}

const configPath = resolve(values.config)
if (!existsSync(configPath)) {
  console.error(`config file not found: ${values.config}`)
  process.exit(1)
}

// Load mode-specific config
const modeSource = readFileSync(configPath, 'utf8')
const modeRaw = (YAML.parse(modeSource) ?? {}) as Record<string, unknown>

// Load base config (explicit --base, or auto-detect execution.base.yaml)
const autoBasePath = resolve(dirname(configPath), 'execution.base.yaml')
const basePath = values.base ? resolve(values.base) : existsSync(autoBasePath) ? autoBasePath : null

let merged: Record<string, unknown> = modeRaw
if (basePath) {
  const baseSource = readFileSync(basePath, 'utf8')
  const baseRaw = (YAML.parse(baseSource) ?? {}) as Record<string, unknown>
  merged = deepMerge(baseRaw, modeRaw)
}

// Stage 1: structural validation — collect ALL Zod errors at once
const structuralResult = EngineConfigRawSchema.safeParse(merged)
if (!structuralResult.success) {
  console.error(`Config validation failed: ${values.config}\n`)
  for (const issue of structuralResult.error.issues) {
    const path = issue.path.map(String).join('.') || '(root)'
    console.error(`  [${path}]: ${issue.message}`)
  }
  process.exit(1)
}

// Stage 2: semantic validation — custom cross-field logic
try {
  parseEngineConfig(merged)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`Config validation failed: ${values.config}\n`)
  console.error(`  ${msg}`)
  if (err instanceof ConfigError) {
    // Already formatted as config[path]: message
  }
  process.exit(1)
}

const baseLabel = basePath ? ` (base: ${basePath})` : ''
console.log(`Config valid: ${values.config}${baseLabel}`)
process.exit(0)
