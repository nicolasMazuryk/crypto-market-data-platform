import { pathToFileURL } from 'node:url'

import { closeClickHouseClient } from '../db/client.js'
import { listExchangeTaskProgress } from '../db/queries/downloadTasks.js'

export async function runReportDownloadTaskProgress(): Promise<void> {
  const progress = await listExchangeTaskProgress()
  console.log(JSON.stringify(progress, null, 2))
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false

if (isMain) {
  runReportDownloadTaskProgress()
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await closeClickHouseClient()
    })
}
