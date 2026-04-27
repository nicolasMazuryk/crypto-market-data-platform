import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './drizzle/schema.js'

export type DrizzleDb = ReturnType<typeof createDb>

export interface DbHandle {
  db: DrizzleDb
  pool: pg.Pool
  close(): Promise<void>
}

export function createDb(pool: pg.Pool): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(pool, { schema })
}

export function openDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString, max: 5 })
  const db = createDb(pool)
  return {
    db,
    pool,
    close: () => pool.end(),
  }
}
