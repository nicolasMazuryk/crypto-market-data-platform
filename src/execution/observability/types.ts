import type { Exchange } from '../types/exchange.js'
import type { StrategyId } from '../strategies/types.js'

export type MetricUnit = 'count' | 'milliseconds' | 'usd' | 'ratio' | 'bytes' | 'info'

export interface MetricLabels {
  exchange?: Exchange
  strategy?: StrategyId
  symbol?: string
  [key: string]: string | undefined
}

export interface Counter {
  inc(value?: number, labels?: MetricLabels): void
}

export interface Gauge {
  set(value: number, labels?: MetricLabels): void
  inc(value?: number, labels?: MetricLabels): void
  dec(value?: number, labels?: MetricLabels): void
}

export interface Histogram {
  observe(value: number, labels?: MetricLabels): void
}

export interface Metrics {
  counter(name: string, help: string, labelNames?: string[]): Counter
  gauge(name: string, help: string, labelNames?: string[]): Gauge
  histogram(name: string, help: string, buckets?: number[], labelNames?: string[]): Histogram
  render(): Promise<string>
}

export interface TraceSpan {
  setAttribute(key: string, value: string | number | boolean): void
  addEvent(name: string, attrs?: Record<string, string | number>): void
  end(endTime?: number): void
  recordException(err: unknown): void
}

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, string | number>): TraceSpan
}
