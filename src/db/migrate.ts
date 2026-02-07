import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { config } from '../config.js'
import { MIGRATIONS_DIR } from '../config/index.js'
import { logger } from '../logger.js'
import { closeClickHouseClient, getClickHouseClient } from './client.js'

interface MigrationFile {
  version: string
  sql: string
}

interface AppliedMigrationRow {
  version: string
}

function resolveMigrationsDir(migrationsDir: string): string {
  if (path.isAbsolute(migrationsDir)) {
    return migrationsDir
  }

  return path.resolve(process.cwd(), migrationsDir)
}

async function listMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true })
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right))

  const migrations: MigrationFile[] = []

  for (const filename of files) {
    const sql = await readFile(path.join(migrationsDir, filename), 'utf8')
    migrations.push({
      version: filename,
      sql: sql.trim(),
    })
  }

  return migrations
}

async function ensureSchemaMigrationsTable(): Promise<void> {
  const client = getClickHouseClient()

  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${config.clickhouse.database}.schema_migrations
      (
        version String,
        applied_at DateTime DEFAULT now()
      )
      ENGINE = MergeTree
      ORDER BY version
    `,
  })
}

async function fetchAppliedMigrationVersions(): Promise<Set<string>> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `
      SELECT version
      FROM ${config.clickhouse.database}.schema_migrations
      ORDER BY version
    `,
    format: 'JSONEachRow',
  })

  const rows = await result.json<AppliedMigrationRow>()
  return new Set(rows.map(row => row.version))
}

async function markMigrationApplied(version: string): Promise<void> {
  const client = getClickHouseClient()

  await client.command({
    query: `
      INSERT INTO ${config.clickhouse.database}.schema_migrations (version)
      VALUES ({version: String})
    `,
    query_params: {
      version,
    },
  })
}

async function runMigration(version: string, sql: string): Promise<void> {
  const client = getClickHouseClient()

  await client.command({ query: sql })
  await markMigrationApplied(version)
}

export async function runMigrations(migrationsDir: string = MIGRATIONS_DIR): Promise<void> {
  const resolvedMigrationsDir = resolveMigrationsDir(migrationsDir)

  logger.info({ migrationsDir: resolvedMigrationsDir }, 'Running migrations')

  await ensureSchemaMigrationsTable()

  const [migrationFiles, appliedVersions] = await Promise.all([
    listMigrationFiles(resolvedMigrationsDir),
    fetchAppliedMigrationVersions(),
  ])

  if (migrationFiles.length === 0) {
    logger.warn({ migrationsDir: resolvedMigrationsDir }, 'No SQL migration files found')
    return
  }

  let applied = 0

  for (const migration of migrationFiles) {
    if (appliedVersions.has(migration.version)) {
      logger.info({ version: migration.version }, 'Skipping already applied migration')
      continue
    }

    if (!migration.sql) {
      logger.warn({ version: migration.version }, 'Skipping empty migration file')
      continue
    }

    logger.info({ version: migration.version }, 'Applying migration')
    await runMigration(migration.version, migration.sql)
    applied += 1
  }

  logger.info(
    {
      applied,
      total: migrationFiles.length,
      skipped: migrationFiles.length - applied,
    },
    'Migration run complete'
  )
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false
if (isMain) {
  runMigrations()
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Migration run failed')
      process.exitCode = 1
    })
    .finally(async () => {
      try {
        await closeClickHouseClient()
      } catch (error: unknown) {
        logger.error({ err: error }, 'Failed to close ClickHouse client')
      }
    })
}
