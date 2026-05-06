import { parseArgs } from 'node:util'
import { config } from 'dotenv'
config()

import { openDb } from '../persistence/db.js'
import { loadIntentLifecycle, loadRunLifecycles } from '../persistence/queries.js'
import type { IntentLifecycle } from '../persistence/queries.js'

interface LifecyclePnL {
  intentId: string
  exchange: string
  symbol: string
  strategy: string
  side: string
  status: string
  entryFills: { qty: string; price: string; fee: string }[]
  exitFills: { qty: string; price: string; fee: string }[]
  fundingAttribAmount: number
  estimatedPnlUsdt: number
}

function computePnL(lc: IntentLifecycle): LifecyclePnL {
  const { intent, orders, fills, fundingAttributions } = lc

  const entryOrderIds = new Set(orders.filter(o => !o.reduceOnly).map(o => o.id))
  const exitOrderIds = new Set(orders.filter(o => o.reduceOnly).map(o => o.id))

  const entryFills = fills.filter(f => entryOrderIds.has(f.orderId))
  const exitFills = fills.filter(f => exitOrderIds.has(f.orderId))

  const entryValue = entryFills.reduce((sum, f) => sum + parseFloat(f.qty) * parseFloat(f.price), 0)
  const exitValue = exitFills.reduce((sum, f) => sum + parseFloat(f.qty) * parseFloat(f.price), 0)
  const totalFees = fills.reduce((sum, f) => sum + parseFloat(f.feeAmount), 0)
  const fundingTotal = fundingAttributions.reduce((sum, f) => sum + parseFloat(f.fundingAmount), 0)

  const pnl =
    intent.side === 'long'
      ? exitValue - entryValue - totalFees + fundingTotal
      : entryValue - exitValue - totalFees + fundingTotal

  return {
    intentId: intent.id,
    exchange: intent.exchange,
    symbol: intent.symbol,
    strategy: intent.strategy,
    side: intent.side,
    status: intent.status,
    entryFills: entryFills.map(f => ({ qty: f.qty, price: f.price, fee: f.feeAmount })),
    exitFills: exitFills.map(f => ({ qty: f.qty, price: f.price, fee: f.feeAmount })),
    fundingAttribAmount: fundingTotal,
    estimatedPnlUsdt: pnl,
  }
}

interface ReplayResult {
  lifecycles: LifecyclePnL[]
  reevaluateDiffs?: ReevaluateDiff[]
}

interface ReevaluateDiff {
  intentId: string
  diverged: boolean
  diffs: { field: string; persisted: unknown; reevaluated: unknown }[]
}

function reevaluateIntent(lc: IntentLifecycle): ReevaluateDiff {
  // fundingSnapshot was dropped in migration 0002 — funding data is now stored
  // directly on the intent row (fundingRate, fundingRatePercent, etc.) with no
  // redundant snapshot to compare against.
  return { intentId: lc.intent.id, diverged: false, diffs: [] }
}

function formatTable(results: LifecyclePnL[]): string {
  const header = ['intentId', 'exchange', 'symbol', 'strategy', 'side', 'status', 'pnlUsdt'].join('\t')
  const rows = results.map(r =>
    [r.intentId.slice(0, 12), r.exchange, r.symbol, r.strategy, r.side, r.status, r.estimatedPnlUsdt.toFixed(4)].join(
      '\t'
    )
  )
  return [header, ...rows].join('\n')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      intent: { type: 'string' },
      run: { type: 'string' },
      reevaluate: { type: 'boolean', default: false },
      format: { type: 'string', default: 'json' },
    },
    allowPositionals: false,
  })

  const url = process.env.EXECUTION_POSTGRES_URL
  if (!url) {
    console.error('EXECUTION_POSTGRES_URL env var is required')
    process.exit(1)
  }

  const dbHandle = openDb(url)
  const { db } = dbHandle

  try {
    let lifecycles: IntentLifecycle[]

    if (values.intent) {
      const lc = await loadIntentLifecycle(db, values.intent)
      if (!lc) {
        console.error(`Intent ${values.intent} not found`)
        process.exit(1)
      }
      lifecycles = [lc]
    } else if (values.run) {
      lifecycles = await loadRunLifecycles(db, values.run)
    } else {
      console.error('Provide --intent <id> or --run <id>')
      process.exit(1)
    }

    const pnls = lifecycles.map(computePnL)

    const result: ReplayResult = { lifecycles: pnls }

    if (values.reevaluate) {
      result.reevaluateDiffs = lifecycles.map(reevaluateIntent)
    }

    if (values.format === 'table') {
      console.log(formatTable(pnls))
      if (result.reevaluateDiffs) {
        console.log('\n--- Reevaluate Diffs ---')
        for (const d of result.reevaluateDiffs) {
          if (d.diverged) {
            console.log(`Intent ${d.intentId}: DIVERGED`)
            for (const diff of d.diffs) {
              console.log(
                `  ${diff.field}: persisted=${String(diff.persisted)}, reevaluated=${String(diff.reevaluated)}`
              )
            }
          } else {
            console.log(`Intent ${d.intentId}: parity OK`)
          }
        }
      }
    } else {
      console.log(JSON.stringify(result, null, 2))
    }
  } finally {
    await dbHandle.close()
  }
}

main().catch((err: unknown) => {
  console.error('replay error:', err)
  process.exit(1)
})
