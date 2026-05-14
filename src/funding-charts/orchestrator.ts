import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'

import { createClient } from '@clickhouse/client'

import { logger } from '../logger.js'
import { streamFundingEvents } from './queries.js'
import type { ChartConfig, ClickHouseConnectionConfig, FundingEvent, WorkerMessage } from './types.js'

const WORKER_PATH = fileURLToPath(new URL('./worker-bootstrap.mjs', import.meta.url))

export async function runOrchestrator(
  chartConfig: ChartConfig,
  clickhouse: ClickHouseConnectionConfig,
  limit?: number,
): Promise<void> {
  const client = createClient({
    url: `http://${clickhouse.host}:${clickhouse.httpPort}`,
    database: clickhouse.database,
    username: clickhouse.user,
    password: clickhouse.password,
    request_timeout: 600_000,
  })

  logger.info('collecting funding events...')

  const events: FundingEvent[] = []
  for await (const event of streamFundingEvents(chartConfig, client)) {
    events.push(event)
    if (limit !== undefined && events.length >= limit) break
  }

  const total = events.length
  logger.info({ total }, 'funding events collected')

  if (total === 0) {
    logger.info('no events match filter — nothing to render')
    return
  }

  const workerCount = Math.min(chartConfig.worker_count, total)
  const chunkSize = Math.ceil(total / workerCount)
  const workerDone = new Array<number>(workerCount).fill(0)
  const workerSkipped = new Array<number>(workerCount).fill(0)
  const workerErrors = new Array<number>(workerCount).fill(0)
  const startTime = Date.now()

  const progressTimer = setInterval(() => {
    const totalDone = workerDone.reduce((a, b) => a + b, 0)
    const totalSkipped = workerSkipped.reduce((a, b) => a + b, 0)
    const totalErrors = workerErrors.reduce((a, b) => a + b, 0)
    const processed = totalDone + totalSkipped + totalErrors
    const elapsed = (Date.now() - startTime) / 1000
    const rate = elapsed > 0 ? processed / elapsed : 0
    const remaining = total - processed
    const eta = rate > 0 ? remaining / rate : 0
    logger.info(
      {
        done: totalDone,
        skipped: totalSkipped,
        total,
        errors: totalErrors,
        rate: Math.round(rate),
        eta: Math.round(eta),
      },
      'progress'
    )
  }, 1000)

  const workerPromises: Promise<void>[] = []

  for (let i = 0; i < workerCount; i++) {
    const chunk = events.slice(i * chunkSize, (i + 1) * chunkSize)
    if (chunk.length === 0) break

    const worker = new Worker(WORKER_PATH, {
      workerData: { events: chunk, config: chartConfig, workerId: i, clickhouse },
      execArgv: [],
    })

    const idx = i
    workerPromises.push(
      new Promise<void>((resolve, reject) => {
        worker.on('message', (msg: WorkerMessage) => {
          workerDone[idx] = msg.done
          workerSkipped[idx] = msg.skipped
          workerErrors[idx] = msg.errors
          if (msg.type === 'done') resolve()
        })
        worker.on('error', reject)
        worker.on('exit', code => {
          if (code !== 0) reject(new Error(`worker ${idx.toString()} exited with code ${code.toString()}`))
        })
      })
    )
  }

  try {
    await Promise.all(workerPromises)
  } finally {
    clearInterval(progressTimer)
    await client.close()
  }

  const totalDone = workerDone.reduce((a, b) => a + b, 0)
  const totalSkipped = workerSkipped.reduce((a, b) => a + b, 0)
  const totalErrors = workerErrors.reduce((a, b) => a + b, 0)
  const elapsed = (Date.now() - startTime) / 1000
  const processed = totalDone + totalSkipped + totalErrors
  const rate = elapsed > 0 ? processed / elapsed : 0

  logger.info(
    {
      total,
      done: totalDone,
      skipped: totalSkipped,
      errors: totalErrors,
      elapsed: elapsed.toFixed(1),
      rate: Math.round(rate),
    },
    'complete'
  )
}
