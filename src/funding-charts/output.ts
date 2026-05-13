import { access, mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import type { FundingEvent } from './types.js'

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatDateUTC(d: Date): string {
  return `${d.getUTCFullYear().toString()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function formatTimeUTC(d: Date): string {
  return `${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}-${pad2(d.getUTCSeconds())}`
}

function formatRate(rate: number): string {
  const pct = rate * 100
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(3)}pct`
}

export function buildOutputPath(event: FundingEvent, outDir: string): string {
  const date = formatDateUTC(event.funding_time)
  const time = formatTimeUTC(event.funding_time)
  const rate = formatRate(event.funding_rate)
  return join(outDir, event.exchange, `${event.symbol}_${date}_${time}_${rate}.png`)
}

export async function writePng(filePath: string, buf: Buffer, overwrite: boolean): Promise<boolean> {
  if (!overwrite) {
    try {
      await access(filePath)
      return false
    } catch {
      // file doesn't exist, proceed
    }
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, buf)
  return true
}
