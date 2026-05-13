import { createCanvas } from '@napi-rs/canvas'

import type { ChartConfig, FundingEvent, OrderbookRow } from './types.js'

const PALETTE = {
  bg: '#0d1117',
  grid: '#1e222d',
  axisText: '#787b86',
  headerText: '#d1d4dc',
  bidUp: '#26a69a',
  bidDown: '#ef5350',
  fundingLine: '#7aa2ff',
  fibLine: '#3a4055',
  fibLabel: '#9aa3b8',
  badgeBorder: '#30363d',
  badgeBg: '#161b22',
  positiveRate: '#26a69a',
  negativeRate: '#ef5350',
} as const

const MARGIN = { top: 60, right: 55, bottom: 50, left: 12 } as const

function hp(x: number): number {
  return Math.floor(x) + 0.5
}

export function renderChart(event: FundingEvent, rows: OrderbookRow[], config: ChartConfig): Buffer {
  const W = config.image_width
  const H = config.image_height
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  const plotX = MARGIN.left
  const plotY = MARGIN.top
  const plotW = W - MARGIN.left - MARGIN.right
  const plotH = H - MARGIN.top - MARGIN.bottom

  ctx.fillStyle = PALETTE.bg
  ctx.fillRect(0, 0, W, H)

  const fundingTimeSec = Math.floor(event.funding_time.getTime() / 1000)
  const windowStart = fundingTimeSec - config.pre_seconds
  const numCandles = config.pre_seconds + config.post_seconds + 1
  const slotWidth = plotW / numCandles
  const t0Index = config.pre_seconds

  if (rows.length === 0) {
    ctx.fillStyle = PALETTE.axisText
    ctx.font = '14px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('no orderbook data', plotX + plotW / 2, plotY + plotH / 2)
    drawHeader(ctx, event, W, plotX, PALETTE)
    return canvas.toBuffer('image/png')
  }

  // Build ts -> row lookup
  const rowMap = new Map<number, OrderbookRow>()
  for (const row of rows) {
    rowMap.set(Math.floor(row.ts.getTime() / 1000), row)
  }

  // Compute price range
  let yMin = Infinity
  let yMax = -Infinity
  let chartHigh = -Infinity
  let chartLow = Infinity

  for (const row of rows) {
    const bl = row.bid_low
    const bh = row.bid_high
    const bo = row.bid_open
    const bc = row.bid_close
    const al = row.ask_low
    const ah = row.ask_high
    const ao = row.ask_open
    const ac = row.ask_close

    if (bl !== null && isFinite(bl)) {
      yMin = Math.min(yMin, bl)
      chartLow = Math.min(chartLow, bl)
    }
    if (bh !== null && isFinite(bh)) {
      yMax = Math.max(yMax, bh)
      chartHigh = Math.max(chartHigh, bh)
    }
    if (bo !== null && isFinite(bo)) yMin = Math.min(yMin, bo)
    if (bc !== null && isFinite(bc)) yMin = Math.min(yMin, bc)
    if (al !== null && isFinite(al)) yMin = Math.min(yMin, al)
    if (ah !== null && isFinite(ah)) {
      yMax = Math.max(yMax, ah)
      chartHigh = Math.max(chartHigh, ah)
    }
    if (ao !== null && isFinite(ao)) yMax = Math.max(yMax, ao)
    if (ac !== null && isFinite(ac)) yMax = Math.max(yMax, ac)
  }

  if (!isFinite(yMin) || !isFinite(yMax)) {
    yMin = 0
    yMax = 1
  }

  const yRange = yMax - yMin || 1
  const pad = yRange * 0.04
  yMin -= pad
  yMax += pad

  const toY = (price: number): number => plotY + ((yMax - price) / (yMax - yMin)) * plotH

  // Fib ladder (drawn before candles)
  const t0Row = rowMap.get(fundingTimeSec)
  const fibTop =
    t0Row?.bid_open !== null && t0Row?.bid_open !== undefined && isFinite(t0Row.bid_open) ? t0Row.bid_open : chartHigh

  if (config.show_fib_ladder && isFinite(fibTop) && isFinite(chartLow) && fibTop !== chartLow) {
    const totalDropPct = ((chartLow - fibTop) / fibTop) * 100
    const fractions = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]

    ctx.save()
    ctx.globalAlpha = 0.7
    ctx.strokeStyle = PALETTE.fibLine
    ctx.setLineDash([2, 4])
    ctx.lineWidth = 1

    for (let fi = 0; fi < fractions.length; fi++) {
      const t = fractions[fi] ?? 0
      const price = fibTop + t * (chartLow - fibTop)
      const y = hp(toY(price))

      ctx.beginPath()
      ctx.moveTo(plotX, y)
      ctx.lineTo(plotX + plotW, y)
      ctx.stroke()

      if (fi > 0) {
        const labelPct = totalDropPct * t
        const sign = labelPct >= 0 ? '+' : ''
        ctx.fillStyle = PALETTE.fibLabel
        ctx.font = '11px monospace'
        ctx.textAlign = 'right'
        ctx.fillText(`${sign}${labelPct.toFixed(2)}%`, plotX + plotW - 2, y - 3)
        ctx.textAlign = 'left'
        ctx.fillText(`${sign}${labelPct.toFixed(2)}%`, plotX + 2, y - 3)
      }
    }
    ctx.restore()
  }

  // Funding event line at T₀
  const t0SlotLeft = plotX + t0Index * slotWidth
  const t0CenterX = hp(t0SlotLeft + slotWidth / 2)

  ctx.save()
  ctx.globalAlpha = 0.75
  ctx.strokeStyle = PALETTE.fundingLine
  ctx.setLineDash([4, 3])
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(t0CenterX, plotY)
  ctx.lineTo(t0CenterX, plotY + plotH)
  ctx.stroke()
  ctx.restore()

  ctx.fillStyle = PALETTE.fundingLine
  ctx.font = 'bold 11px monospace'
  ctx.textAlign = 'center'
  ctx.fillText('T0', t0CenterX, plotY - 4)

  // Candles
  const halfSlot = slotWidth / 2
  const bodyW = Math.max(1, Math.floor(halfSlot) - 1)

  // Pass 1: bid candles (filled)
  for (let i = 0; i < numCandles; i++) {
    const row = rowMap.get(windowStart + i)
    if (!row) continue
    const { bid_open: bo, bid_close: bc, bid_high: bh, bid_low: bl } = row
    if (bo === null || bc === null || bh === null || bl === null) continue
    if (!isFinite(bo) || !isFinite(bc) || !isFinite(bh) || !isFinite(bl)) continue

    const slotLeft = plotX + i * slotWidth
    const halfCenter = hp(slotLeft + halfSlot / 2)
    const color = bc >= bo ? PALETTE.bidUp : PALETTE.bidDown

    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1

    // Wick
    ctx.beginPath()
    ctx.moveTo(halfCenter, hp(toY(bh)))
    ctx.lineTo(halfCenter, hp(toY(bl)))
    ctx.stroke()

    // Body
    const openY = toY(bo)
    const closeY = toY(bc)
    const bodyTop = Math.min(openY, closeY)
    const bodyBot = Math.max(openY, closeY)
    const bodyH = bodyBot - bodyTop
    const bodyLeft = hp(halfCenter - bodyW / 2)

    if (bodyH < 1) {
      ctx.beginPath()
      ctx.moveTo(bodyLeft, hp(openY))
      ctx.lineTo(bodyLeft + bodyW, hp(openY))
      ctx.stroke()
    } else {
      ctx.fillRect(bodyLeft, bodyTop, bodyW, bodyH)
    }
  }

  // Pass 2: ask candles (hollow)
  for (let i = 0; i < numCandles; i++) {
    const row = rowMap.get(windowStart + i)
    if (!row) continue
    const { ask_open: ao, ask_close: ac, ask_high: ah, ask_low: al } = row
    if (ao === null || ac === null || ah === null || al === null) continue
    if (!isFinite(ao) || !isFinite(ac) || !isFinite(ah) || !isFinite(al)) continue

    const slotLeft = plotX + i * slotWidth
    const askHalfStart = slotLeft + halfSlot
    const halfCenter = hp(askHalfStart + halfSlot / 2)
    const color = ac >= ao ? PALETTE.bidUp : PALETTE.bidDown

    ctx.strokeStyle = color
    ctx.lineWidth = 1

    // Wick
    ctx.beginPath()
    ctx.moveTo(halfCenter, hp(toY(ah)))
    ctx.lineTo(halfCenter, hp(toY(al)))
    ctx.stroke()

    // Body (hollow)
    const openY = toY(ao)
    const closeY = toY(ac)
    const bodyTop = Math.min(openY, closeY)
    const bodyBot = Math.max(openY, closeY)
    const bodyH = bodyBot - bodyTop
    const bodyLeft = hp(halfCenter - bodyW / 2)

    ctx.lineWidth = 1.5
    if (bodyH < 1.5) {
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(bodyLeft, hp(openY))
      ctx.lineTo(bodyLeft + bodyW, hp(openY))
      ctx.stroke()
    } else {
      ctx.fillStyle = PALETTE.bg
      ctx.fillRect(bodyLeft, bodyTop, bodyW, bodyH)
      ctx.strokeRect(bodyLeft, bodyTop, bodyW, bodyH)
    }
  }

  // Bottom time axis
  const timeTickInterval = 10
  for (let i = 0; i < numCandles; i++) {
    const sec = windowStart + i
    const relSec = sec - fundingTimeSec
    if (relSec % timeTickInterval !== 0) continue

    const x = hp(plotX + (i + 0.5) * slotWidth)
    const d = new Date(sec * 1000)
    const hh = d.getUTCHours().toString().padStart(2, '0')
    const mm = d.getUTCMinutes().toString().padStart(2, '0')
    const ss = d.getUTCSeconds().toString().padStart(2, '0')
    const label = `${hh}:${mm}:${ss}`
    const isT0 = relSec === 0

    ctx.fillStyle = isT0 ? PALETTE.fundingLine : PALETTE.axisText
    ctx.font = isT0 ? 'bold 11px monospace' : '11px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(label, x, plotY + plotH + 16)

    ctx.strokeStyle = PALETTE.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, plotY + plotH)
    ctx.lineTo(x, plotY + plotH + 4)
    ctx.stroke()
  }

  // Plot border
  ctx.strokeStyle = PALETTE.grid
  ctx.lineWidth = 1
  ctx.strokeRect(hp(plotX), hp(plotY), plotW, plotH)

  drawHeader(ctx, event, W, plotX, PALETTE)

  return canvas.toBuffer('image/png')
}

function drawHeader(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  event: FundingEvent,
  W: number,
  plotX: number,
  palette: typeof PALETTE
): void {
  const t0Str = event.funding_time.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

  ctx.fillStyle = palette.headerText
  ctx.font = 'bold 16px monospace'
  ctx.textAlign = 'left'
  ctx.fillText(`${event.symbol} · ${event.exchange}`, plotX + 4, 20)
  ctx.font = '14px monospace'
  ctx.fillText(`T₀  ${t0Str}`, plotX + 4, 38)

  // Funding rate badge
  const ratePercent = event.funding_rate * 100
  const sign = ratePercent >= 0 ? '+' : ''
  const rateStr = `${sign}${ratePercent.toFixed(3)}%`
  const badgeColor = ratePercent < 0 ? palette.negativeRate : palette.positiveRate

  const badgeW = 130
  const badgeH = 52
  const badgeX = W - MARGIN.right - badgeW - 4
  const badgeY = 4

  ctx.fillStyle = palette.badgeBg
  ctx.fillRect(badgeX, badgeY, badgeW, badgeH)
  ctx.strokeStyle = palette.badgeBorder
  ctx.lineWidth = 0.5
  ctx.strokeRect(badgeX, badgeY, badgeW, badgeH)

  ctx.fillStyle = palette.axisText
  ctx.font = '10px monospace'
  ctx.textAlign = 'center'
  ctx.fillText('FUNDING RATE', badgeX + badgeW / 2, badgeY + 16)

  ctx.fillStyle = badgeColor
  ctx.font = 'bold 18px monospace'
  ctx.fillText(rateStr, badgeX + badgeW / 2, badgeY + 38)
}
