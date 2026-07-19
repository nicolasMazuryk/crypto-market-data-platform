import { config } from 'dotenv'
config()
import ccxt from 'ccxt'
import type { CcxtExchange } from '../../exchanges/types.js'

async function run() {
  const registry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => CcxtExchange>
  const Cls = registry.gateio
  if (!Cls) throw new Error('CCXT class not found: gateio')
  const ex = new Cls({ defaultType: 'swap', enableRateLimit: true })
  if (!ex.fetchFundingRates) throw new Error('fetchFundingRates not supported')
  const rates = await ex.fetchFundingRates()
  const all = Object.values(rates)
  console.log('total:', all.length)
  const neg = all
    .filter(t => (t.fundingRate ?? 0) < 0)
    .sort((a, b) => (a.fundingRate ?? 0) - (b.fundingRate ?? 0))
    .slice(0, 10)
    .map(t => `${t.symbol}: ${((t.fundingRate ?? 0) * 100).toFixed(4)}%`)
  const pos = all
    .filter(t => (t.fundingRate ?? 0) > 0)
    .sort((a, b) => (b.fundingRate ?? 0) - (a.fundingRate ?? 0))
    .slice(0, 5)
    .map(t => `${t.symbol}: ${((t.fundingRate ?? 0) * 100).toFixed(4)}%`)
  console.log('neg:', neg)
  console.log('pos:', pos)
}
run().catch(console.error)
