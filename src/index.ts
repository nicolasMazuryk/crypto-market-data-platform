import { runMarketsSync } from './scripts/sync-markets.js'

runMarketsSync().catch(() => {
  process.exitCode = 1
})
