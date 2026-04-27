const CAP_SECONDS = 8

export function jitteredBackoff(attempt: number): number {
  const baseSec = Math.min(Math.pow(2, attempt), CAP_SECONDS)
  const jitter = baseSec * 0.25 * (Math.random() * 2 - 1)
  return Math.max(50, Math.round((baseSec + jitter) * 1000))
}
