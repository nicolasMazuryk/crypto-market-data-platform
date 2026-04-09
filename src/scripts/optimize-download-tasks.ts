import { pathToFileURL } from 'node:url'

import { closeClickHouseClient } from '../db/client.js'
import { optimizeDownloadTasksTable } from '../db/queries/downloadTasks.js'

export async function runOptimizeDownloadTasks(): Promise<void> {
  await optimizeDownloadTasksTable()
  console.info('Compacted download_tasks table with FINAL optimization')
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false

if (isMain) {
  runOptimizeDownloadTasks()
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await closeClickHouseClient()
    })
}
