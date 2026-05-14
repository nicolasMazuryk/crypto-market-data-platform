import { config } from 'dotenv'
config()
import ccxt from 'ccxt'

async function run() {
  const ex = new (ccxt as any).gateio({ defaultType: 'swap', enableRateLimit: true })
  const rates = await ex.fetchFundingRates()
  const all = Object.values(rates as any)
  console.log('total:', all.length)
  const neg = (all as any[]).filter(t => t.fundingRate < 0)
    .sort((a: any, b: any) => a.fundingRate - b.fundingRate).slice(0, 10)
    .map((t: any) => `${t.symbol}: ${(t.fundingRate * 100).toFixed(4)}%`)
  const pos = (all as any[]).filter(t => t.fundingRate > 0)
    .sort((a: any, b: any) => b.fundingRate - a.fundingRate).slice(0, 5)
    .map((t: any) => `${t.symbol}: ${(t.fundingRate * 100).toFixed(4)}%`)
  console.log('neg:', neg)
  console.log('pos:', pos)
}
run().catch(console.error)
