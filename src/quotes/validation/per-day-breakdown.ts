import { dayEndMs, dayStartMs, tsToDateString } from './day-utils.js'
import type { DayQualityEntry, PerDayBreakdownResult, QuoteRow } from './types.js'

const ONE_SECOND_MS = 1000
const FULL_DAY_EXPECTED_CANDLES = 24 * 60 * 60

interface DayStats {
  firstTs: number | null
  lastTs: number | null
  prevTs: number | null
  candleCount: number
  interpolationCount: number
  gapCount: number
  missingSeconds: number
}

function createDayStats(): DayStats {
  return {
    firstTs: null,
    lastTs: null,
    prevTs: null,
    candleCount: 0,
    interpolationCount: 0,
    gapCount: 0,
    missingSeconds: 0,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function expectedCandlesForDay(
  dayStats: DayStats,
  date: string,
  isFirstOrLastDay: boolean
): { expectedCandles: number; partialDay: boolean } {
  const firstTs = dayStats.firstTs
  const lastTs = dayStats.lastTs
  const fullDay = firstTs === dayStartMs(date) && lastTs === dayEndMs(date)
  const partialDay = !fullDay && isFirstOrLastDay

  if (partialDay && firstTs !== null && lastTs !== null) {
    const expectedCandles = Math.floor((lastTs - firstTs) / ONE_SECOND_MS) + 1
    return {
      expectedCandles: Math.max(expectedCandles, dayStats.candleCount),
      partialDay: true,
    }
  }

  return {
    expectedCandles: FULL_DAY_EXPECTED_CANDLES,
    partialDay,
  }
}

function computeQualityScore(
  coveragePercent: number,
  interpolationPercent: number,
  gapCount: number,
  missingSeconds: number
): number {
  const coverageDeduction = Math.min(60, Math.max(0, 100 - coveragePercent) * 2)
  const interpolationDeduction = Math.min(30, interpolationPercent * 0.5)
  const continuityDeduction = Math.min(20, gapCount * 2 + missingSeconds * 0.05)

  return Math.round(clamp(100 - coverageDeduction - interpolationDeduction - continuityDeduction, 0, 100))
}

export class PerDayBreakdownAccumulator {
  private readonly byDay = new Map<string, DayStats>()

  update(row: QuoteRow): void {
    const day = tsToDateString(row.ts)
    const dayStats = this.byDay.get(day) ?? createDayStats()

    dayStats.firstTs ??= row.ts

    if (dayStats.prevTs !== null) {
      const deltaMs = row.ts - dayStats.prevTs
      if (deltaMs > ONE_SECOND_MS) {
        dayStats.gapCount += 1
        dayStats.missingSeconds += Math.max(0, Math.floor(deltaMs / ONE_SECOND_MS) - 1)
      }
    }

    dayStats.candleCount += 1
    dayStats.lastTs = row.ts
    dayStats.prevTs = row.ts

    if (row.is_interpolated) {
      dayStats.interpolationCount += 1
    }

    this.byDay.set(day, dayStats)
  }

  finalize(): PerDayBreakdownResult {
    const entries = [...this.byDay.entries()].sort(([left], [right]) => left.localeCompare(right))

    if (entries.length === 0) {
      return {
        days: [],
        badDayCount: 0,
        badDays: [],
        partialDayCount: 0,
        bestDay: null,
        worstDay: null,
      }
    }

    const days: DayQualityEntry[] = []

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (!entry) {
        continue
      }

      const [date, dayStats] = entry
      const interpolationPercent =
        dayStats.candleCount === 0 ? 0 : (dayStats.interpolationCount / dayStats.candleCount) * 100

      const { expectedCandles, partialDay } = expectedCandlesForDay(
        dayStats,
        date,
        index === 0 || index === entries.length - 1
      )
      const coveragePercent = expectedCandles === 0 ? 0 : (dayStats.candleCount / expectedCandles) * 100

      const qualityScore = computeQualityScore(
        coveragePercent,
        interpolationPercent,
        dayStats.gapCount,
        dayStats.missingSeconds
      )

      days.push({
        date,
        candleCount: dayStats.candleCount,
        expectedCandles,
        coveragePercent,
        interpolationPercent,
        gapCount: dayStats.gapCount,
        missingSeconds: dayStats.missingSeconds,
        qualityScore,
        partialDay,
      })
    }

    const averageInterpolationPercent =
      days.length === 0 ? 0 : days.reduce((total, day) => total + day.interpolationPercent, 0) / days.length

    const badDays = days
      .filter(day => !day.partialDay)
      .filter(day => day.coveragePercent < 99 || day.interpolationPercent > averageInterpolationPercent * 1.5)
      .map(day => day.date)

    let bestDay: DayQualityEntry | null = null
    let worstDay: DayQualityEntry | null = null

    for (const day of days) {
      if (bestDay === null || day.qualityScore > bestDay.qualityScore) {
        bestDay = day
      }

      if (worstDay === null || day.qualityScore < worstDay.qualityScore) {
        worstDay = day
      }
    }

    return {
      days,
      badDayCount: badDays.length,
      badDays,
      partialDayCount: days.filter(day => day.partialDay).length,
      bestDay,
      worstDay,
    }
  }
}

export function buildPerDayBreakdown(rows: QuoteRow[]): PerDayBreakdownResult {
  const accumulator = new PerDayBreakdownAccumulator()

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
