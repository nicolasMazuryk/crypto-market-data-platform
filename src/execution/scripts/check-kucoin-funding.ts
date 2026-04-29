import { createKucoinPuller } from '../funding/kucoin.js'

async function main() {
  const puller = createKucoinPuller()
  const snapshots = await puller.pull()
  const sorted = snapshots
    .filter(s => s.fundingRate < 0)
    .sort((a, b) => a.fundingRate - b.fundingRate)
    .slice(0, 8)
  console.log('KuCoin negative funding:')
  for (const s of sorted) {
    console.log(`  ${s.symbol} (${s.exchangeSymbol}) rate=${(s.fundingRatePercent).toFixed(4)}% next=${s.nextFundingDatetime}`)
  }
  console.log(`Total snapshots: ${snapshots.length}, negative: ${snapshots.filter(s => s.fundingRate < 0).length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
