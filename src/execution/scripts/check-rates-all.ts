import { config } from 'dotenv'
config()
import ccxt from 'ccxt'

const checks = [
  { id: 'binanceusdm', name: 'binance', opts: { apiKey: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_API_SECRET } },
  { id: 'bybit', name: 'bybit', opts: { defaultType: 'swap', apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET } },
  { id: 'okx', name: 'okx', opts: { apiKey: process.env.OKX_API_KEY, secret: process.env.OKX_API_SECRET, password: process.env.OKX_API_PASS } },
  { id: 'kucoinfutures', name: 'kucoin', opts: { apiKey: process.env.KUCOIN_API_KEY, secret: process.env.KUCOIN_API_SECRET, password: process.env.KUCOIN_API_PASS } },
  { id: 'bitget', name: 'bitget', opts: { defaultType: 'swap', apiKey: process.env.BITGET_API_KEY, secret: process.env.BITGET_API_SECRET, password: process.env.BITGET_API_PASS } },
  { id: 'gateio', name: 'gateio', opts: { defaultType: 'swap', apiKey: process.env.GATEIO_API_KEY, secret: process.env.GATEIO_API_SECRET } },
]

for (const cfg of checks) {
  try {
    const registry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => any>
    const ex = new registry[cfg.id]!({ ...cfg.opts, enableRateLimit: true })
    const rates = await ex.fetchFundingRates() as Record<string, any>
    const all = Object.values(rates)
    const threshold = -0.00005
    const neg = all.filter((t: any) => t.fundingRate < threshold).sort((a: any, b: any) => a.fundingRate - b.fundingRate)
    console.log(`[${cfg.name}] ${neg.length} symbols below ${(threshold*100).toFixed(3)}%:`, neg.slice(0, 5).map((t: any) => `${t.symbol}: ${(t.fundingRate * 100).toFixed(4)}%`).join(', '))
  } catch (e: any) {
    console.log(`[${cfg.name}] error: ${String(e.message).slice(0, 80)}`)
  }
}
