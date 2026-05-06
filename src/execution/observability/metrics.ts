import { createServer, type Server } from 'node:http'

import type { Exchange } from '../types/exchange.js'
import type { Counter, Gauge, Histogram, MetricLabels, Metrics } from './types.js'

type MetricKind = 'counter' | 'gauge' | 'histogram'

interface BaseMetric {
  name: string
  help: string
  kind: MetricKind
  labelNames: string[]
}

interface CounterMetric extends BaseMetric {
  kind: 'counter'
  values: Map<string, { labels: Record<string, string>; value: number }>
}

interface GaugeMetric extends BaseMetric {
  kind: 'gauge'
  values: Map<string, { labels: Record<string, string>; value: number }>
}

interface HistogramMetric extends BaseMetric {
  kind: 'histogram'
  buckets: number[]
  values: Map<
    string,
    {
      labels: Record<string, string>
      bucketCounts: number[]
      sum: number
      count: number
    }
  >
}

type AnyMetric = CounterMetric | GaugeMetric | HistogramMetric

function labelKey(labels: Record<string, string>, labelNames: string[]): string {
  return labelNames.map(n => `${n}=${labels[n] ?? ''}`).join(',')
}

function normalizeLabels(input: MetricLabels | undefined, labelNames: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input) {
    for (const n of labelNames) out[n] = ''
    return out
  }
  for (const n of labelNames) {
    const v = input[n]
    out[n] = v ?? ''
  }
  return out
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function renderLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
  return parts.length === 0 ? '' : `{${parts.join(',')}}`
}

export class MetricsRegistry implements Metrics {
  private metrics = new Map<string, AnyMetric>()

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const metric: CounterMetric = this.upsert({
      name,
      help,
      kind: 'counter',
      labelNames,
      values: new Map(),
    })
    return {
      inc: (value = 1, labels) => {
        const norm = normalizeLabels(labels, labelNames)
        const key = labelKey(norm, labelNames)
        const existing = metric.values.get(key)
        if (existing) existing.value += value
        else metric.values.set(key, { labels: norm, value })
      },
    }
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const metric: GaugeMetric = this.upsert({
      name,
      help,
      kind: 'gauge',
      labelNames,
      values: new Map(),
    })
    const update = (delta: number, labels: MetricLabels | undefined, set: boolean) => {
      const norm = normalizeLabels(labels, labelNames)
      const key = labelKey(norm, labelNames)
      const existing = metric.values.get(key)
      if (existing) existing.value = set ? delta : existing.value + delta
      else metric.values.set(key, { labels: norm, value: delta })
    }
    return {
      set: (value, labels) => {
        update(value, labels, true)
      },
      inc: (value = 1, labels) => {
        update(value, labels, false)
      },
      dec: (value = 1, labels) => {
        update(-value, labels, false)
      },
    }
  }

  histogram(
    name: string,
    help: string,
    buckets: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    labelNames: string[] = []
  ): Histogram {
    const metric: HistogramMetric = this.upsert({
      name,
      help,
      kind: 'histogram',
      labelNames,
      buckets: [...buckets].sort((a, b) => a - b),
      values: new Map(),
    })
    return {
      observe: (value, labels) => {
        const norm = normalizeLabels(labels, labelNames)
        const key = labelKey(norm, labelNames)
        let entry = metric.values.get(key)
        if (!entry) {
          entry = {
            labels: norm,
            bucketCounts: new Array<number>(metric.buckets.length).fill(0),
            sum: 0,
            count: 0,
          }
          metric.values.set(key, entry)
        }
        entry.count += 1
        entry.sum += value
        for (let i = 0; i < metric.buckets.length; i += 1) {
          const bucket = metric.buckets[i]
          if (bucket !== undefined && value <= bucket) {
            const current = entry.bucketCounts[i] ?? 0
            entry.bucketCounts[i] = current + 1
          }
        }
      },
    }
  }

  private upsert<T extends AnyMetric>(metric: T): T {
    const existing = this.metrics.get(metric.name)
    if (existing) {
      if (existing.kind !== metric.kind) {
        throw new Error(`metric ${metric.name} redefined with different kind`)
      }
      return existing as T
    }
    this.metrics.set(metric.name, metric)
    return metric
  }

  render(): Promise<string> {
    const out: string[] = []
    for (const metric of this.metrics.values()) {
      out.push(`# HELP ${metric.name} ${metric.help}`)
      out.push(`# TYPE ${metric.name} ${metric.kind}`)
      if (metric.kind === 'counter' || metric.kind === 'gauge') {
        if (metric.values.size === 0) {
          out.push(`${metric.name} 0`)
        }
        for (const { labels, value } of metric.values.values()) {
          out.push(`${metric.name}${renderLabels(labels)} ${String(value)}`)
        }
      } else {
        for (const entry of metric.values.values()) {
          for (let i = 0; i < metric.buckets.length; i += 1) {
            const bucket = metric.buckets[i]
            const count = entry.bucketCounts[i] ?? 0
            out.push(`${metric.name}_bucket${renderLabels({ ...entry.labels, le: String(bucket) })} ${String(count)}`)
          }
          out.push(`${metric.name}_bucket${renderLabels({ ...entry.labels, le: '+Inf' })} ${String(entry.count)}`)
          out.push(`${metric.name}_sum${renderLabels(entry.labels)} ${String(entry.sum)}`)
          out.push(`${metric.name}_count${renderLabels(entry.labels)} ${String(entry.count)}`)
        }
      }
    }
    return Promise.resolve(out.join('\n') + '\n')
  }
}

export interface MetricsServer {
  port: number
  close(): Promise<void>
}

export async function startMetricsServer(registry: MetricsRegistry, port: number): Promise<MetricsServer> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'GET' && url.startsWith('/metrics')) {
      registry
        .render()
        .then(body => {
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
          res.end(body)
        })
        .catch((err: unknown) => {
          res.writeHead(500)
          res.end(String(err))
        })
      return
    }
    if (req.method === 'GET' && url.startsWith('/healthz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(port, () => {
      server.off('error', rejectPromise)
      resolvePromise()
    })
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close(err => {
          if (err) rejectPromise(err)
          else resolvePromise()
        })
      }),
  }
}

export interface MarketsMetrics {
  refreshTotal: Counter
  refreshDurationMs: Histogram
  total: Gauge
}

export function registerMarketsMetrics(registry: MetricsRegistry): MarketsMetrics {
  return {
    refreshTotal: registry.counter('markets_refresh_total', 'Market catalog refresh attempts', ['exchange', 'status']),
    refreshDurationMs: registry.histogram(
      'markets_refresh_duration_ms',
      'Market catalog refresh duration in milliseconds',
      [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
      ['exchange']
    ),
    total: registry.gauge('markets_total', 'Number of markets by exchange and status', ['exchange', 'status']),
  }
}

export interface FundingMetrics {
  pullTotal: Counter
  pullDurationMs: Histogram
  snapshotsTotal: Gauge
  snapshotsStale: Gauge
  overrideAppliedTotal: Counter
  evictedTotal: Counter
}

export function registerFundingMetrics(registry: MetricsRegistry): FundingMetrics {
  return {
    pullTotal: registry.counter('funding_pull_total', 'Funding rate pull attempts', ['exchange', 'status']),
    pullDurationMs: registry.histogram(
      'funding_pull_duration_ms',
      'Funding rate pull duration in milliseconds',
      [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
      ['exchange']
    ),
    snapshotsTotal: registry.gauge('funding_snapshots_total', 'Number of funding snapshots in store', ['exchange']),
    snapshotsStale: registry.gauge('funding_snapshots_stale', 'Number of stale funding snapshots', ['exchange']),
    overrideAppliedTotal: registry.counter(
      'funding_override_applied_total',
      'Funding snapshots rewritten by time override',
      ['exchange']
    ),
    evictedTotal: registry.counter('funding_snapshots_evicted_total', 'Funding snapshots evicted from store', [
      'exchange',
      'reason',
    ]),
  }
}

export interface RestMetrics {
  requestTotal: Counter
  requestDurationMs: Histogram
  ordersTotal: Counter
  orderCreateDurationMs: Histogram
  idempotencyHits: Counter
  rejectionsByCode: Counter
}

export function registerRestMetrics(registry: MetricsRegistry): RestMetrics {
  return {
    requestTotal: registry.counter('rest_request_total', 'REST request attempts', ['exchange', 'method', 'status']),
    requestDurationMs: registry.histogram(
      'rest_request_duration_ms',
      'REST request duration in milliseconds',
      [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
      ['exchange', 'method']
    ),
    ordersTotal: registry.counter('rest_orders_total', 'Orders submitted via REST', [
      'exchange',
      'side',
      'type',
      'status',
    ]),
    orderCreateDurationMs: registry.histogram(
      'rest_order_create_duration_ms',
      'Order create round-trip duration in milliseconds',
      [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
      ['exchange']
    ),
    idempotencyHits: registry.counter(
      'rest_idempotency_hits_total',
      'createOrder calls resolved via fetchOrder after retryable error',
      ['exchange']
    ),
    rejectionsByCode: registry.counter(
      'rest_rejections_by_code_total',
      'Exchange-side order rejections by error code',
      ['exchange', 'code']
    ),
  }
}

export interface RateLimitMetrics {
  acquireTotal: Counter
  waitDurationMs: Histogram
  tokensAvailable: Gauge
  reservationTokens: Gauge
}

export function registerRateLimitMetrics(registry: MetricsRegistry): RateLimitMetrics {
  return {
    acquireTotal: registry.counter('ratelimit_acquire_total', 'Rate limiter acquire attempts', [
      'bucket',
      'priority',
      'status',
    ]),
    waitDurationMs: registry.histogram(
      'ratelimit_wait_duration_ms',
      'Time spent waiting for a rate limit token in milliseconds',
      [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
      ['bucket', 'priority']
    ),
    tokensAvailable: registry.gauge(
      'ratelimit_tokens_available',
      'Available tokens in each bucket (sampled at acquire time)',
      ['bucket']
    ),
    reservationTokens: registry.gauge(
      'ratelimit_reservation_tokens',
      'Total tokens held by active reservations per bucket',
      ['bucket']
    ),
  }
}

export interface PrivateWsMetrics {
  connectTotal: Counter
  reconnectTotal: Counter
  messagesTotal: Counter
  eventLagMs: Histogram
  connectionState: Gauge
}

export function registerPrivateWsMetrics(registry: MetricsRegistry): PrivateWsMetrics {
  return {
    connectTotal: registry.counter('ws_connect_total', 'WS connection attempts', ['exchange', 'status']),
    reconnectTotal: registry.counter('ws_reconnect_total', 'WS reconnect attempts', ['exchange']),
    messagesTotal: registry.counter('ws_messages_total', 'WS messages received', ['exchange', 'event']),
    eventLagMs: registry.histogram(
      'ws_event_lag_ms',
      'WS event lag in milliseconds (receivedAt - E)',
      [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      ['exchange', 'event']
    ),
    connectionState: registry.gauge(
      'ws_connection_state',
      'WS connection state (0=disconnected 1=connecting 2=connected 3=reconnecting 4=fatal)',
      ['exchange']
    ),
  }
}

export interface StateMetrics {
  reconcileTotal: Counter
  reconcileDurationMs: Histogram
  desyncTotal: Counter
  ordersSize: Gauge
  positionsSize: Gauge
  balancesSize: Gauge
}

export function registerStateMetrics(registry: MetricsRegistry): StateMetrics {
  return {
    reconcileTotal: registry.counter('state_reconcile_total', 'Reconcile attempts', ['exchange', 'status']),
    reconcileDurationMs: registry.histogram(
      'state_reconcile_duration_ms',
      'Reconcile duration in milliseconds',
      [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      ['exchange']
    ),
    desyncTotal: registry.counter('state_desync_total', 'Desync events detected', ['exchange', 'kind']),
    ordersSize: registry.gauge('state_orders_size', 'Number of orders in state store', ['exchange']),
    positionsSize: registry.gauge('state_positions_size', 'Number of positions in state store', ['exchange']),
    balancesSize: registry.gauge('state_balances_size', 'Number of balances in state store', ['exchange']),
  }
}

export interface ExecutionMetrics {
  intentDecidedTotal: Counter
  intentRejectedTotal: Counter
  intentFilledTotal: Counter
  intentTerminalTotal: Counter
  intentsOpen: Gauge
  intentEntryLatencyMs: Histogram
  intentExitLatencyMs: Histogram
  pnlRealizedTotal: Counter
}

export function registerExecutionMetrics(registry: MetricsRegistry): ExecutionMetrics {
  return {
    intentDecidedTotal: registry.counter('intents_decided_total', 'Trade intents decided by strategy evaluator', [
      'exchange',
      'strategy',
    ]),
    intentRejectedTotal: registry.counter('intents_rejected_total', 'Trade intents rejected by preflight', [
      'exchange',
      'strategy',
      'code',
    ]),
    intentFilledTotal: registry.counter('intents_filled_total', 'Trade intents that reached filled status', [
      'exchange',
      'strategy',
    ]),
    intentTerminalTotal: registry.counter('intents_terminal_total', 'Trade intents that reached a terminal state', [
      'exchange',
      'strategy',
      'exit_reason',
    ]),
    intentsOpen: registry.gauge('intents_open', 'Open trade intents by status', ['exchange', 'strategy', 'status']),
    intentEntryLatencyMs: registry.histogram(
      'intent_entry_latency_ms',
      'Time from decidedAt to entry order filled in milliseconds',
      [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      ['exchange', 'strategy']
    ),
    intentExitLatencyMs: registry.histogram(
      'intent_exit_latency_ms',
      'Time from entry filled to exit order filled in milliseconds',
      [100, 500, 1000, 5000, 15000, 30000, 60000, 300000],
      ['exchange', 'strategy']
    ),
    pnlRealizedTotal: registry.counter('pnl_realized_total', 'Realized PnL in USDT when intent exits', [
      'strategy',
      'exchange',
    ]),
  }
}

export interface PersistenceMetrics {
  writesTotal: Counter
  queueSize: Gauge
  droppedTotal: Counter
  flushDurationMs: Histogram
  orphansFlattenedTotal: Counter
  orphansCancelledTotal: Counter
}

export function registerPersistenceMetrics(registry: MetricsRegistry): PersistenceMetrics {
  return {
    writesTotal: registry.counter('persistence_writes_total', 'Persistence write attempts', ['table', 'result']),
    queueSize: registry.gauge('persistence_queue_size', 'Current persistence write queue depth'),
    droppedTotal: registry.counter('persistence_dropped_total', 'Persistence writes dropped', ['reason']),
    flushDurationMs: registry.histogram(
      'persistence_flush_duration_ms',
      'Persistence batch flush duration in milliseconds',
      [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
      []
    ),
    orphansFlattenedTotal: registry.counter(
      'recovery_orphans_flattened_total',
      'Orphan positions auto-flattened on recovery',
      ['exchange']
    ),
    orphansCancelledTotal: registry.counter('recovery_orphans_cancelled_total', 'Orphan orders cancelled on recovery', [
      'exchange',
    ]),
  }
}

export interface KillSwitchMetrics {
  mode: Gauge
  update(mode: string): void
}

export function registerKillSwitchMetrics(registry: MetricsRegistry, initialMode: string): KillSwitchMetrics {
  const modeGauge = registry.gauge('kill_switch_mode', 'Active kill switch mode (1 = active, 0 = inactive)', ['mode'])
  const allModes = ['live', 'dry_run', 'drain_only', 'halted']
  for (const m of allModes) {
    modeGauge.set(m === initialMode ? 1 : 0, { mode: m })
  }
  return {
    mode: modeGauge,
    update(mode: string) {
      for (const m of allModes) {
        modeGauge.set(m === mode ? 1 : 0, { mode: m })
      }
    },
  }
}

export function registerBaseMetrics(
  registry: MetricsRegistry,
  params: {
    mode: string
    configHash: string
    startedAtSeconds: number
    enabledExchanges: Exchange[]
  }
): void {
  const up = registry.gauge('engine_up', 'Whether the execution engine is up', ['mode'])
  up.set(1, { mode: params.mode })

  const info = registry.gauge('engine_config_hash_info', 'Engine config hash', ['hash'])
  info.set(1, { hash: params.configHash })

  const startedAt = registry.gauge('engine_started_at_seconds', 'Engine start time in unix seconds')
  startedAt.set(params.startedAtSeconds)

  const exchangeEnabled = registry.gauge('engine_exchange_enabled', 'Exchange enabled (1) or disabled (0)', [
    'exchange',
  ])
  for (const e of params.enabledExchanges) {
    exchangeEnabled.set(1, { exchange: e })
  }
}
