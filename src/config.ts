import { config as loadEnv } from 'dotenv'

const envResult = loadEnv()
if (envResult.error && envResult.error.code !== 'ENOENT') {
  throw envResult.error
}

const ENVIRONMENTS = ['development', 'test', 'production'] as const

type Environment = (typeof ENVIRONMENTS)[number]

function normalizeNodeEnv(value: string | undefined): Environment {
  if (!value) {
    return 'development'
  }

  if (ENVIRONMENTS.includes(value as Environment)) {
    return value as Environment
  }

  throw new Error(`Invalid NODE_ENV: ${value}`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV)

export const config = Object.freeze({
  env: nodeEnv,
  logLevel: process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
})

export type AppConfig = typeof config
