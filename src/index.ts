import { runMigrations } from './db/migrate.js'
import { runMarketsSync } from './scripts/sync-markets.js'

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'migrate') {
    await runMigrations()
    return
  }

  await runMarketsSync()
}

main().catch(() => {
  process.exitCode = 1
})
