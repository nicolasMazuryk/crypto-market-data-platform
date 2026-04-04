import type { QuoteRow } from './types.js'

export function tsToDateString(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10)
}

export function dayStartMs(dateStr: string): number {
  return Date.parse(`${dateStr}T00:00:00.000Z`)
}

export function dayEndMs(dateStr: string): number {
  return Date.parse(`${dateStr}T23:59:59.000Z`)
}

export function partitionByDay(rows: QuoteRow[]): Map<string, QuoteRow[]> {
  const byDay = new Map<string, QuoteRow[]>()

  for (const row of rows) {
    const date = tsToDateString(row.ts)
    const existing = byDay.get(date)
    if (existing) {
      existing.push(row)
    } else {
      byDay.set(date, [row])
    }
  }

  return byDay
}
