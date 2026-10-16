import type { Config } from 'drizzle-kit'

const postgresUrl = process.env.EXECUTION_POSTGRES_URL ?? ''

export default {
  schema: './src/execution/persistence/drizzle/schema.ts',
  out: './src/execution/persistence/drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: postgresUrl },
} satisfies Config
