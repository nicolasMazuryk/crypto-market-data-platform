import fs from 'fs'

import { createCanvas } from '@napi-rs/canvas'
import { CategoryScale, Chart, Filler, LineController, LineElement, LinearScale, PointElement } from 'chart.js'

Chart.register(CategoryScale, LinearScale, LineElement, PointElement, LineController, Filler)

const DAY_MS = 86_400_000
const MAX_TICKS = 12

interface TimeAxis {
  tickValues: number[]
  formatTick: (ms: number) => string
  axisTitle: string
}

function buildTimeAxis(firstMs: number, lastMs: number): TimeAxis {
  const spanMs = lastMs - firstMs

  if (spanMs >= 90 * DAY_MS) {
    // Month boundaries: 1st of each month UTC
    const boundaries: number[] = []
    const d = new Date(firstMs)
    d.setUTCDate(1)
    d.setUTCHours(0, 0, 0, 0)
    if (d.getTime() < firstMs) d.setUTCMonth(d.getUTCMonth() + 1)
    while (d.getTime() <= lastMs) {
      boundaries.push(d.getTime())
      d.setUTCMonth(d.getUTCMonth() + 1)
    }
    const stride = Math.max(1, Math.ceil(boundaries.length / MAX_TICKS))
    const tickValues = boundaries.filter((_, i) => i % stride === 0)
    return {
      tickValues,
      formatTick: ms => {
        const t = new Date(ms)
        return `${String(t.getUTCFullYear())}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`
      },
      axisTitle: 'Time (months)',
    }
  }

  if (spanMs >= 21 * DAY_MS) {
    // ISO week boundaries: Monday 00:00 UTC
    const boundaries: number[] = []
    const d = new Date(firstMs)
    d.setUTCHours(0, 0, 0, 0)
    const dow = d.getUTCDay() || 7
    d.setUTCDate(d.getUTCDate() - dow + 1) // back to Monday
    if (d.getTime() < firstMs) d.setUTCDate(d.getUTCDate() + 7)
    while (d.getTime() <= lastMs) {
      boundaries.push(d.getTime())
      d.setUTCDate(d.getUTCDate() + 7)
    }
    const stride = Math.max(1, Math.ceil(boundaries.length / MAX_TICKS))
    const tickValues = boundaries.filter((_, i) => i % stride === 0)
    return {
      tickValues,
      formatTick: ms => new Date(ms).toISOString().slice(0, 10),
      axisTitle: 'Time (weeks)',
    }
  }

  // Day boundaries: midnight UTC
  const boundaries: number[] = []
  const d = new Date(firstMs)
  d.setUTCHours(0, 0, 0, 0)
  if (d.getTime() < firstMs) d.setUTCDate(d.getUTCDate() + 1)
  while (d.getTime() <= lastMs) {
    boundaries.push(d.getTime())
    d.setUTCDate(d.getUTCDate() + 1)
  }
  const stride = Math.max(1, Math.ceil(boundaries.length / MAX_TICKS))
  const tickValues = boundaries.filter((_, i) => i % stride === 0)
  return {
    tickValues,
    formatTick: ms => new Date(ms).toISOString().slice(0, 10),
    axisTitle: 'Time (days)',
  }
}

export async function renderTimeBasedEquityCurveChart(
  equity: number[],
  timestamps: string[],
  outputPath: string
): Promise<void> {
  if (equity.length < 2 || timestamps.length !== equity.length) return

  const first = timestamps[0]
  const last = timestamps[timestamps.length - 1]
  if (first === undefined || last === undefined) return
  const firstMs = new Date(first).getTime()
  const lastMs = new Date(last).getTime()
  const { tickValues, formatTick, axisTitle } = buildTimeAxis(firstMs, lastMs)

  const points = equity.map((y, i) => ({ x: new Date(timestamps[i] ?? first).getTime(), y }))

  const canvas = createCanvas(800, 340)
  const ctx = canvas.getContext('2d')

  const finalValue = equity[equity.length - 1] ?? 0
  const color = finalValue >= 0 ? 'rgb(34,197,94)' : 'rgb(239,68,68)'
  const fillColor = finalValue >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)'

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 800, 340)

  const chart = new Chart(ctx as never, {
    type: 'line',
    data: {
      datasets: [
        {
          data: points as never,
          borderColor: color,
          backgroundColor: fillColor,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.1,
          fill: true,
        },
      ],
    },
    options: {
      animation: false,
      responsive: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          type: 'linear',
          min: firstMs,
          max: lastMs,
          title: { display: true, text: axisTitle, color: '#888' },
          ticks: {
            color: '#888',
            autoSkip: false,
            maxRotation: 45,
            minRotation: 45,
            callback: value => formatTick(value as number),
          },
          afterBuildTicks: axis => {
            axis.ticks = tickValues.map(v => ({ value: v }))
          },
          grid: { color: '#333' },
        },
        y: {
          title: { display: true, text: 'Cumulative P&L', color: '#888' },
          ticks: { color: '#888' },
          grid: { color: '#333' },
        },
      },
    },
  })

  try {
    const buffer = canvas.toBuffer('image/png')
    await fs.promises.writeFile(outputPath, buffer)
  } finally {
    chart.destroy()
  }
}

export async function renderEquityCurveChart(equity: number[], outputPath: string): Promise<void> {
  if (equity.length < 2) return

  const canvas = createCanvas(800, 400)
  const ctx = canvas.getContext('2d')

  const finalValue = equity[equity.length - 1] ?? 0
  const color = finalValue >= 0 ? 'rgb(34,197,94)' : 'rgb(239,68,68)'
  const fillColor = finalValue >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)'

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 800, 400)

  const labels = equity.map((_, i) => String(i + 1))

  const chart = new Chart(ctx as never, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: equity,
          borderColor: color,
          backgroundColor: fillColor,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.1,
          fill: true,
        },
      ],
    },
    options: {
      animation: false,
      responsive: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          title: { display: true, text: 'Trade #', color: '#888' },
          ticks: {
            color: '#888',
            maxTicksLimit: 8,
          },
          grid: { color: '#333' },
        },
        y: {
          title: { display: true, text: 'Cumulative P&L', color: '#888' },
          ticks: { color: '#888' },
          grid: { color: '#333' },
        },
      },
    },
  })

  try {
    const buffer = canvas.toBuffer('image/png')
    await fs.promises.writeFile(outputPath, buffer)
  } finally {
    chart.destroy()
  }
}
