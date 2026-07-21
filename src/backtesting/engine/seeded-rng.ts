/**
 * Deterministic per-event uniform draw (§6.5.2 WS-event-miss emulation). Reproducible
 * across runs/fleet members: hashing the event identity means the same funding event
 * always draws the same value, so `ws_event_miss_rate` produces a stable miss rate
 * instead of nondeterministic flakiness in the backtest.
 */

/** cyrb128: 128-bit string hash, used to seed mulberry32. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1015002853
  let h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/** mulberry32: fast seeded PRNG, returns a function producing floats in [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic uniform draw in `[0, 1)` for a given funding event identity. */
export function eventMissDraw(exchange: string, symbol: string, fundingTime: Date): number {
  const key = `${exchange}|${symbol}|${fundingTime.toISOString()}`
  const [seed] = cyrb128(key)
  return mulberry32(seed)()
}
