import { parentPort, workerData } from 'worker_threads'

import { createClient } from '@clickhouse/client'
import pLimit from 'p-limit'

import { config } from '../config.js'
import { logger } from '../logger.js'
import { buildOutputPath, writePng } from './output.js'
import { processFundingChartEvent } from './process-event.js'
import { fetchOrderbookWindow } from './queries.js'
import { renderChart } from './render.js'
import type { ChartConfig, FundingEvent, WorkerMessage } from './types.js'

const {
  events,
  config: chartConfig,
  workerId,
} = workerData as {
  events: FundingEvent[]
  config: ChartConfig
  workerId: number
}

// Re-hydrate Date objects (structured clone transfers them correctly, but be safe)
const hydratedEvents: FundingEvent[] = events.map(e => ({
  ...e,
  funding_time: e.funding_time instanceof Date ? e.funding_time : new Date(e.funding_time as unknown as string),
}))

const { host, httpPort, database, user, password } = config.clickhouse
const client = createClient({
  url: `http://${host}:${httpPort}`,
  database,
  username: user,
  password,
  request_timeout: 600_000,
})

const workerLog = logger.child({ worker: workerId })
const limit = pLimit(chartConfig.db_concurrency_per_worker)

let done = 0
let skipped = 0
let errors = 0

const progressInterval = setInterval(() => {
  const msg: WorkerMessage = { type: 'progress', done, skipped, errors }
  parentPort?.postMessage(msg)
}, 1000)

async function processEvent(event: FundingEvent): Promise<void> {
  try {
    const result = await processFundingChartEvent(event, chartConfig, {
      fetchRows: (fundingEvent, preSeconds, postSeconds) =>
        fetchOrderbookWindow(client, fundingEvent, preSeconds, postSeconds),
      buildOutputPath,
      renderChart,
      writePng,
      warn: (obj, msg) => {
        workerLog.warn(obj, msg)
      },
      debug: (obj, msg) => {
        workerLog.debug(obj, msg)
      },
    })

    if (result === 'skipped_no_orderbook') skipped++
    else done++
  } catch (err) {
    errors++
    workerLog.error({ err, exchange: event.exchange, symbol: event.symbol }, 'failed to render event')
  }
}

await Promise.all(hydratedEvents.map(event => limit(() => processEvent(event))))

clearInterval(progressInterval)

const doneMsg: WorkerMessage = { type: 'done', done, skipped, errors }
parentPort?.postMessage(doneMsg)

await client.close()
