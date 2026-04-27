import type { Exchange, FundingInterval } from '../types/exchange.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadata } from '../markets/types.js'

export type StrategyId = 'strategy_1' | 'strategy_3a' | 'strategy_3b'

export type Side = 'long' | 'short'

export interface Strategy1Config {
  id: 'strategy_1'
  enabled: boolean
  negativeFundingThresholdPercent: number
  entryOffsetSeconds: number
  exitOffsetSeconds: number
  amountUsd: number
  leverage: number
}

export interface Strategy3SharedConfig {
  enabled: boolean
  negativeFundingThresholdPercent: number
  entryOffsetSeconds: number
  stopLossPercent: number
  takeProfitPercent: number
  tpVariantAMultiplier: number
  tpVariantBOffsetPercent: number
  deadlineSeconds: number
  amountUsd: number
  leverage: number
}

export interface Strategy3aConfig extends Strategy3SharedConfig {
  id: 'strategy_3a'
  tpVariant: 'A'
}

export interface Strategy3bConfig extends Strategy3SharedConfig {
  id: 'strategy_3b'
  tpVariant: 'B'
}

export type StrategyConfig = Strategy1Config | Strategy3aConfig | Strategy3bConfig

export type ExitPolicy =
  | {
      kind: 'timed'
      exitAt: number
    }
  | {
      kind: 'sl_tp_deadline'
      slPct: number
      tpPct: number
      deadlineAt: number
      /** Audit/persistence label only — the manager uses `tpPct` directly and never reads this field. */
      tpVariant: 'A' | 'B'
    }

export interface TradeIntent {
  id: string
  strategy: StrategyId
  exchange: Exchange
  symbol: string
  exchangeSymbol: string
  side: Side
  amountUsd: number
  leverage: number
  volume: number
  fundingRate: number
  fundingRatePercent: number
  fundingInterval: FundingInterval
  nextFundingTimestamp: number
  nextFundingDatetime: string
  decidedAt: number
  entryAt: number
  exitPolicy: ExitPolicy
}

export interface EvalContext {
  now: number
  exchange: Exchange
  fundingEvent: {
    symbol: string
    nextFundingTimestamp: number
    fundingInterval: FundingInterval
  }
  snapshots: Map<string, FundingSnapshot>
  markets: (symbol: string) => MarketMetadata | undefined
  config: StrategyConfig
}

export interface StrategyRule {
  readonly id: StrategyId
  evaluate(ctx: EvalContext): TradeIntent[]
}

export interface StrategyEvaluator {
  evaluate(exchange: Exchange, fundingEventSymbol: string): TradeIntent[]
}
