export class FundingRateCache {
  private cache = new Map<string, { rate: number; fundingTime: number }>()

  set(symbol: string, rate: number, fundingTime: number): void {
    this.cache.set(symbol, { rate, fundingTime })
  }

  get(symbol: string, fundingTime: number, toleranceMs = 5_000): number | null {
    const entry = this.cache.get(symbol)
    if (!entry) return null
    if (Math.abs(entry.fundingTime - fundingTime) > toleranceMs) return null
    return entry.rate
  }
}
