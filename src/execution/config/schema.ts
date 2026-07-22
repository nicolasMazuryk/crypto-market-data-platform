import { z } from 'zod'

import type {
  EngineConfig,
  ExchangeConfig,
  FundingTimeOverrideConfig,
  ObservabilityConfig,
  PersistenceConfig,
  RateLimitProfile,
  RiskConfig,
  SchedulerConfig,
  TestingConfig,
} from './types.js'
import type { StrategyConfig, Strategy3aConfig } from '../strategies/types.js'
import { GeneratedLiveStrategySchema, LEGACY_LIVE_KEY_MIGRATIONS } from '../../config/canonical/generate-live.js'

export class ConfigError extends Error {
  constructor(
    public readonly path: string,
    message: string
  ) {
    super(`config[${path}]: ${message}`)
    this.name = 'ConfigError'
  }
}

// ============================================================
//  Zod schemas — exported so validate-config CLI can use .safeParse()
// ============================================================

const ExchangeEnum = z.enum(['binance', 'bybit', 'okx', 'bitget', 'gateio', 'kucoin'])

const RateLimitBucketSchema = z.object({
  endpointClass: z.string(),
  tokensPerSecond: z.number(),
  burst: z.number(),
})

const RateLimitProfileSchema = z.object({
  criticalReservationFraction: z.number().default(0.1),
  criticalWindowSeconds: z.number().default(60),
  buckets: z.array(RateLimitBucketSchema).default([]),
})

const ExchangeConfigRawSchema = z.object({
  exchange: ExchangeEnum,
  enabled: z.boolean().default(false),
  credentialsEnvPrefix: z.string().optional(),
  restBaseUrl: z.string().optional(),
  privateWsUrl: z.string().optional(),
  // null/undefined YAML value → apply schema defaults
  rateLimits: z.preprocess(v => v ?? {}, RateLimitProfileSchema),
  marketRefreshMs: z.number().default(60_000),
  fundingPullMs: z.number().default(15_000),
})

// Generated from the canonical registry (src/config/canonical/) — the single source of
// truth shared with the backtest schema. See CANONICAL_PARAMS/STRATEGY_DEFS for per-field
// names, units, and defaults; OQ-7 fixed the -0.5 -> -0.4 negativeFundingThresholdPercent
// drift that previously affected strategy_1/strategy_1_ws/strategy_3a here.
const StrategyRawSchema = GeneratedLiveStrategySchema

const PersistenceRawSchema = z.object({
  postgresUrl: z.string().default(''),
  writerQueueSize: z.number().int().positive().default(1000),
  walPath: z.string().default(''),
  batchSize: z.number().int().positive().default(100),
  flushIntervalMs: z.number().positive().default(250),
  walMaxBytes: z
    .number()
    .positive()
    .default(50 * 1024 * 1024),
})

const SchedulerRawSchema = z.object({
  wakeBeforeHourEndMs: z.number().positive().default(300_000),
  fundingWindowMs: z.number().positive().default(300_000),
})

const TracingRawSchema = z.object({
  enabled: z.boolean().default(false),
  serviceName: z.string().default('execution-engine'),
  endpoint: z.string().optional(),
  sampler: z
    .union([z.literal('always_on'), z.literal('parent'), z.object({ ratio: z.number().min(0).max(1) })])
    .default('parent'),
})

const ObservabilityRawSchema = z.object({
  metricsPort: z.number().int().positive().default(9464),
  healthPort: z.number().int().positive().default(9466),
  tracing: z.preprocess(v => v ?? {}, TracingRawSchema),
})

const PerStrategyRiskRawSchema = z.object({
  maxConcurrentIntents: z.number().int().positive().default(1),
  maxNotionalUsd: z.number().positive().default(100),
})

const RiskRawSchema = z.object({
  globalMaxConcurrentIntents: z.number().int().positive().default(10),
  globalMaxNotionalUsd: z.number().positive().default(1000),
  acknowledgeUncapped: z.boolean().optional(),
  perStrategy: z
    .object({
      strategy_1: PerStrategyRiskRawSchema.optional(),
      strategy_1_ws: PerStrategyRiskRawSchema.optional(),
      strategy_2: PerStrategyRiskRawSchema.optional(),
      strategy_3a: PerStrategyRiskRawSchema.optional(),
      strategy_4_1a: PerStrategyRiskRawSchema.optional(),
      strategy_4_2a: PerStrategyRiskRawSchema.optional(),
      strategy_6: PerStrategyRiskRawSchema.optional(),
    })
    .default({}),
})

const FundingTimeOverrideRawSchema = z.object({
  time: z.string().optional(),
  timestampMs: z.number().optional(),
  acknowledgeLiveOverride: z.boolean().default(false),
  source: z.enum(['cli', 'yaml']).default('yaml'),
})

const TestingRawSchema = z.object({
  fundingTimeOverride: FundingTimeOverrideRawSchema.optional(),
  shadowFillDelayMs: z.number().nonnegative().optional(),
  strategy6ShadowMode: z.boolean().optional(),
})

export const EngineConfigRawSchema = z.object({
  mode: z.enum(['live', 'dry_run']).default('dry_run'),
  gitSha: z.string().optional(),
  configHash: z.string().optional(),
  exchanges: z.array(ExchangeConfigRawSchema).default([]),
  strategies: z.array(StrategyRawSchema).default([]),
  persistence: z.preprocess(v => v ?? {}, PersistenceRawSchema),
  observability: z.preprocess(v => v ?? {}, ObservabilityRawSchema),
  risk: z.preprocess(v => v ?? {}, RiskRawSchema),
  scheduler: z.preprocess(v => v ?? {}, SchedulerRawSchema),
  testing: TestingRawSchema.optional(),
})

// ============================================================
//  Semantic-validation helpers (custom logic beyond Zod)
// ============================================================

function resolveHHMMSS(time: string, now: number): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time)
  if (!match) throw new ConfigError('testing.fundingTimeOverride.time', `must be HH:MM:SS (got ${time})`)
  const h = Number(match[1])
  const m = Number(match[2])
  const s = Number(match[3])
  if (h > 23 || m > 59 || s > 59) {
    throw new ConfigError('testing.fundingTimeOverride.time', `invalid time components in ${time}`)
  }
  const base = new Date(now)
  base.setUTCHours(h, m, s, 0)
  const todayMs = base.getTime()
  return todayMs > now ? todayMs : todayMs + 86_400_000
}

function parseTestingConfig(
  raw: z.infer<typeof TestingRawSchema> | undefined,
  mode: 'live' | 'dry_run',
  now: number
): TestingConfig | undefined {
  if (!raw) return undefined

  const { shadowFillDelayMs, strategy6ShadowMode, fundingTimeOverride: override } = raw
  const shadowFields = {
    ...(shadowFillDelayMs !== undefined ? { shadowFillDelayMs } : {}),
    ...(strategy6ShadowMode !== undefined ? { strategy6ShadowMode } : {}),
  }

  if (!override) {
    return Object.keys(shadowFields).length > 0 ? shadowFields : undefined
  }

  const { acknowledgeLiveOverride, source } = override

  let resolvedMs: number
  if (override.timestampMs !== undefined) {
    resolvedMs = override.timestampMs
  } else if (override.time) {
    resolvedMs = resolveHHMMSS(override.time, now)
  } else {
    return Object.keys(shadowFields).length > 0 ? shadowFields : undefined
  }

  const delta = resolvedMs - now
  if (delta < -3_600_000) {
    throw new ConfigError('testing.fundingTimeOverride', 'override timestamp is more than 1h in the past')
  }
  if (delta > 86_400_000) {
    throw new ConfigError('testing.fundingTimeOverride', 'override timestamp is more than 24h in the future')
  }

  if (mode === 'live' && !acknowledgeLiveOverride) {
    throw new ConfigError(
      'testing.fundingTimeOverride',
      'live mode requires testing.fundingTimeOverride.acknowledgeLiveOverride: true (or --ack-live-funding-override)'
    )
  }

  const fundingCfg: FundingTimeOverrideConfig = { resolvedMs, source, acknowledgeLiveOverride }
  return {
    fundingTimeOverride: fundingCfg,
    ...shadowFields,
  }
}

// Registry-driven legacy-key migration (LEGACY_LIVE_KEY_MIGRATIONS) — currently just
// strategy_6's funding_threshold -> fundingThresholdPercent. Exported so the config:validate
// CLIs (src/execution/scripts + cli/validate-config.ts) can apply it before their own
// EngineConfigRawSchema.safeParse — otherwise the generated schema's .strict() rejects a
// legacy key as "Unrecognized key" before parseEngineConfig ever gets to migrate it.
// TODO: drop funding_threshold legacy alias — one migration cycle per §13-R6
export function migrateLegacyStrategyKeys(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.strategies)) return raw

  const strategies = obj.strategies.map((entry: unknown, i: number) => {
    if (typeof entry !== 'object' || entry === null) return entry
    const migrations = LEGACY_LIVE_KEY_MIGRATIONS.filter(m => m.strategyId === (entry as Record<string, unknown>).id)
    if (migrations.length === 0) return entry

    let result = entry as Record<string, unknown>
    for (const { legacyKey, canonicalKey, strategyId } of migrations) {
      const hasLegacy = legacyKey in result
      const hasCanonical = canonicalKey in result
      if (hasLegacy && hasCanonical) {
        throw new ConfigError(
          `strategies[${String(i)}].${canonicalKey}`,
          `ambiguous: both "${legacyKey}" (legacy) and "${canonicalKey}" (canonical) present — remove "${legacyKey}"`
        )
      }
      if (hasLegacy) {
        console.warn(
          `config: strategy "${strategyId}" uses deprecated key "${legacyKey}" — rename to "${canonicalKey}"; remove before next cycle`
        )
        const { [legacyKey]: value, ...rest } = result
        result = { ...rest, [canonicalKey]: value }
      }
    }
    return result
  })

  return { ...obj, strategies }
}

// ============================================================
//  Public API
// ============================================================

export function parseEngineConfig(raw: unknown, now = Date.now()): EngineConfig {
  const migratedRaw = migrateLegacyStrategyKeys(raw)
  let parsed: z.infer<typeof EngineConfigRawSchema>
  try {
    parsed = EngineConfigRawSchema.parse(migratedRaw)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const first = err.issues[0]
      if (first !== undefined) {
        const path = first.path.map(String).join('.')
        throw new ConfigError(path, first.message)
      }
      throw new ConfigError('unknown', err.message)
    }
    throw err
  }

  // Duplicate exchange check
  const seen = new Set<string>()
  for (const e of parsed.exchanges) {
    if (seen.has(e.exchange)) throw new ConfigError('exchanges', `duplicate exchange: ${e.exchange}`)
    seen.add(e.exchange)
  }

  // Prevent simultaneous LONG (S1/S2/S4_*a) and SHORT (S3a) on the same exchange+symbol
  // (they would offset each other within the same funding window).
  const has3a = parsed.strategies.some(s => s.id === 'strategy_3a' && s.enabled)
  const hasLong = parsed.strategies.some(
    s => ['strategy_1', 'strategy_1_ws', 'strategy_2', 'strategy_4_1a', 'strategy_4_2a'].includes(s.id) && s.enabled
  )
  if (has3a && hasLong) {
    throw new ConfigError(
      'strategies',
      'LONG strategies (strategy_1, strategy_2, strategy_4_*a) and SHORT strategy (strategy_3a) cannot both be enabled — they offset each other within the same funding window'
    )
  }

  // Live safety ceiling
  const LIVE_SAFETY_CEILING = 100_000
  if (
    parsed.mode === 'live' &&
    parsed.risk.globalMaxNotionalUsd > LIVE_SAFETY_CEILING &&
    !parsed.risk.acknowledgeUncapped
  ) {
    throw new ConfigError(
      'risk.globalMaxNotionalUsd',
      `live mode with notional > $${LIVE_SAFETY_CEILING.toLocaleString()} requires risk.acknowledgeUncapped: true`
    )
  }

  const testing = parseTestingConfig(parsed.testing, parsed.mode, now)

  // Apply transforms that can't live inside Zod without breaking discriminatedUnion
  const exchanges: ExchangeConfig[] = parsed.exchanges.map(e => {
    const cfg: ExchangeConfig = {
      exchange: e.exchange,
      enabled: e.enabled,
      credentialsEnvPrefix: e.credentialsEnvPrefix ?? e.exchange.toUpperCase(),
      rateLimits: e.rateLimits as RateLimitProfile,
      marketRefreshMs: e.marketRefreshMs,
      fundingPullMs: e.fundingPullMs,
    }
    if (e.restBaseUrl !== undefined) cfg.restBaseUrl = e.restBaseUrl
    if (e.privateWsUrl !== undefined) cfg.privateWsUrl = e.privateWsUrl
    return cfg
  })

  const strategies: StrategyConfig[] = parsed.strategies.map(s => {
    if (s.id === 'strategy_3a') return { ...s, tpVariant: 'A' as const } as Strategy3aConfig
    return s
  })

  const result: EngineConfig = {
    mode: parsed.mode,
    gitSha: parsed.gitSha ?? 'unknown',
    configHash: parsed.configHash ?? '',
    exchanges,
    strategies,
    persistence: parsed.persistence as PersistenceConfig,
    observability: parsed.observability as ObservabilityConfig,
    risk: parsed.risk as RiskConfig,
    scheduler: parsed.scheduler as SchedulerConfig,
  }
  if (testing) result.testing = testing
  return result
}
