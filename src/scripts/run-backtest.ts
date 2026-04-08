import 'dotenv/config'
import path from 'path'

import { runBacktest } from '../backtesting/index.js'
import { closeClickHouseClient } from '../db/client.js'
import { logger } from '../logger.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  let strategyName: string | undefined
  let baseConfigPath: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--strategy' && args[i + 1]) {
      strategyName = args[i + 1]
      i++
    } else if (arg === '--config' && args[i + 1]) {
      baseConfigPath = args[i + 1]
      i++
    }
  }

  if (!strategyName) {
    console.error('Usage: tsx src/scripts/run-backtest.ts --strategy <strategy_name> [--config <base_config_path>]')
    console.error('Example: tsx src/scripts/run-backtest.ts --strategy strategy_1')
    process.exit(1)
  }

  const strategyConfigPath = path.join(process.cwd(), 'config', 'strategies', `${strategyName}.yaml`)

  try {
    logger.info({ strategy: strategyName }, 'Starting backtest run')
    const result = await runBacktest(strategyConfigPath, baseConfigPath)
    logger.info({ reportPath: result.reportPath, trades: result.trades.length }, 'Backtest complete')
  } catch (error) {
    logger.error({ error }, 'Backtest failed')
    throw error
  } finally {
    await closeClickHouseClient()
  }
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
