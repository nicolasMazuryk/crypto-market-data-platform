import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, 'migrations')

const url = process.env.EXECUTION_POSTGRES_URL ?? ''
if (!url) {
  console.error('EXECUTION_POSTGRES_URL env var is not set')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: url })

async function runMigrations(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _drizzle_migrations (
        id      SERIAL PRIMARY KEY,
        name    TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const applied = await client.query<{ name: string }>('SELECT name FROM _drizzle_migrations ORDER BY id')
    const appliedSet = new Set(applied.rows.map(r => r.name))

    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      if (appliedSet.has(file)) continue
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      console.log(`applying migration: ${file}`)
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO _drizzle_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        console.log(`  done: ${file}`)
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    }
    console.log('migrations complete')
  } finally {
    client.release()
    await pool.end()
  }
}

runMigrations().catch((err: unknown) => {
  console.error('migration failed', err)
  process.exit(1)
})
