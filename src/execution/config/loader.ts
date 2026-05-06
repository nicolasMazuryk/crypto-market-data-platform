import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import YAML from 'yaml'

import type { EngineConfig, ExchangeConfig } from './types.js'
import { parseEngineConfig } from './schema.js'

export interface LoadEngineConfigOptions {
  configPath: string
  /**
   * Optional base config to merge before the mode-specific file.
   * Defaults to `execution.base.yaml` in the same directory as `configPath` if it exists.
   * Pass an empty string to disable base config loading.
   */
  basePath?: string
  env?: NodeJS.ProcessEnv
  cliOverrides?: {
    fundingTime?: string
    ackLiveFundingOverride?: boolean
  }
}

/** Deep-merge two plain objects. `override` wins; arrays are replaced, not merged. */
export function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, val] of Object.entries(override)) {
    const baseVal = base[key]
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, val as Record<string, unknown>)
    } else {
      result[key] = val
    }
  }
  return result
}

function resolveGitSha(envSha: string | undefined): string {
  if (envSha && envSha.length > 0) return envSha
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function hashConfig(raw: unknown): string {
  const normalized = JSON.stringify(raw, Object.keys(raw as object).sort())
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function injectCredentials(
  exchanges: ExchangeConfig[],
  mode: 'live' | 'dry_run',
  env: NodeJS.ProcessEnv
): (ExchangeConfig & { credentials?: { apiKey: string; apiSecret: string; apiPassphrase?: string } })[] {
  return exchanges.map(ec => {
    const prefix = ec.credentialsEnvPrefix
    const apiKey = env[`${prefix}_API_KEY`]
    const apiSecret = env[`${prefix}_API_SECRET`]
    const apiPassphrase = env[`${prefix}_API_PASSPHRASE`] ?? env[`${prefix}_API_PASS`]
    if (!apiKey || !apiSecret) {
      if (mode !== 'dry_run' && ec.enabled) {
        throw new Error(
          `missing credentials for exchange ${ec.exchange} (expected ${prefix}_API_KEY and ${prefix}_API_SECRET)`
        )
      }
      return ec
    }
    const creds: { apiKey: string; apiSecret: string; apiPassphrase?: string } = { apiKey, apiSecret }
    if (apiPassphrase) creds.apiPassphrase = apiPassphrase
    return Object.assign({}, ec, { credentials: creds })
  })
}

function loadBaseRaw(configPath: string, basePath: string | undefined): Record<string, unknown> {
  // Explicit basePath: '' disables base loading; non-empty string uses that path.
  if (basePath !== undefined) {
    if (basePath === '') return {}
    const source = readFileSync(resolve(basePath), 'utf8')
    return (YAML.parse(source) ?? {}) as Record<string, unknown>
  }
  // Auto-detect execution.base.yaml in the same directory
  const autoBase = resolve(dirname(configPath), 'execution.base.yaml')
  if (existsSync(autoBase)) {
    const source = readFileSync(autoBase, 'utf8')
    return (YAML.parse(source) ?? {}) as Record<string, unknown>
  }
  return {}
}

export function loadEngineConfig(options: LoadEngineConfigOptions): EngineConfig {
  const env = options.env ?? process.env
  const configPath = resolve(options.configPath)

  const modeSource = readFileSync(configPath, 'utf8')
  const modeRaw = (YAML.parse(modeSource) ?? {}) as Record<string, unknown>

  // Precedence: defaults (Zod) → base → mode-specific → env overrides → CLI overrides
  const baseRaw = loadBaseRaw(configPath, options.basePath)
  const configHash = hashConfig(modeRaw)
  const gitSha = resolveGitSha(env.GIT_SHA)

  let merged: Record<string, unknown> = deepMerge(baseRaw, modeRaw)
  merged = { ...merged, configHash, gitSha }

  if (options.cliOverrides?.fundingTime !== undefined) {
    const existingTesting =
      merged.testing && typeof merged.testing === 'object' && !Array.isArray(merged.testing)
        ? (merged.testing as Record<string, unknown>)
        : {}
    merged = {
      ...merged,
      testing: {
        ...existingTesting,
        fundingTimeOverride: {
          time: options.cliOverrides.fundingTime,
          source: 'cli',
          acknowledgeLiveOverride: options.cliOverrides.ackLiveFundingOverride ?? false,
        },
      },
    }
  }

  const parsed = parseEngineConfig(merged)
  const exchanges = injectCredentials(parsed.exchanges, parsed.mode, env)

  const postgresUrlOverride = env.EXECUTION_POSTGRES_URL
  const persistence = postgresUrlOverride
    ? { ...parsed.persistence, postgresUrl: postgresUrlOverride }
    : parsed.persistence

  return Object.freeze({ ...parsed, exchanges, persistence }) as EngineConfig
}
