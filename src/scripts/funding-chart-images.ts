import { pathToFileURL } from 'url'
import os from 'os'

import { createClient } from '@clickhouse/client'
import { Command } from 'commander'

import { loadConfig } from '../funding-charts/config.js'
import { runOrchestrator } from '../funding-charts/orchestrator.js'
import { streamFundingEvents } from '../funding-charts/queries.js'
import { openSshTunnel } from '../funding-charts/ssh-tunnel.js'
import type { ClickHouseConnectionConfig } from '../funding-charts/types.js'
import { closeLogger, logger } from '../logger.js'

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

async function buildRemoteConnection(): Promise<{ conn: ClickHouseConnectionConfig; closeTunnel: () => void }> {
  const sshHost = process.env.REMOTE_SERVER_HOST
  if (!sshHost) throw new Error('REMOTE_SERVER_HOST env var is required')

  const sshUser = process.env.REMOTE_SSH_USER ?? os.userInfo().username
  const sshKey = process.env.REMOTE_SSH_KEY ?? `${os.homedir()}/.ssh/nicolas`

  logger.info({ sshHost, sshUser }, 'opening SSH tunnel to remote ClickHouse')

  const tunnel = await openSshTunnel({
    sshHost,
    sshUser,
    sshKey,
    remotePort: parseInt(process.env.CLICKHOUSE_HTTP_PORT ?? '8123', 10),
  })

  logger.info({ localPort: tunnel.localPort }, 'SSH tunnel ready')

  const conn: ClickHouseConnectionConfig = {
    host: '127.0.0.1',
    httpPort: tunnel.localPort.toString(),
    database: process.env.CLICKHOUSE_DATABASE ?? 'arbinet',
    user: process.env.CLICKHOUSE_USER ?? 'arbinet',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  }

  return { conn, closeTunnel: tunnel.close }
}

async function main(): Promise<void> {
  const overrides = opts.workers !== undefined ? { workers: opts.workers } : {}
  const chartConfig = loadConfig(opts.config, overrides)

  const { conn, closeTunnel } = await buildRemoteConnection()

  try {
    if (opts.dryRun) {
      const client = createClient({
        url: `http://${conn.host}:${conn.httpPort}`,
        database: conn.database,
        username: conn.user,
        password: conn.password,
        request_timeout: 600_000,
      })
      try {
        let count = 0
        for await (const _event of streamFundingEvents(chartConfig, client)) {
          count++
          if (opts.limit !== undefined && count >= opts.limit) break
        }
        logger.info({ count }, 'dry-run: matching events found')
      } finally {
        await client.close()
      }
      return
    }

    await runOrchestrator(chartConfig, conn, opts.limit)
  } finally {
    closeTunnel()
  }
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false
if (isMain) {
  main()
    .catch((error: unknown) => {
      logger.error({ err: error }, 'funding-chart-images fatal error')
      process.exitCode = 1
    })
    .finally(() => closeLogger())
}
