import '../../../config/env.js'

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { buildAdapter } from '../exchanges/factory.js'
import { reconcileCapital } from '../exchanges/reconcile.js'
import type { ProvisioningAdapter } from '../exchanges/types.js'
import { loadRegistry, saveRegistry } from '../registry/loader.js'
import { REQUIRED_IP_ALLOW_LIST, type Registry, type RegistryEntry } from '../registry/schema.js'

interface Check {
  name: string
  status: 'PASS' | 'FAIL' | 'WARN'
  detail: string
}

function parseArgs(): {
  strategy: string
  exchange: RegistryEntry['exchange']
  capital: number
  label: string
  registryPath: string
} {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const i = args.indexOf(flag)
    return i !== -1 ? args[i + 1] : undefined
  }

  const strategy = get('--strategy')
  const exchange = get('--exchange') as RegistryEntry['exchange'] | undefined
  const capitalStr = get('--capital')
  const label = get('--label')
  const registryPath = get('--registry') ?? 'live-configs/registry.yaml'

  if (!strategy || !exchange || !capitalStr) {
    console.error(
      'Usage: provision --strategy <id> --exchange <name> --capital <usdt> [--label <label>] [--registry <path>]'
    )
    process.exit(1)
  }

  const capital = parseFloat(capitalStr)
  if (!isFinite(capital) || capital <= 0) {
    console.error(`--capital must be a positive number, got: ${capitalStr}`)
    process.exit(1)
  }

  return { strategy, exchange, capital, label: label ?? `${strategy}-${exchange}`, registryPath }
}

function ensureRegistryExists(registryPath: string): Registry {
  const absPath = resolve(registryPath)
  if (!existsSync(absPath)) {
    const dir = dirname(absPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return { combinations: [] }
  }
  return loadRegistry(registryPath)
}

function findLruIdleIndex(registry: Registry, exchange: RegistryEntry['exchange']): number {
  const candidates = registry.combinations
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.exchange === exchange && entry.status === 'idle' && entry.assigned_strategy === null)
    .sort((a, b) => {
      const aTime = a.entry.last_assigned_at ?? a.entry.created_at
      const bTime = b.entry.last_assigned_at ?? b.entry.created_at
      return aTime.localeCompare(bTime)
    })
  return candidates[0]?.index ?? -1
}

function exchangeSupportsRename(exchange: RegistryEntry['exchange']): boolean {
  return !['binance', 'bitget', 'bybit', 'gateio', 'kucoin', 'mexc', 'okx'].includes(exchange)
}

function exchangeLabel(exchange: RegistryEntry['exchange'], label: string): string {
  if (exchange === 'bybit' || exchange === 'kucoin') return label.replace(/[^a-zA-Z0-9]/g, '')
  if (exchange === 'gateio') return label.replace(/[^a-zA-Z0-9_]/g, '_')
  return label
}

function ipAllowListMatches(entry: RegistryEntry): boolean {
  return JSON.stringify([...entry.ip_allow_list].sort()) === JSON.stringify([...REQUIRED_IP_ALLOW_LIST].sort())
}

function printChecks(checks: Check[]): void {
  const nameWidth = Math.max('check'.length, ...checks.map(c => c.name.length))
  console.log()
  console.log(`${'check'.padEnd(nameWidth)}  status  detail`)
  for (const check of checks) {
    console.log(`${check.name.padEnd(nameWidth)}  ${check.status.padEnd(6)}  ${check.detail}`)
  }
}

async function verifyReady(
  entry: RegistryEntry,
  adapter: ProvisioningAdapter,
  strategy: string,
  targetCapital: number
): Promise<{ pass: boolean; checks: Check[] }> {
  const checks: Check[] = []
  const subs = await adapter.listSubAccounts()
  const discovered = subs.find(sub => sub.subAccountId === entry.sub_account_id)
  checks.push({
    name: 'sub-account exists',
    status: discovered ? 'PASS' : 'FAIL',
    detail: discovered ? entry.sub_account_id : `${entry.sub_account_id} not found on exchange`,
  })
  checks.push({
    name: 'assigned strategy',
    status: entry.assigned_strategy === strategy ? 'PASS' : 'FAIL',
    detail: entry.assigned_strategy ?? 'null',
  })
  checks.push({ name: 'status', status: entry.status === 'active' ? 'PASS' : 'FAIL', detail: entry.status })
  checks.push({
    name: 'api credentials',
    status: entry.api_key && entry.api_secret ? 'PASS' : 'FAIL',
    detail: entry.api_key && entry.api_secret ? 'present' : 'missing api_key/api_secret',
  })
  checks.push({
    name: 'passphrase',
    status: (entry.exchange === 'okx' || entry.exchange === 'kucoin') && !entry.api_passphrase ? 'FAIL' : 'PASS',
    detail: entry.exchange === 'okx' || entry.exchange === 'kucoin' ? 'required' : 'not required',
  })
  checks.push({
    name: 'ip allow list',
    status: ipAllowListMatches(entry) ? 'PASS' : 'FAIL',
    detail: JSON.stringify(entry.ip_allow_list),
  })

  if (entry.exchange === 'kucoin') {
    checks.push({
      name: 'capital',
      status: 'WARN',
      detail: 'skipped; KuCoin sub balance is not queryable by master key',
    })
  } else {
    const balance = await adapter.getSubAccountUsdtBalance(entry.sub_account_id)
    const ok = Math.abs(balance - targetCapital) <= 0.01
    checks.push({
      name: 'capital',
      status: ok ? 'PASS' : 'FAIL',
      detail: `${balance.toFixed(2)} USDT, target ${targetCapital.toFixed(2)} USDT`,
    })
  }

  if (!exchangeSupportsRename(entry.exchange)) {
    checks.push({ name: 'label', status: 'WARN', detail: 'exchange-side rename is not supported' })
  } else {
    const ok = discovered?.label === entry.sub_account_label
    checks.push({
      name: 'label',
      status: ok ? 'PASS' : 'FAIL',
      detail: discovered ? `${discovered.label} expected ${entry.sub_account_label}` : 'sub-account not found',
    })
  }

  return { pass: checks.every(check => check.status !== 'FAIL'), checks }
}

async function main() {
  const { strategy, exchange, capital, label, registryPath } = parseArgs()
  const targetExchangeLabel = exchangeLabel(exchange, label)
  const registry = ensureRegistryExists(registryPath)
  let adapter = buildAdapter(exchange, targetExchangeLabel)
  const now = new Date().toISOString()

  let entryIndex = registry.combinations.findIndex(
    entry => entry.exchange === exchange && entry.assigned_strategy === strategy
  )
  let entry = entryIndex >= 0 ? registry.combinations[entryIndex] : undefined
  let assumedCurrentBalance: number | undefined
  let existingExchangeLabel: string | undefined

  if (entry) {
    console.log(`Reusing assigned sub-account ${entry.sub_account_id} for (${strategy}, ${exchange})`)
    assumedCurrentBalance = entry.exchange === 'kucoin' ? entry.allocated_capital_usdt : undefined
  } else {
    entryIndex = findLruIdleIndex(registry, exchange)
    entry = entryIndex >= 0 ? registry.combinations[entryIndex] : undefined
    if (entry) {
      console.log(`Assigning idle sub-account ${entry.sub_account_id} to (${strategy}, ${exchange})`)
      assumedCurrentBalance = entry.exchange === 'kucoin' ? entry.allocated_capital_usdt : undefined
      existingExchangeLabel = entry.sub_account_label
      entry.assigned_strategy = strategy
      entry.status = 'provisioning'
      entry.last_assigned_at = now
    } else {
      console.log(`No reusable idle sub-account available for ${exchange}; creating ${targetExchangeLabel}`)
      const sub = await adapter.createSubAccount(targetExchangeLabel)
      entry = {
        exchange,
        sub_account_id: sub.subAccountId,
        sub_account_label: sub.subAccountLabel ?? targetExchangeLabel,
        assigned_strategy: strategy,
        api_key: '',
        api_secret: '',
        api_passphrase: null,
        ip_allow_list: [...REQUIRED_IP_ALLOW_LIST],
        allocated_capital_usdt: 0,
        provisioning_mode: adapter.mode,
        status: 'provisioning',
        created_at: now,
        last_assigned_at: now,
        notes: '',
      }
      registry.combinations.push(entry)
      entryIndex = registry.combinations.length - 1
      assumedCurrentBalance = exchange === 'kucoin' ? 0 : undefined
    }
  }

  if (!entry.sub_account_label || exchangeSupportsRename(exchange)) {
    entry.sub_account_label = targetExchangeLabel
  }
  entry.provisioning_mode = adapter.mode
  entry.ip_allow_list = [...REQUIRED_IP_ALLOW_LIST]

  if (exchange === 'kucoin' && existingExchangeLabel) {
    adapter = buildAdapter(exchange, existingExchangeLabel)
  }

  try {
    if (!entry.api_key || !entry.api_secret) {
      console.log(`Creating API key for sub-account ${entry.sub_account_id}`)
      const key = await adapter.createApiKey(entry.sub_account_id, entry.ip_allow_list)
      entry.api_key = key.apiKey
      entry.api_secret = key.apiSecret
      entry.api_passphrase = key.apiPassphrase ?? entry.api_passphrase
    } else {
      console.log(`Reusing registry API key ${entry.api_key.slice(0, 6)}...`)
    }
    if (adapter.ensureApiKeyPermissions && entry.api_key) {
      console.log(`Ensuring API key permissions for sub-account ${entry.sub_account_id}`)
      await adapter.ensureApiKeyPermissions(
        entry.sub_account_id,
        entry.api_key,
        entry.api_passphrase,
        entry.ip_allow_list
      )
    }

    try {
      await adapter.renameSubAccount(entry.sub_account_id, targetExchangeLabel)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/RenameNotSupported/i.test(msg)) {
        console.warn(`Rename warning: ${msg}; registry label updated only`)
      } else {
        throw err
      }
    }

    console.log(`Reconciling capital to ${capital.toFixed(2)} USDT`)
    const reconcileOptions = assumedCurrentBalance === undefined ? {} : { assumedCurrentBalance }
    const reconcile = await reconcileCapital(adapter, entry.sub_account_id, capital, reconcileOptions)
    if (reconcile.direction === 'none') {
      console.log(`Capital already at target (${reconcile.before.toFixed(2)} USDT)`)
    } else {
      console.log(`Transferred ${reconcile.transferred.toFixed(2)} USDT (${reconcile.direction})`)
    }

    entry.allocated_capital_usdt = capital
    entry.status = 'active'
    entry.notes = ''
    registry.combinations[entryIndex] = entry
    saveRegistry(registryPath, registry)

    const verification = await verifyReady(entry, adapter, strategy, capital)
    printChecks(verification.checks)
    if (!verification.pass) process.exit(1)
  } catch (err) {
    entry.status = 'failed'
    entry.notes = err instanceof Error ? err.message : String(err)
    registry.combinations[entryIndex] = entry
    saveRegistry(registryPath, registry)
    throw err
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
