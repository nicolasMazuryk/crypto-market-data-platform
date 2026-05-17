/**
 * Task 4 sizing validation — runtime verification against real Binance market data.
 *
 * Verifies three fixes:
 *  4a — float precision: computeOrderQty returns clean float (no 13.200000000000001 artifacts)
 *  4c — ladder notional: per-rung meetsMinNotional rejects low-notional rungs for Binance IRYSUSDT/SIGNUSDT
 *  4b — strategy_6: meetsMinNotional guards pre-funding qty against stale-price notional failures
 *
 * Config matches production binance/strategy_4_1a: amountUsd=20, ladderCount=5, leverage=5
 *
 * Usage:
 *   source <(bash scripts/exchange-subkey.sh binance strategy_4_1a)
 *   npx tsx scripts/verify-task4-sizing.ts
 */

import ccxt from 'ccxt'
import { alignToLotStep, computeMinOrderQty, computeOrderQty, lotStep, meetsMinNotional } from '../src/execution/strategies/shared/sizing.js'
import type { MarketMetadata } from '../src/execution/markets/types.js'

// Production config for binance/strategy_4_1a
const AMOUNT_USD = 20
const LEVERAGE = 5
const LADDER_COUNT = 5
const LADDER_TOP_MULT = 0.7
const LADDER_BOTTOM_MULT = 1.8
const SIMULATED_FUNDING_RATE_PCT = -0.1 // typical threshold

// Symbols from bug reports (binance/strategy_4_1a — 9/9 intents all failed)
const TARGET_SYMBOLS = ['IRYS/USDT:USDT', 'SIGN/USDT:USDT', 'BTC/USDT:USDT', 'ETH/USDT:USDT']

function ccxtMarketToMetadata(m: ccxt.Market, exchange: string): MarketMetadata {
  const precision = m.precision as { amount?: number; price?: number }
  const limits = m.limits as {
    amount?: { min?: number; max?: number }
    cost?: { min?: number }
    price?: { min?: number; max?: number }
  }

  return {
    exchange: exchange as MarketMetadata['exchange'],
    symbol: m.id ?? '',
    exchangeSymbol: m.id ?? '',
    contractSize: (m.contractSize as number | null | undefined) ?? 1,
    pricePrecision: precision.price ?? 8,
    amountPrecision: precision.amount ?? 1,
    minAmount: limits.amount?.min,
    maxAmount: limits.amount?.max,
    minCost: limits.cost?.min,
    makerFee: (m.maker as number | null | undefined) ?? 0.0002,
    takerFee: (m.taker as number | null | undefined) ?? 0.0004,
    status: m.active === false ? 'delisted' : 'trading',
  }
}

function sep(label: string) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 70 - label.length))}\n`)
}

async function main() {
  console.log('=== Task 4 Sizing Validation — Runtime Verification (Binance) ===')

  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_SECRET_KEY
  if (!apiKey || !apiSecret) {
    console.error('Missing BINANCE_API_KEY / BINANCE_SECRET_KEY — source scripts/exchange-subkey.sh first')
    process.exit(1)
  }

  const ex = new ccxt.binanceusdm({ apiKey, secret: apiSecret })
  console.log('\nFetching markets + tickers from Binance...')
  await ex.loadMarkets()
  const tickers = await ex.fetchTickers(TARGET_SYMBOLS)

  // ─── 4a: Float precision ────────────────────────────────────────────────────
  sep('4a: Float Precision Fix')
  console.log('IEEE 754 artifact demo: 132 * 0.1 in JavaScript')
  const raw = 132 * 0.1
  console.log(`  raw artifact:  ${raw}  (String: "${String(raw)}")`)
  console.log('  roundDownToStep with toFixed fix: should produce "13.2"\n')

  let floatOk = true
  for (const sym of TARGET_SYMBOLS) {
    const m = ex.markets[sym]
    if (!m) continue
    const mkt = ccxtMarketToMetadata(m, 'binance')
    const t = tickers[sym]
    const price = t?.last ?? 0
    if (!price) continue

    const qty = computeOrderQty(AMOUNT_USD, price, LEVERAGE, mkt)
    if (qty === null) continue

    const qtyStr = String(qty)
    const hasArtifact = /\d{6}/.test(qtyStr) // long run of digits = artifact
    if (hasArtifact) floatOk = false
    console.log(
      `  ${sym.split('/')[0]}: price=$${price}, step=${mkt.amountPrecision}, qty=${qty} → "${qtyStr}" ${hasArtifact ? '❌ ARTIFACT' : '✓'}`
    )
  }
  console.log(floatOk ? '\n  ✓ All qty values clean — no IEEE 754 artifacts.' : '\n  ❌ Artifacts found!')

  // ─── 4c: Ladder per-rung notional ───────────────────────────────────────────
  sep(`4c: Ladder Notional Guard  [amountUsd=$${AMOUNT_USD}, ladderCount=${LADDER_COUNT}]`)

  const absF = Math.abs(SIMULATED_FUNDING_RATE_PCT)
  const topOffset = absF * LADDER_TOP_MULT
  const bottomOffset = absF * LADDER_BOTTOM_MULT

  let totalSkipped = 0
  let totalPlaced = 0
  let symbolsFiltered = 0

  for (const sym of TARGET_SYMBOLS) {
    const m = ex.markets[sym]
    if (!m) { console.log(`  ${sym}: not found`); continue }
    const mkt = ccxtMarketToMetadata(m, 'binance')
    const t = tickers[sym]
    const price = t?.last ?? 0
    if (!price) continue

    const qty = computeOrderQty(AMOUNT_USD, price, LEVERAGE, mkt)
    if (qty === null) {
      console.log(`  ${sym.split('/')[0]}: computeOrderQty=null (below minAmount/minCost at full size)\n`)
      continue
    }

    const step = lotStep(mkt.amountPrecision)
    const baseQty = Math.floor(qty / LADDER_COUNT / step) * step
    const remainder = Math.round((qty - baseQty * LADDER_COUNT) / step)
    const rungs = Array.from({ length: LADDER_COUNT }, (_, i) => {
      const rungQty = baseQty + (i < remainder ? step : 0)
      const priceOffsetPct =
        LADDER_COUNT === 1 ? topOffset : topOffset + (i * (bottomOffset - topOffset)) / (LADDER_COUNT - 1)
      return { priceOffsetPct, qtyFraction: rungQty / qty }
    })

    // Strategy-level early exit (task req #3: skip symbols where max rung fails)
    const firstRung = rungs[0]
    const topLimitPrice = firstRung ? price * (1 - firstRung.priceOffsetPct / 100) : price
    const maxRungQty = firstRung ? alignToLotStep(qty * firstRung.qtyFraction, mkt) : 0
    const strategyFilters = firstRung !== undefined && !meetsMinNotional(maxRungQty, topLimitPrice, mkt)
    if (strategyFilters) symbolsFiltered++

    console.log(`  ${sym.split('/')[0]}: price=$${price.toPrecision(4)}, minCost=$${mkt.minCost ?? 'n/a'}, step=${step}`)
    console.log(`    totalQty=${qty}, baseQty=${baseQty}, remainder=${remainder}`)
    console.log(`    strategy_4_1a early exit: ${strategyFilters ? '❌ FILTERED — max rung fails minNotional' : '✓ passes strategy filter'}`)

    for (let i = 0; i < rungs.length; i++) {
      const rung = rungs[i]!
      const rungQty = alignToLotStep(qty * rung.qtyFraction, mkt)
      const limitPrice = price * (1 - rung.priceOffsetPct / 100)
      const notional = rungQty * (mkt.contractSize > 0 ? mkt.contractSize : 1) * limitPrice
      const passes = meetsMinNotional(rungQty, limitPrice, mkt)
      if (passes) totalPlaced++
      else totalSkipped++
      console.log(
        `    rung[${i}]: qty=${rungQty}, limitPrice=$${limitPrice.toPrecision(4)}, notional=$${notional.toFixed(3)} → ${passes ? '✓ submit' : `❌ skip (< $${mkt.minCost})`}`
      )
    }
    console.log()
  }

  console.log(`  Summary: ${totalPlaced} rungs would submit, ${totalSkipped} rungs skipped by minNotional guard, ${symbolsFiltered} symbol(s) filtered by strategy-level guard.`)
  if (totalSkipped > 0 || symbolsFiltered > 0) {
    console.log('  ✓ Guard is firing correctly for low-notional symbols.')
  } else {
    console.log('  (No symbols triggered guard at current prices — market conditions may have changed.)')
  }

  // ─── 4b: Strategy_6 pre-funding notional ────────────────────────────────────
  sep('4b: Strategy_6 Pre-Funding Notional Guard')
  console.log('computeMinOrderQty determines pre-funding qty at evaluation time.')
  console.log('meetsMinNotional at submission time guards against price drift.\n')

  for (const sym of TARGET_SYMBOLS) {
    const m = ex.markets[sym]
    if (!m) continue
    const mkt = ccxtMarketToMetadata(m, 'binance')
    const t = tickers[sym]
    const price = t?.last ?? 0
    if (!price) continue

    const preFundingQty = computeMinOrderQty(mkt, price)
    if (preFundingQty === null) {
      console.log(`  ${sym.split('/')[0]}: computeMinOrderQty=null at price=$${price}`)
      continue
    }

    const notional = preFundingQty * price
    const passes = meetsMinNotional(preFundingQty, price, mkt)
    console.log(
      `  ${sym.split('/')[0]}: price=$${price.toPrecision(4)}, minCost=$${mkt.minCost ?? 'n/a'}, preFundingQty=${preFundingQty}, notional=$${notional.toFixed(3)} → ${passes ? '✓ guard passes' : '❌ guard aborts'}`
    )

    // Simulate price drop during window between evaluation and submission
    const dropPct = 30
    const dropPrice = price * (1 - dropPct / 100)
    const passesAfterDrop = meetsMinNotional(preFundingQty, dropPrice, mkt)
    if (!passesAfterDrop) {
      const dropNotional = preFundingQty * dropPrice
      console.log(
        `    at -${dropPct}% (price=$${dropPrice.toPrecision(4)}): notional=$${dropNotional.toFixed(3)} → ❌ guard would abort (stale-price protection)`
      )
    }
  }

  console.log('\n=== Verification complete ===\n')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
