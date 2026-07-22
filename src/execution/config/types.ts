import type { Exchange } from '../types/exchange.js'
import type { StrategyConfig, StrategyId } from '../strategies/types.js'

export interface FundingTimeOverrideConfig {
  resolvedMs: number
  source: 'cli' | 'yaml'
  acknowledgeLiveOverride: boolean
}

export interface TestingConfig {
  fundingTimeOverride?: FundingTimeOverrideConfig
  /** Delay in ms before shadow adapter fills an order. Default: 150ms. Use a large value (e.g. 30000) to hold positions open for kill-switch trip testing. */
  shadowFillDelayMs?: number
  /** strategy_6 live-empirical validation §6.2.1: stub order submission at the WS-order-adapter
   *  choke point (log-only synthetic ACK/fill) so the state machine + calibration timeline run
   *  without ever touching the real exchange. Independent of `mode` (dry_run gates credentials). */
  strategy6ShadowMode?: boolean
}

export interface RateLimitBucket {
  endpointClass: string
  tokensPerSecond: number
  burst: number
}

export interface RateLimitProfile {
  criticalReservationFraction: number
  criticalWindowSeconds: number
  buckets: RateLimitBucket[]
}

export interface ExchangeCredentials {
  apiKey: string
  apiSecret: string
  apiPassphrase?: string
}

export interface ExchangeConfig {
  exchange: Exchange
  enabled: boolean
  credentialsEnvPrefix: string
  restBaseUrl?: string
  privateWsUrl?: string
  rateLimits: RateLimitProfile
  marketRefreshMs: number
  fundingPullMs: number
}

export interface PersistenceConfig {
  postgresUrl: string
  writerQueueSize: number
  walPath: string
  batchSize: number
  flushIntervalMs: number
  walMaxBytes: number
}

export interface EngineBootstrapOptions {
  runNotes?: string
  resumeRunId?: string
}

export interface ObservabilityConfig {
  metricsPort: number
  healthPort: number
  tracing: {
    enabled: boolean
    serviceName: string
    endpoint?: string
    sampler: 'always_on' | 'parent' | { ratio: number }
  }
}

export interface RiskConfig {
  globalMaxConcurrentIntents: number
  globalMaxNotionalUsd: number
  acknowledgeUncapped?: boolean
  perStrategy: Partial<
    Record<
      StrategyId,
      {
        maxConcurrentIntents: number
        maxNotionalUsd: number
      }
    >
  >
}

export interface SchedulerConfig {
  wakeBeforeHourEndMs: number
  fundingWindowMs: number
}

export interface EngineIdentity {
  strategy: string
  exchange: string
  subAccountId: string
  combinationId: string
}

export interface EngineConfig {
  mode: 'live' | 'dry_run'
  gitSha: string
  configHash: string
  exchanges: ExchangeConfig[]
  strategies: StrategyConfig[]
  persistence: PersistenceConfig
  observability: ObservabilityConfig
  risk: RiskConfig
  scheduler: SchedulerConfig
  testing?: TestingConfig
  identity?: EngineIdentity
}
