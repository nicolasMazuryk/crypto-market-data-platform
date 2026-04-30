import ccxt from 'ccxt'

const exchanges = [
  { id: 'gateio',  ccxtId: 'gate',          key: process.env.GATEIO_API_KEY!,  secret: process.env.GATEIO_API_SECRET!,  pass: undefined },
  { id: 'okx',     ccxtId: 'okx',            key: process.env.OKX_API_KEY!,     secret: process.env.OKX_API_SECRET!,     pass: process.env.OKX_API_PASSPHRASE },
  { id: 'bitget',  ccxtId: 'bitget',         key: process.env.BITGET_API_KEY!,  secret: process.env.BITGET_API_SECRET!,  pass: process.env.BITGET_API_PASSPHRASE },
  { id: 'kucoin',  ccxtId: 'kucoinfutures',  key: process.env.KUCOIN_API_KEY!,  secret: process.env.KUCOIN_API_SECRET!,  pass: process.env.KUCOIN_API_PASSPHRASE },
]

async function main() {
  for (const ex of exchanges) {
    try {
      // @ts-ignore
      const inst = new ccxt[ex.ccxtId]({ apiKey: ex.key, secret: ex.secret, password: ex.pass, defaultType: 'swap' }) as ccxt.Exchange
      await inst.loadMarkets()
      const rates = await inst.fetchFundingRates()
      const sorted = Object.entries(rates)
        .filter(([, r]) => (r as any).fundingRate != null)
        .sort(([, a], [, b]) => (a as any).fundingRate - (b as any).fundingRate)
      const negative = sorted.filter(([, r]) => (r as any).fundingRate < 0).slice(0, 5)
      const mostNeg = negative.map(([sym, r]) => `${sym}=${((r as any).fundingRate * 100).toFixed(4)}%`).join(' | ')
      console.log(`${ex.id}: negative_count=${negative.length} most_negative=[${mostNeg}]`)
      await (inst as any).close?.()
    } catch(e: any) {
      console.log(`${ex.id}: ERROR ${String(e.message).slice(0, 120)}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
