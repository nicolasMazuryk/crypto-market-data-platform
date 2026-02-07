import { cluster } from '../cluster'
import { workerEnvironment } from './shared'

export const migrationLogGroupName =
  process.env.MIGRATION_RUNNER_LOG_GROUP ??
  $interpolate`/${$app.name}/${$app.stage}/workers/migration-runner`

export const migrationRunner = new sst.aws.Task('MigrationRunner', {
  cluster,
  cpu: '0.25 vCPU',
  memory: '0.5 GB',
  image: {
    context: '.',
    dockerfile: 'Dockerfile',
  },
  command: ['node', 'dist/db/migrate.js'],
  environment: workerEnvironment(),
  logging: {
    retention: '1 month',
    name: migrationLogGroupName,
  },
  dev: {
    command: 'npm start -- migrate',
  },
})
