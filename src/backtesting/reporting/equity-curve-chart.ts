import fs from 'fs'

import { createCanvas } from '@napi-rs/canvas'
import {
  CategoryScale,
  Chart,
  Filler,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
} from 'chart.js'

Chart.register(CategoryScale, LinearScale, LineElement, PointElement, LineController, Filler)

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
