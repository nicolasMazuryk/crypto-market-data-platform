async function main() {
  const { createCcxtExchange } = await import('../../exchanges/ccxt-client.js')
  const { ccxtIdMap } = await import('../markets/ccxtIdMap.js')
  const ex = createCcxtExchange({ name: 'gateio', ccxtId: ccxtIdMap.gateio })
  ;(ex as any).options = { ...(ex as any).options, defaultType: 'swap' }
  await (ex as any).loadMarkets()
  const funding = await (ex as any).fetchFundingRates()
  const now = new Date()
  console.log(`Funding checked at ${now.toISOString()} (UTC)`)
  const rates = Object.entries(funding as Record<string, any>)
    .filter(([, v]: [string, any]) => v?.fundingRate != null && v.fundingRate < -0.0004)
    .map(([sym, v]: [string, any]) => ({
      sym: sym.replace('/USDT:USDT', 'USDT'),
      rate: (v.fundingRate as number).toFixed(6),
      nextFunding: v.fundingDatetime,
    }))
    .sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate))
    .slice(0, 10)
  console.log(JSON.stringify(rates, null, 2))
  await (ex as any).close()
}
main().catch(console.error)
