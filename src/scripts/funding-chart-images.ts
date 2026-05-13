import { pathToFileURL } from 'url'

import { Command } from 'commander'

import { loadConfig } from '../funding-charts/config.js'
import { runOrchestrator } from '../funding-charts/orchestrator.js'
import { streamFundingEvents } from '../funding-charts/queries.js'
import { logger } from '../logger.js'

interface CliOptions {
  config: string
  dryRun: boolean
  limit?: number
  workers?: number
}

const program = new Command()
program
  .name('funding-chart-images')
  .option('--config <path>', 'path to config.yaml', './src/funding-charts/config.yaml')
  .option('--dry-run', 'count matching events without rendering')
  .option('--limit <n>', 'limit number of events to process', v => parseInt(v, 10))
  .option('--workers <n>', 'override worker count', v => parseInt(v, 10))
  .allowUnknownOption()
  .parse(process.argv)

const opts = program.opts<CliOptions>()

async function main(): Promise<void> {
  const overrides = opts.workers !== undefined ? { workers: opts.workers } : {}
  const chartConfig = loadConfig(opts.config, overrides)

  if (opts.dryRun) {
    let count = 0
    for await (const _event of streamFundingEvents(chartConfig)) {
      count++
      if (opts.limit !== undefined && count >= opts.limit) break
    }
    logger.info({ count }, 'dry-run: matching events found')
    return
  }

  await runOrchestrator(chartConfig, opts.limit)
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false
if (isMain) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, 'funding-chart-images fatal error')
    process.exitCode = 1
  })
}
