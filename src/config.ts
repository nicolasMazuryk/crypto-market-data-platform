import { config as loadEnv } from 'dotenv'

const envResult = loadEnv()
const envError = envResult.error
if (envError) {
  const errorCode = (envError as NodeJS.ErrnoException).code
  if (errorCode !== 'ENOENT') {
    throw envError
  }
}

const ENVIRONMENTS = ['development', 'test', 'production'] as const

type Environment = (typeof ENVIRONMENTS)[number]

function normalizeNodeEnv(value: string): Environment {
  if (ENVIRONMENTS.includes(value as Environment)) {
    return value as Environment
  }

  throw new Error(`Invalid NODE_ENV: ${value}`)
}

function requireEnv(name: string, options: { allowEmpty?: boolean } = {}): string {
  const value = process.env[name]
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  if (!options.allowEmpty && value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

const nodeEnv = normalizeNodeEnv(requireEnv('NODE_ENV'))

export const config = Object.freeze({
  env: nodeEnv,
  logLevel: requireEnv('LOG_LEVEL'),
  clickhouse: Object.freeze({
    host: requireEnv('CLICKHOUSE_HOST'),
    httpPort: requireEnv('CLICKHOUSE_HTTP_PORT'),
    nativePort: requireEnv('CLICKHOUSE_NATIVE_PORT'),
    database: requireEnv('CLICKHOUSE_DATABASE'),
    user: requireEnv('CLICKHOUSE_USER'),
    password: requireEnv('CLICKHOUSE_PASSWORD', { allowEmpty: true }),
  }),
})

export type AppConfig = typeof config
