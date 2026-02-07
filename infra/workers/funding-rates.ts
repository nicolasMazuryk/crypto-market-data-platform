import { cluster } from '../cluster'
import { requireEnv, workerEnvironment } from './shared'

export const fundingRatesLogGroupName =
  process.env.FUNDING_RATES_LOG_GROUP ??
  $interpolate`/${$app.name}/${$app.stage}/workers/funding-rates`

export const fundingRates = new sst.aws.Task('FundingRatesWorker', {
  cluster,
  cpu: '0.25 vCPU',
  memory: '0.5 GB',
  image: {
    context: '.',
    dockerfile: 'Dockerfile',
  },
  command: ['node', 'dist/scripts/sync-funding-rates.js'],
  environment: workerEnvironment(),
  logging: {
    retention: '1 month',
    name: fundingRatesLogGroupName,
  },
  dev: {
    command: 'npm run sync:funding-rates',
  },
})

export const fundingRatesSchedule = new sst.aws.Cron('FundingRatesSchedule', {
  task: fundingRates,
  schedule: requireEnv('FUNDING_RATES_SCHEDULE'),
})
