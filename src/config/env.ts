import { config as loadEnv } from 'dotenv'

const envResult = loadEnv({ debug: false })
if (envResult.error) {
  const code = (envResult.error as NodeJS.ErrnoException).code
  if (code !== 'ENOENT') {
    throw envResult.error
  }
}

export function requireEnv(name: string, options: { allowEmpty?: boolean } = {}): string {
  const value = process.env[name]
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  if (!options.allowEmpty && value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined) {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function parseDateEnv(name: string, options: { required?: boolean } = {}): Date | null {
  const raw = options.required ? requireEnv(name) : optionalEnv(name)
  if (!raw) {
    return null
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value for ${name}: ${raw}`)
  }

  return parsed
}

export function parseIntEnv(name: string): number {
  const raw = requireEnv(name)
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer value for ${name}: ${raw}`)
  }

  return parsed
}

export function parseFloatEnv(name: string): number {
  const raw = requireEnv(name)
  const parsed = Number.parseFloat(raw)
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid float value for ${name}: ${raw}`)
  }

  return parsed
}
