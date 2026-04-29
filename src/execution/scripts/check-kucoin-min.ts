import { createKucoinPuller } from '../funding/kucoin.js'

async function main() {
  const puller = createKucoinPuller()
  const snapshots = await puller.pull()
  const sorted = snapshots.sort((a, b) => a.fundingRate - b.fundingRate)
  console.log('KuCoin 10 lowest rates (all positive):')
  for (const s of sorted.slice(0, 10)) {
    console.log(`  ${s.symbol}: ${s.fundingRatePercent.toFixed(6)}%`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
