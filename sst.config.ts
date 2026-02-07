/// <reference path="./.sst/platform/config.d.ts" />

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

let loadedStage: string | undefined

async function ensureStageEnvironment(stage: string): Promise<void> {
  if (loadedStage === stage) {
    return
  }

  const { existsSync } = await import('node:fs')
  const path = (await import('node:path')).default
  const { config: loadEnv } = await import('dotenv')

  const envFile = process.env.SST_ENV_FILE ?? `.env.${stage}`
  const envPath = path.resolve(process.cwd(), envFile)
  if (!existsSync(envPath)) {
    throw new Error(`Missing environment file for stage "${stage}": ${envFile}`)
  }

  const result = loadEnv({ path: envPath, override: true })
  if (result.error) {
    throw result.error
  }

  process.env.SST_STAGE = stage
  process.env.SST_ENV_FILE = envFile
  loadedStage = stage
}

export default $config({
  async app(input) {
    const stage = input?.stage ?? process.env.SST_STAGE ?? 'dev'
    await ensureStageEnvironment(stage)

    return {
      name: 'arbinet',
      removal: stage === 'prod' ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: {
          region: requireEnv('AWS_REGION'),
        },
      },
    }
  },
  async run() {
    await import('./infra/network')
    await import('./infra/clickhouse')
    await import('./infra/cluster')
    await import('./infra/workers/market-sync')
    await import('./infra/workers/funding-rates')
    await import('./infra/workers/migration-runner')
    await import('./infra/monitoring')
  },
})
