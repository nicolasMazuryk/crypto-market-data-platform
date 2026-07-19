import { config } from 'dotenv'
config()
import ccxt from 'ccxt'
import type { CcxtExchange } from '../../exchanges/types.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set`)
  return value
}

interface FundingCheckConfig {
  id: string
  name: string
  opts: Record<string, unknown>
}

const checks: FundingCheckConfig[] = [
  {
    id: 'binanceusdm',
    name: 'binance',
    opts: { apiKey: requireEnv('BINANCE_API_KEY'), secret: requireEnv('BINANCE_API_SECRET') },
  },
  {
    id: 'bybit',
    name: 'bybit',
    opts: { defaultType: 'swap', apiKey: requireEnv('BYBIT_API_KEY'), secret: requireEnv('BYBIT_API_SECRET') },
  },
  {
    id: 'okx',
    name: 'okx',
    opts: {
      apiKey: requireEnv('OKX_API_KEY'),
      secret: requireEnv('OKX_API_SECRET'),
      password: process.env.OKX_API_PASS,
    },
  },
  {
    id: 'kucoinfutures',
    name: 'kucoin',
    opts: {
      apiKey: requireEnv('KUCOIN_API_KEY'),
      secret: requireEnv('KUCOIN_API_SECRET'),
      password: process.env.KUCOIN_API_PASS,
    },
  },
  {
    id: 'bitget',
    name: 'bitget',
    opts: {
      defaultType: 'swap',
      apiKey: requireEnv('BITGET_API_KEY'),
      secret: requireEnv('BITGET_API_SECRET'),
      password: process.env.BITGET_API_PASS,
    },
  },
  {
    id: 'gateio',
    name: 'gateio',
    opts: { defaultType: 'swap', apiKey: requireEnv('GATEIO_API_KEY'), secret: requireEnv('GATEIO_API_SECRET') },
  },
]

for (const cfg of checks) {
  try {
    const registry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => CcxtExchange>
    const Cls = registry[cfg.id]
    if (!Cls) throw new Error(`CCXT class not found: ${cfg.id}`)
    const ex = new Cls({ ...cfg.opts, enableRateLimit: true })
    if (!ex.fetchFundingRates) throw new Error(`${cfg.name}: fetchFundingRates not supported`)
    const rates = await ex.fetchFundingRates()
    const all = Object.values(rates)
    const threshold = -0.00005
    const neg = all
      .filter(t => (t.fundingRate ?? 0) < threshold)
      .sort((a, b) => (a.fundingRate ?? 0) - (b.fundingRate ?? 0))
    console.log(
      `[${cfg.name}] ${String(neg.length)} symbols below ${(threshold * 100).toFixed(3)}%:`,
      neg
        .slice(0, 5)
        .map(t => `${t.symbol}: ${((t.fundingRate ?? 0) * 100).toFixed(4)}%`)
        .join(', ')
    )
  } catch (e) {
    console.log(`[${cfg.name}] error: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`)
  }
}
