import { pathToFileURL } from 'node:url'

import { closeClickHouseClient } from '../db/client.js'
import { listPendingTasks, resetStaleTasks } from '../db/queries/downloadTasks.js'
import { QUOTE_SYNC_EXCHANGE, STALE_RECOVERY_MINUTES, WORKER_COUNT, WORKER_INDEX } from '../quotes/config.js'
import { syncQuotes } from '../quotes/index.js'

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

export async function runSyncQuotes(): Promise<void> {
  if (WORKER_INDEX < 0 || WORKER_INDEX >= WORKER_COUNT) {
    throw new Error(
      `Invalid worker config: WORKER_INDEX=${String(WORKER_INDEX)} must be >= 0 and < WORKER_COUNT=${String(WORKER_COUNT)}`
    )
  }

  console.info(`Worker ${String(WORKER_INDEX)}/${String(WORKER_COUNT)} starting`)

  if (WORKER_INDEX === 0 && STALE_RECOVERY_MINUTES > 0) {
    const resetCount = await resetStaleTasks(STALE_RECOVERY_MINUTES)
    if (resetCount > 0) {
      console.info(`Reset ${String(resetCount)} stale task(s) older than ${String(STALE_RECOVERY_MINUTES)} minutes`)
    }
  }

  if (QUOTE_SYNC_EXCHANGE) {
    console.info(`Restricting run to exchange=${QUOTE_SYNC_EXCHANGE}`)
  }

  const tasks = await listPendingTasks(QUOTE_SYNC_EXCHANGE, undefined, WORKER_INDEX, WORKER_COUNT)
  if (tasks.length === 0) {
    console.info('No pending download tasks found')
    return
  }

  let runError: Error | undefined

  try {
    const outputs = await syncQuotes(tasks, {
      onInfo: message => {
        console.info(message)
      },
    })

    let hasFailures = false

    for (const output of outputs) {
      if (output.errorMessage !== undefined) {
        hasFailures = true
        console.error(
          `${output.exchange}/${output.symbol}/${output.date}: failed after writing ${String(output.rowsWritten)} row(s) - ${output.errorMessage}`
        )
        continue
      }

      console.info(`${output.exchange}/${output.symbol}/${output.date}: completed ${String(output.rowsWritten)} row(s)`)
    }

    if (hasFailures) {
      process.exitCode = 1
    }
  } catch (error: unknown) {
    runError = toError(error)
  }

  if (runError !== undefined) {
    throw runError
  }
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false

if (isMain) {
  runSyncQuotes()
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await closeClickHouseClient()
    })
}
