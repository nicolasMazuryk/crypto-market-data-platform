#!/usr/bin/env tsx
/**
 * Out-of-sample (OOS) backtest driver.
 *
 * Re-runs the best ("default") and handpicked ("changed") autoresearch configs
 * for each strategy-exchange pair over an UNSEEN window (2026-04-16 → 2026-07-26)
 * to check whether the tuned parameters generalize or were overfit.
 *
 * Data source is the REMOTE Hetzner ClickHouse ONLY (local CH is a stale subset).
 * Reach it via the SSH tunnel:
 *
 *   1) npm run tunnel:clickhouse            # localhost:18123 -> remote:8123
 *   2) export CLICKHOUSE_HOST=localhost CLICKHOUSE_HTTP_PORT=18123 \
 *             CLICKHOUSE_USER=arbinet \
 *             CLICKHOUSE_PASSWORD=<remote CH password from /opt/arbinet/.env>
 *   3) npx tsx scripts/oos-backtest.ts [--only <substr>]
 *
 * Shell-exported CLICKHOUSE_* win over .env (dotenv does not override existing env).
 * The driver runs a preflight that ABORTS unless the connected DB actually holds
 * OOS funding data — so a misconfigured (local) connection can't silently produce
 * empty results.
 *
 * Config reconstruction per iteration (verified against src/autoresearch/loop/iteration.ts):
 *   - keep iter:    `git show <commit>:config/strategies/<strategy>.yaml` is exact.
 *   - discard iter: `<commit>` is the pre-iteration (last-kept) config; the tried
 *                   config = that base + the single-param overlay below (the diff-gate
 *                   enforces one-param edits, so this is exact). `expectOld` guards it.
 *
 * Nothing under git control is mutated: strategy + base configs are materialized to
 * a scratch dir and passed to runBacktest() directly.
 */
import 'dotenv/config'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { runBacktest } from '../src/backtesting/index.js'
import { getClickHouseClient, closeClickHouseClient } from '../src/db/client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const OOS_START = '2026-04-16 00:00:00'
const OOS_END = '2026-07-26 00:00:00'

const OUT_DIR = join(REPO_ROOT, 'reports', 'oos-review')
const TMP_DIR = join(OUT_DIR, '.tmp')
const RESULTS_DIR = join(REPO_ROOT, '.autoresearch', 'results')

interface Overlay {
  /** Flat scalar param to override after `git show`. */
  param: string
  /** Literal to write into the YAML (preserves formatting, e.g. "2.0"). */
  value: string
  /** Expected pre-overlay value; guards against a shifted base commit. */
  expectOld: number
}

interface Run {
  tag: string
  strategy: string
  exchange: string
  iter: number
  label: 'default' | 'changed'
  status: 'keep' | 'discard'
  commit: string
  overlay?: Overlay
}

// Resolved from .autoresearch/results/<tag>/results.tsv (commit_hash column) and
// proposals/iter_N.json (overlay deltas). See plan file.
// All five iterations below are `keep` iterations, so `git show <commit>:<config>` is exact and
// no overlay reconstruction is needed. The two `default` commits equal state.json.best_commit.
const RUNS: Run[] = [
  { tag: 'strategy_2-bitget', strategy: 'strategy_2', exchange: 'bitget', iter: 38, label: 'default', status: 'keep', commit: '6159ca8f369fcae9a4e0b1f6d1a84d8d322e76eb' },
  { tag: 'strategy_2-bitget', strategy: 'strategy_2', exchange: 'bitget', iter: 18, label: 'changed', status: 'keep', commit: '17a905e4aea563f338e57629ace594c7ec387f9e' },
  { tag: 'strategy_2-bitget', strategy: 'strategy_2', exchange: 'bitget', iter: 13, label: 'changed', status: 'keep', commit: '71ba7c2be516c74975efba24768d391ff9896781' },
  { tag: 'strategy_4_2a-bitget', strategy: 'strategy_4_2a', exchange: 'bitget', iter: 23, label: 'default', status: 'keep', commit: 'b33d047213cdc79e35a2cc6db84c29f858f55100' },
  { tag: 'strategy_4_2a-bitget', strategy: 'strategy_4_2a', exchange: 'bitget', iter: 10, label: 'changed', status: 'keep', commit: '556d439c8b63f232503faf6551d7f484511e6f37' },
]

interface MetricSet {
  total_net_pnl: number | null
  sharpe: number | null
  win_rate: number | null
}

interface ManifestRow {
  run_id: string
  tag: string
  strategy: string
  exchange: string
  iter: number
  label: string
  status: string
  base_commit: string
  overlay: string | null
  config_params: Record<string, unknown>
  report_json: string | null
  report_png: string | null
  events_triggered: number | null
  trades_executed: number | null
  max_drawdown_pct: number | null
  ulcer_index: number | null
  oos: MetricSet
  in_sample: MetricSet
  pnl_delta: number | null
  error: string | null
}

function runId(r: Run): string {
  return `${r.tag}__iter${String(r.iter)}__${r.label}`
}

function gitShow(commit: string, filePath: string): string {
  return execFileSync('git', ['show', `${commit}:${filePath}`], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).toString()
}

/** Replace a flat `key: value` scalar, preserving indentation + trailing comment. */
function applyOverlay(text: string, overlay: Overlay): string {
  const re = new RegExp(`^(\\s*${overlay.param}:\\s*)(\\S+)([^\\n]*)$`, 'm')
  const m = re.exec(text)
  if (!m) throw new Error(`overlay param '${overlay.param}' not found in config`)
  const oldNum = Number.parseFloat(m[2])
  if (!Number.isFinite(oldNum) || Math.abs(oldNum - overlay.expectOld) > 1e-9) {
    throw new Error(
      `overlay guard failed for '${overlay.param}': base has ${m[2]}, expected ${String(overlay.expectOld)} — base commit may have shifted`
    )
  }
  return text.replace(re, `$1${overlay.value}$3`)
}

/** Build the per-run base config (base_config.yaml + exchange/date/output_dir). */
function buildBaseConfig(exchange: string, outputDir: string): string {
  const baseRaw = readFileSync(join(REPO_ROOT, 'config', 'base_config.yaml'), 'utf8')
  const base = parseYaml(baseRaw) as Record<string, unknown>
  base.exchange = exchange
  base.start_date = OOS_START
  base.end_date = OOS_END
  const reporting = (base.reporting ?? {}) as Record<string, unknown>
  reporting.output_dir = outputDir
  base.reporting = reporting
  return stringifyYaml(base)
}

/** Read the in-sample metrics for iter N from results.tsv. */
function inSampleMetrics(tag: string, iter: number): MetricSet {
  const tsvPath = join(RESULTS_DIR, tag, 'results.tsv')
  if (!existsSync(tsvPath)) return { total_net_pnl: null, sharpe: null, win_rate: null }
  const lines = readFileSync(tsvPath, 'utf8').split('\n')
  for (const line of lines.slice(1)) {
    const c = line.split('\t')
    if (c[0] === String(iter)) {
      const num = (s: string | undefined): number | null => {
        const v = Number.parseFloat(s ?? '')
        return Number.isFinite(v) ? v : null
      }
      return { total_net_pnl: num(c[3]), sharpe: num(c[4]), win_rate: num(c[5]) }
    }
  }
  return { total_net_pnl: null, sharpe: null, win_rate: null }
}

/** Count OOS-window rows per exchange for one table. */
async function countByExchange(table: string, timeColumn: string): Promise<Map<string, number>> {
  const client = getClickHouseClient()
  const rs = await client.query({
    query: `SELECT exchange, count() AS c FROM arbinet.${table}
            WHERE ${timeColumn} >= {s:DateTime} AND ${timeColumn} < {e:DateTime}
            GROUP BY exchange ORDER BY exchange`,
    query_params: { s: OOS_START, e: OOS_END },
    format: 'JSONEachRow',
  })
  const rows = (await rs.json()) as { exchange: string; c: string }[]
  return new Map(rows.map(r => [r.exchange, Number(r.c)]))
}

/**
 * The engine reads BOTH funding_rates (data/funding-events.ts) and orderbooks
 * (db/queries/orderbooks.ts). A DB with funding but no orderbooks yields silent
 * zero-trade reports, so both are checked.
 */
async function preflight(): Promise<void> {
  const host = process.env.CLICKHOUSE_HOST ?? '?'
  const port = process.env.CLICKHOUSE_HTTP_PORT ?? '?'
  console.log(`[preflight] ClickHouse http://${host}:${port} — verifying OOS funding + orderbook data…`)

  const funding = await countByExchange('funding_rates', 'funding_time')
  const orderbooks = await countByExchange('orderbooks', 'ts')

  const needed = [...new Set(RUNS.map(r => r.exchange))]
  const missing: string[] = []
  for (const ex of needed) {
    const f = funding.get(ex) ?? 0
    const o = orderbooks.get(ex) ?? 0
    console.log(`  ${ex.padEnd(10)} funding=${String(f)} orderbooks=${String(o)}`)
    if (f === 0) missing.push(`${ex}/funding_rates`)
    if (o === 0) missing.push(`${ex}/orderbooks`)
  }
  if (missing.length > 0) {
    throw new Error(
      `No OOS data for: ${missing.join(', ')}. ` +
        `Connected DB lacks the ${OOS_START}..${OOS_END} window. ` +
        `Start the tunnel (npm run tunnel:clickhouse) and export CLICKHOUSE_HTTP_PORT=18123 + remote CLICKHOUSE_PASSWORD.`
    )
  }
}

function fmt(v: number | null, digits = 4): string {
  return v === null ? '—' : v.toFixed(digits)
}

function writeSummary(manifest: ManifestRow[]): void {
  const header = [
    '# OOS Backtest Summary',
    '',
    `Window: **${OOS_START} → ${OOS_END}** (out-of-sample; autoresearch tuned on 2025-01-01 → 2026-04-16).`,
    `Data source: remote Hetzner ClickHouse. Generated ${new Date().toISOString()}.`,
    '',
    '`pnl_delta` = OOS `total_net_pnl` − in-sample `total_net_pnl`. Large negative deltas flag overfit configs.',
    '',
    'Reports live in `reports/oos-review/<run_id>/`; `report` is the JSON basename, the equity-curve',
    'chart is the same name with `.json` → `.time.png`. `manifest.json` holds the full mapping.',
    '',
    '| strategy-exchange | label | iter | key params | OOS pnl | IS pnl | Δpnl | OOS sharpe | OOS win% | trades | maxDD% | run_id | report |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  const rows = [...manifest].sort((a, b) => a.tag.localeCompare(b.tag) || a.label.localeCompare(b.label) || a.iter - b.iter)
  for (const r of rows) {
    if (r.error) {
      header.push(`| ${r.tag} | ${r.label} | ${String(r.iter)} | — | ❌ ${r.error} | | | | | | | ${r.run_id} | ${basename(r.report_json ?? '—')} |`)
      continue
    }
    const p = r.config_params
    const keys = Object.keys(p).filter(k => k !== 'strategy_id' && k !== 'direction')
    const paramStr = keys.map(k => `${k}=${String(p[k])}`).join(', ')
    const win = r.oos.win_rate === null ? '—' : (r.oos.win_rate * 100).toFixed(1)
    const dd = r.max_drawdown_pct === null ? '—' : (r.max_drawdown_pct * 100).toFixed(2)
    header.push(
      `| ${r.tag} | ${r.label} | ${String(r.iter)} | ${paramStr} | ${fmt(r.oos.total_net_pnl)} | ${fmt(r.in_sample.total_net_pnl)} | ${fmt(r.pnl_delta)} | ${fmt(r.oos.sharpe, 2)} | ${win} | ${String(r.trades_executed ?? '—')} | ${dd} | ${r.run_id} | ${basename(r.report_json ?? '—')} |`
    )
  }
  header.push('')
  writeFileSync(join(OUT_DIR, 'SUMMARY.md'), header.join('\n'))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let onlyFilter: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && args[i + 1]) {
      onlyFilter = args[i + 1]
      i++
    }
  }

  const runs = onlyFilter ? RUNS.filter(r => runId(r).includes(onlyFilter as string)) : RUNS
  if (runs.length === 0) {
    console.error(`No runs match --only '${onlyFilter ?? ''}'`)
    process.exit(1)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })

  await preflight()

  const manifest: ManifestRow[] = []

  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    const id = runId(r)
    const perRunDir = join(OUT_DIR, id)
    console.log(`\n[${String(i + 1)}/${String(runs.length)}] ${id}  (${r.exchange}, ${r.status}, ${r.commit})`)

    const row: ManifestRow = {
      run_id: id,
      tag: r.tag,
      strategy: r.strategy,
      exchange: r.exchange,
      iter: r.iter,
      label: r.label,
      status: r.status,
      base_commit: r.commit,
      overlay: r.overlay ? `${r.overlay.param}=${r.overlay.value}` : null,
      config_params: {},
      report_json: null,
      report_png: null,
      events_triggered: null,
      trades_executed: null,
      max_drawdown_pct: null,
      ulcer_index: null,
      oos: { total_net_pnl: null, sharpe: null, win_rate: null },
      in_sample: inSampleMetrics(r.tag, r.iter),
      pnl_delta: null,
      error: null,
    }

    try {
      let strategyText = gitShow(r.commit, `config/strategies/${r.strategy}.yaml`)
      if (r.overlay) strategyText = applyOverlay(strategyText, r.overlay)
      const params = parseYaml(strategyText) as Record<string, unknown>
      row.config_params = params
      // Post-build assertion for overlays.
      if (r.overlay) {
        const got = Number(params[r.overlay.param])
        if (Math.abs(got - Number.parseFloat(r.overlay.value)) > 1e-9) {
          throw new Error(`overlay verify failed: ${r.overlay.param}=${String(got)} != ${r.overlay.value}`)
        }
      }

      mkdirSync(perRunDir, { recursive: true })
      const strategyPath = join(TMP_DIR, `${id}.strategy.yaml`)
      const basePath = join(TMP_DIR, `${id}.base.yaml`)
      writeFileSync(strategyPath, strategyText)
      writeFileSync(basePath, buildBaseConfig(r.exchange, perRunDir))

      const { report, reportPath } = await runBacktest(strategyPath, basePath)

      row.report_json = reportPath
      row.report_png = reportPath.replace(/\.json$/, '.time.png')
      row.events_triggered = report.trade_stats.events_triggered
      row.trades_executed = report.trade_stats.trades_executed
      row.max_drawdown_pct = report.risk_metrics.max_drawdown_pct
      row.ulcer_index = report.equity_curve_metrics?.ulcer_index ?? null
      row.oos = {
        total_net_pnl: report.return_metrics.total_net_pnl,
        sharpe: report.risk_metrics.sharpe_ratio,
        win_rate: report.win_loss.win_rate,
      }
      if (row.oos.total_net_pnl !== null && row.in_sample.total_net_pnl !== null) {
        row.pnl_delta = row.oos.total_net_pnl - row.in_sample.total_net_pnl
      }
      if (report.trade_stats.events_triggered === 0) {
        row.error = 'zero events triggered (check exchange/data)'
        console.warn(`  ⚠ ${row.error}`)
      } else {
        console.log(
          `  ✓ OOS pnl=${fmt(row.oos.total_net_pnl)} sharpe=${fmt(row.oos.sharpe, 2)} trades=${String(row.trades_executed)} (IS pnl=${fmt(row.in_sample.total_net_pnl)})`
        )
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err)
      console.error(`  ✗ ${row.error}`)
    }

    manifest.push(row)
    // Persist incrementally so a mid-run crash keeps completed results.
    writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
    writeSummary(manifest)
  }

  await closeClickHouseClient()

  const ok = manifest.filter(m => !m.error).length
  console.log(`\nDone: ${String(ok)}/${String(manifest.length)} runs succeeded.`)
  console.log(`  manifest: ${join(OUT_DIR, 'manifest.json')}`)
  console.log(`  summary:  ${join(OUT_DIR, 'SUMMARY.md')}`)
  if (ok < manifest.length) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error)
  void closeClickHouseClient().finally(() => process.exit(1))
})
