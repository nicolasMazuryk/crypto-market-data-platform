import { config } from 'dotenv'
config()
import ccxt from 'ccxt'

const exchanges = [
  { name: 'gateio', ccxtId: 'gateio', apiKey: process.env.GATEIO_API_KEY!, apiSecret: process.env.GATEIO_API_SECRET!, options: { defaultType: 'swap' } },
  { name: 'bybit', ccxtId: 'bybit', apiKey: process.env.BYBIT_API_KEY!, apiSecret: process.env.BYBIT_API_SECRET!, options: { defaultType: 'swap' } },
  { name: 'binance', ccxtId: 'binanceusdm', apiKey: process.env.BINANCE_API_KEY!, apiSecret: process.env.BINANCE_API_SECRET!, options: {} },
  { name: 'okx', ccxtId: 'okx', apiKey: process.env.OKX_API_KEY!, apiSecret: process.env.OKX_API_SECRET!, password: process.env.OKX_API_PASS, options: {} },
  { name: 'kucoin', ccxtId: 'kucoinfutures', apiKey: process.env.KUCOIN_API_KEY!, apiSecret: process.env.KUCOIN_API_SECRET!, password: process.env.KUCOIN_API_PASS, options: {} },
  { name: 'bitget', ccxtId: 'bitget', apiKey: process.env.BITGET_API_KEY!, apiSecret: process.env.BITGET_API_SECRET!, password: process.env.BITGET_API_PASS, options: { defaultType: 'swap' } },
]

for (const cfg of exchanges) {
  const registry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => any>
  const ex = new registry[cfg.ccxtId]!({ apiKey: cfg.apiKey, secret: cfg.apiSecret, password: (cfg as any).password, defaultType: 'swap', enableRateLimit: true })
  const pos = await ex.fetchPositions()
  const open = (pos as any[]).filter(p => Math.abs(p.contracts ?? 0) > 0)
  if (open.length > 0) {
    console.log(`[${cfg.name}] OPEN POSITIONS:`, JSON.stringify(open.map((p: any) => ({ symbol: p.symbol, side: p.side, contracts: p.contracts, entryPrice: p.entryPrice })), null, 2))
  } else {
    console.log(`[${cfg.name}] no open positions`)
  }
}
