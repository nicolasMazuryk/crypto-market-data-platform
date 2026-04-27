import type { Config } from 'drizzle-kit'

const postgresUrl = process.env.EXECUTION_POSTGRES_URL ?? 'postgresql://arbinet:<POSTGRES_PASSWORD>@localhost:5432/arbinet'

export default {
  schema: './src/execution/persistence/drizzle/schema.ts',
  out: './src/execution/persistence/drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: postgresUrl },
} satisfies Config
