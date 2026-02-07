import { cluster } from '../cluster'
import { requireEnv, workerEnvironment } from './shared'

export const marketSyncLogGroupName =
  process.env.MARKET_SYNC_LOG_GROUP ??
  $interpolate`/${$app.name}/${$app.stage}/workers/market-sync`

export const marketSync = new sst.aws.Task('MarketSyncWorker', {
  cluster,
  cpu: '0.25 vCPU',
  memory: '0.5 GB',
  image: {
    context: '.',
    dockerfile: 'Dockerfile',
  },
  environment: workerEnvironment(),
  logging: {
    retention: '1 month',
    name: marketSyncLogGroupName,
  },
  dev: {
    command: 'npm run sync:markets',
  },
})

export const marketSyncSchedule = new sst.aws.Cron('MarketSyncSchedule', {
  task: marketSync,
  schedule: requireEnv('MARKET_SYNC_SCHEDULE'),
})
