import type { Exchange, TypedEventEmitter, Unsubscribe } from '../types/exchange.js'
import type { TradeIntent } from '../strategies/types.js'
import type { ExitReason, IntentState } from '../execution/types.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadataDelta } from '../markets/types.js'
import type {
  OrderEvent,
  PositionEvent,
  BalanceEvent,
  FillEvent,
  FundingFeeEvent,
  ConnectionStateEvent,
} from '../adapters/privatews/types.js'
import type { DesyncEvent } from '../state/types.js'

export interface OpsEventPayload {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  exchange?: string
  eventType: string
  payload?: unknown
}

export interface OrderPlacedEvent {
  intentId: string
  exchange: Exchange
  symbol: string
  clientOrderId: string
  exchangeOrderId?: string
  kind: 'entry' | 'pre_funding' | 'sl' | 'tp' | 'close' | 'timed'
  side: 'buy' | 'sell'
  orderType: 'market' | 'limit' | 'stop_market'
  qty: number
  price?: number
  stopPrice?: number
  reduceOnly: boolean
  /** True when emitted before REST ACK; exchangeOrderId will be absent. Followed by order.acked log event. */
  ackPending?: boolean
}

export interface OrderFilledEvent {
  intentId: string
  exchange: Exchange
  symbol: string
  clientOrderId: string
  filledQty: number
  avgFillPrice?: number
}

export interface ExitTriggeredEvent {
  intentId: string
  exchange: Exchange
  symbol: string
  reason: ExitReason
  triggerPrice?: number
  triggerTs: number
  source: 'ws' | 'timer' | 'rest_poll'
  exitOrderClientId?: string
  latencyMs?: number
}

export interface IntentExitedEvent {
  intentId: string
  exchange: Exchange
  symbol: string
  side: string
  qty: number
  avgEntryPrice?: number
  avgExitPrice?: number
  exitReason: string
  decidedAt: number
  entryFilledAt?: number
  exitFilledAt: number
}

export interface PositionOpenedEvent {
  intentId: string
  exchange: Exchange
  symbol: string
  side: string
  filledQty: number
  avgEntryPrice?: number
}

export interface DomainEvents {
  'funding.snapshot': (snapshot: FundingSnapshot) => void
  'markets.updated': (delta: MarketMetadataDelta) => void
  'intent.decided': (intent: TradeIntent) => void
  'intent.created': (state: IntentState) => void
  'intent.submitted': (state: IntentState) => void
  'intent.state_changed': (state: IntentState) => void
  'intent.exited': (event: IntentExitedEvent) => void
  'order.placed': (event: OrderPlacedEvent) => void
  'order.filled': (event: OrderFilledEvent) => void
  'exit.triggered': (event: ExitTriggeredEvent) => void
  'position.opened': (event: PositionOpenedEvent) => void
  'ws.order': (event: OrderEvent) => void
  'ws.position': (event: PositionEvent) => void
  'ws.balance': (event: BalanceEvent) => void
  'ws.fill': (event: FillEvent) => void
  'ws.funding_fee': (event: FundingFeeEvent) => void
  'ws.connection': (event: ConnectionStateEvent) => void
  'state.desync': (event: DesyncEvent) => void
  'ops.event': (event: OpsEventPayload) => void
  'intent.funding_gate_opened': (event: { intentId: string }) => void
}

export type EventBus = TypedEventEmitter<DomainEvents>

export interface Clock {
  now(): number
  monotonic(): number
  skewMs(exchange: Exchange): number
  recordSkew(exchange: Exchange, serverTime: number, localTime: number): void
}

export interface ClientOrderIdDeriver {
  forIntent(intentId: string, attempt: number): string
  forExit(intentId: string, kind: 'sl' | 'tp' | 'close' | 'timed'): string
}

export type RateLimitPriority = 'critical' | 'normal' | 'background'

export interface RateLimiterAcquireOptions {
  priority: RateLimitPriority
  tokens?: number
  signal?: AbortSignal
}

export interface RateLimiter {
  acquire(endpointClass: string, options: RateLimiterAcquireOptions): Promise<void>
  reserve(endpointClass: string, tokens: number, windowMs: number): Unsubscribe
}

export interface SchedulerTrigger {
  id: string
  firesAt: number
  handler: () => Promise<void> | void
}

export interface Scheduler {
  schedule(trigger: SchedulerTrigger): Unsubscribe
  cancel(id: string): void
  start(): Promise<void>
  stop(): Promise<void>
}
