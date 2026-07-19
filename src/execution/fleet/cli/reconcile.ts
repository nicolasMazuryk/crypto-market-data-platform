import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as readline from 'node:readline'

import { loadFleet } from '../loader.js'
import { loadRegistry } from '../../provisioning/registry/loader.js'
import { validateFleet } from '../validate.js'
import { generateInstanceConfig } from '../generate-instance-config.js'
import {
  fetchObservedState,
  computeDiff,
  getLocalCodeSha,
  loadStrategyContents,
  computeFleetEntryHash,
} from '../reconcile.js'
import { buildFleetReconcilePlaybookArgs } from './ansible-args.js'
import type { FleetEntry } from '../schema.js'
import type { RegistryEntry } from '../../provisioning/registry/schema.js'

const args = process.argv.slice(2)
function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}
const fleetPath = getArg('--fleet') ?? 'live-configs/fleet.yaml'
const registryPath = getArg('--registry') ?? 'live-configs/registry.yaml'
const basePath = getArg('--base') ?? 'config/execution.base.yaml'
const configOutDir = getArg('--config-dir') ?? 'config'
const sshTarget = getArg('--ssh') ?? 'nicolas@203.0.113.10'
const sshKeyPath = getArg('--ssh-key') ?? '~/.ssh/nicolas'
const concurrency = parseInt(getArg('--concurrency') ?? '5', 10)
const dryRun = args.includes('--dry-run') || args.includes('-n')

const onlyArg = getArg('--only')
const onlyFilter = onlyArg ? new Set(onlyArg.split(',').map(s => s.trim())) : null

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes')
    })
  })
}

function printDiffTable(
  toStart: FleetEntry[],
  toStop: string[],
  toRedeploy: FleetEntry[],
  unchanged: FleetEntry[]
): void {
  console.log('\nFleet reconcile diff:')
  console.log('─'.repeat(50))
  for (const e of toStart) console.log(`  + start      ${e.id}`)
  for (const id of toStop) console.log(`  - stop       ${id}`)
  for (const e of toRedeploy) console.log(`  ~ redeploy   ${e.id}`)
  for (const e of unchanged) console.log(`  = unchanged  ${e.id}`)
  console.log('─'.repeat(50))
  console.log(
    `  ${toStart.length.toString()} to start, ${toStop.length.toString()} to stop, ` +
      `${toRedeploy.length.toString()} to redeploy, ${unchanged.length.toString()} unchanged\n`
  )
}

async function main(): Promise<void> {
  const registry = loadRegistry(registryPath)
  const fleet = loadFleet(fleetPath, { registry })

  const validation = validateFleet(fleet, registry)
  for (const w of validation.warnings) console.warn(`warn: ${w}`)
  if (!validation.valid) {
    console.error('Fleet validation failed:')
    for (const e of validation.errors) console.error(`  ${e}`)
    process.exit(1)
  }

  console.log('Fetching observed state from server...')
  const observed = fetchObservedState(sshTarget, sshKeyPath)

  const localCodeSha = getLocalCodeSha()
  const strategyContents = loadStrategyContents(fleet)

  let { toStart, toStop, toRedeploy, unchanged } = computeDiff(fleet, observed, localCodeSha, strategyContents)

  // Apply --only filter
  if (onlyFilter) {
    toStart = toStart.filter(e => onlyFilter.has(e.id))
    toStop = toStop.filter(id => onlyFilter.has(id))
    toRedeploy = toRedeploy.filter(e => onlyFilter.has(e.id))
    unchanged = unchanged.filter(e => onlyFilter.has(e.id))
  }

  printDiffTable(toStart, toStop, toRedeploy, unchanged)

  if (toStart.length === 0 && toStop.length === 0 && toRedeploy.length === 0) {
    console.log('Nothing to do.')
    return
  }

  if (dryRun) {
    console.log('[dry-run] No changes applied.')
    return
  }

  const proceed = await confirm('Apply changes? [y/N] ')
  if (!proceed) {
    console.log('Aborted.')
    return
  }

  // Generate per-instance configs for start + redeploy
  const toDeploy = [...toStart, ...toRedeploy]
  const tmpDir = join(configOutDir, '.fleet-tmp')
  mkdirSync(tmpDir, { recursive: true })

  const comboData: Record<string, { content: string; hash: string; regEntry: RegistryEntry | undefined }> = {}

  for (const entry of toDeploy) {
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const outPath = join(configOutDir, result.filename)
    writeFileSync(outPath, result.content, 'utf8')

    const strategyContent = strategyContents.get(entry.id) ?? ''
    const hash = computeFleetEntryHash(entry, strategyContent, localCodeSha)
    const regEntry = registry.combinations.find(
      c => c.assigned_strategy === entry.strategy && c.exchange === entry.exchange
    )

    comboData[entry.id] = { content: result.content, hash, regEntry }
  }

  function comboManifestEntry(e: FleetEntry) {
    const data = comboData[e.id] ?? { content: '', hash: '', regEntry: undefined }
    return {
      id: e.id,
      exchange: e.exchange,
      runtime: e.runtime,
      risk: e.risk,
      config_content: data.content,
      config_hash: data.hash,
      api_key: data.regEntry?.api_key ?? '',
      api_secret: data.regEntry?.api_secret ?? '',
      api_passphrase: data.regEntry?.api_passphrase ?? null,
    }
  }

  // Write reconcile manifest for Ansible
  const manifest = {
    toStop,
    toStart: toStart.map(comboManifestEntry),
    toRedeploy: toRedeploy.map(comboManifestEntry),
  }

  const manifestPath = join(tmpDir, 'reconcile-manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  console.log('Running fleet-reconcile playbook...')
  const playbookArgs = buildFleetReconcilePlaybookArgs({
    concurrency,
    manifestPath,
    configOutDir,
    executionImageTag: localCodeSha,
  })

  const result = spawnSync('ansible-playbook', playbookArgs, {
    stdio: 'inherit',
    encoding: 'utf8',
  })

  // Clean up temp dir
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  const exitCode = result.status ?? 1
  if (exitCode !== 0) {
    console.error('Ansible playbook failed.')
    process.exit(exitCode)
  }

  console.log('Reconcile complete.')
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
