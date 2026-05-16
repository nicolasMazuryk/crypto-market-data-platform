import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Fleet, FleetEntry } from './schema.js'

export interface ObservedState {
  runningIds: Set<string>
  /** SHA from /opt/arbinet/execution/current/release, null if not deployed */
  deployedSha: string | null
  /** id → hash from /opt/arbinet/execution/state/<id>.hash */
  configHashes: Map<string, string>
}

export interface FleetDiff {
  toStart: FleetEntry[]
  toStop: string[]
  toRedeploy: FleetEntry[]
  unchanged: FleetEntry[]
}

/** Deterministic hash of a fleet entry + strategy config content + code SHA */
export function computeFleetEntryHash(entry: FleetEntry, strategyConfigContent: string, codeSha: string): string {
  const data = JSON.stringify({ entry, strategyConfig: strategyConfigContent, codeSha })
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

export function getLocalCodeSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

export function fetchObservedState(sshTarget: string, sshKeyPath: string): ObservedState {
  function ssh(cmd: string): string {
    try {
      return execFileSync(
        'ssh',
        [
          '-i',
          sshKeyPath,
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          'ConnectTimeout=10',
          sshTarget,
          cmd,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim()
    } catch {
      return ''
    }
  }

  const unitList = ssh(
    "systemctl list-units 'execution-engine@*.service' --state=active --no-legend --no-pager 2>/dev/null || true"
  )
  const runningIds = new Set<string>()
  for (const line of unitList.split('\n')) {
    const match = /execution-engine@(.+?)\.service/.exec(line.trim())
    if (match?.[1]) runningIds.add(match[1])
  }

  const releaseContent = ssh('cat /opt/arbinet/execution/current/release 2>/dev/null || true')
  const shaMatch = /sha=(\S+)/.exec(releaseContent)
  const deployedSha = shaMatch?.[1] ?? null

  const hashListing = ssh('ls /opt/arbinet/execution/state/*.hash 2>/dev/null || true')
  const configHashes = new Map<string, string>()
  for (const hashFile of hashListing.split('\n').filter(Boolean)) {
    const idMatch = /\/([^/]+)\.hash$/.exec(hashFile)
    if (!idMatch?.[1]) continue
    const hash = ssh(`cat '${hashFile}' 2>/dev/null || true`)
    if (hash) configHashes.set(idMatch[1], hash.trim())
  }

  return { runningIds, deployedSha, configHashes }
}

export function computeDiff(
  fleet: Fleet,
  observed: ObservedState,
  localCodeSha: string,
  /** id → strategy_config file content */
  strategyContents: Map<string, string>
): FleetDiff {
  const desiredEnabled = fleet.combinations.filter(e => e.enabled)
  const desiredEnabledIds = new Set(desiredEnabled.map(e => e.id))

  const codeChanged =
    observed.deployedSha !== null &&
    observed.deployedSha !== 'unknown' &&
    localCodeSha !== 'unknown' &&
    observed.deployedSha !== localCodeSha

  const toStart: FleetEntry[] = []
  const toStop: string[] = []
  const toRedeploy: FleetEntry[] = []
  const unchanged: FleetEntry[] = []

  for (const entry of desiredEnabled) {
    if (!observed.runningIds.has(entry.id)) {
      toStart.push(entry)
      continue
    }

    const strategyContent = strategyContents.get(entry.id) ?? ''
    const currentHash = computeFleetEntryHash(entry, strategyContent, localCodeSha)
    const deployedHash = observed.configHashes.get(entry.id)

    if (codeChanged || !deployedHash || deployedHash !== currentHash) {
      toRedeploy.push(entry)
    } else {
      unchanged.push(entry)
    }
  }

  // Running but not in desired fleet (or disabled)
  for (const runningId of observed.runningIds) {
    if (!desiredEnabledIds.has(runningId)) {
      toStop.push(runningId)
    }
  }
  for (const entry of fleet.combinations) {
    if (!entry.enabled && observed.runningIds.has(entry.id) && !toStop.includes(entry.id)) {
      toStop.push(entry.id)
    }
  }

  return { toStart, toStop, toRedeploy, unchanged }
}

export function loadStrategyContents(fleet: Fleet): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of fleet.combinations) {
    if (!entry.enabled) continue
    try {
      map.set(entry.id, readFileSync(resolve(entry.strategy_config), 'utf8'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`failed to load strategy_config "${entry.strategy_config}" for ${entry.id}: ${message}`)
    }
  }
  return map
}
