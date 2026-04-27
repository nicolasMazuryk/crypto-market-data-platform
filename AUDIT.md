# Execution Engine Deployment Audit

Produced as part of Step 1 of the deploy-execution-engine plan.
Covers the 38 uncommitted files introduced on `nicolasMazuryk/exec-engine-arch`.

---

## 1. Fault-Tolerance Gaps

### No Ansible role for the execution engine
The engine (`src/execution/`) is fully implemented with graceful shutdown, position recovery, and Prometheus metrics, but there is no systemd unit, Docker Compose service, or Ansible role that deploys or supervises it in production. The production template `ansible/roles/app/templates/docker-compose.prod.yml.j2` defines only cron-style worker containers and infrastructure services (ClickHouse, Postgres). The execution engine cannot be started, restarted, or health-checked by any existing automation.

### Postgres: local-only backups, no replication
`ansible/roles/postgres/tasks/main.yml` installs a daily `pg_dump` cron at 02:30 UTC with 7-day retention, but dumps remain on local disk at `/data/backups/postgres/`. There is no off-server upload (no rsync to object storage, no Hetzner snapshot, no Restic/Borg). Single-node Postgres — if the Hetzner server fails, all execution state (positions, WAL) is lost with it.

### Persistence failure silently falls back to ephemeral mode
`src/execution/index.ts` lines 297–299: if `openDb()` throws at startup, the engine logs a warning and continues without persistence. In live mode this means positions are not recovered on restart. No alert or page fires on this path — the engine appears healthy while operating with no durable state.

### No exchange API key failover
If an API key is revoked mid-session (exchange-initiated rotation, security incident), the engine submits intents that are rejected at the exchange with no fallback. No secondary-key variable exists in Ansible or `.env.example`.

### Drain semantics mismatch in scripts
`src/execution/scripts/lib/graceful-shutdown.ts` implements a 10-second timer drain (pure `setTimeout`) followed by `handle.stop()`. The sophisticated engine shutdown in `src/execution/index.ts` `stop()` — flatten open positions, wait 8 s for fills, cancel residual orders, flush WAL, close DB, disconnect WS — is wired only to `process.on('SIGTERM')` inside `main()`. If any entry script uses the library `gracefulShutdown()` helper directly on an `EngineHandle`, the engine receives `handle.stop()` immediately with no position-flatten step. Risk: positions may be left open on SIGTERM via those entry points.

---

## 2. Logging Gaps

### No log rotation
`src/logger.ts` opens three unbounded file streams: `logs/combined.log` (all levels), `logs/warn.log`, `logs/error.log`. No `pino-roll`, no `logrotate` config, no size or time cap. On a long-running production process these grow without bound.

### Missing redaction paths
Current redact list: `['*.token', '*.secret', '*.password']`. Missing: `*.apiKey`, `*.passphrase`, `*.privateKey`, `*.cookie`. Exchange adapters in `src/execution/adapters/` log credential-bearing config objects at debug level in several places. A debug-level log burst during a credential-config reload would expose API keys.

### No correlation_id / strategy_id standardization
`src/execution/core/logger.ts` exposes `childFor(service, extra?)` but there is no enforcement of `strategy_id` or `correlation_id` fields on log entries. Different emitters use different field names for the same intent, making log correlation across the intent lifecycle unreliable.

### Misleading production log comment
`src/logger.ts` line 74 comment says `// JSON logs to stdout in production for CloudWatch`. Production is Hetzner/Docker with journald, not AWS CloudWatch. The comment is a stale relic and will mislead.

### No Loki / promtail / remote log shipping
Logs only reach journald on the host and local `logs/` files. The Loki + Grafana stack exists only in `docker/docker-compose.yml` (local dev). No promtail role or task deploys log shipping to production. If the server fails, all logs are gone.

---

## 3. Alerting Gaps

### Prometheus alert rules are not deployed to production
`docker/prometheus/rules/execution-engine.yml` defines 8 alert groups covering: engine down, kill-switch trip, WS disconnect, persistence drops, no fills around funding, high reject rate, stale funding snapshots, and reconnect storms. The Prometheus + Grafana + Jaeger stack exists only in `docker/docker-compose.yml` (local dev). There is no Ansible role or playbook task to deploy it to Hetzner. All alert rules are dead letters in production.

### No Alertmanager → receiver path
Even when Prometheus runs locally, there is no `alertmanager.yml`, no receiver, and no Slack/Telegram/PagerDuty webhook wired to the defined alert rules. The alerts fire only into Prometheus's internal TSDB with no external delivery.

### Kill-switch trip fires no external alert
`src/execution/risk/killSwitch.ts` `trip()` logs `warn` and updates in-memory state. Nothing consumes this signal for external notification. `kill_switch_mode` metric is registered and the Prometheus rule `KillSwitchHalted` exists — but since Prometheus is not deployed, this effectively goes nowhere.

### Health-check is the only production alert
`ansible/roles/monitoring/` fires a Slack POST every 3 minutes for the ClickHouse HTTP ping. No production alerting covers: execution engine crash, exchange WS disconnect, order rejection spike, PnL drawdown, or Postgres unavailability.

### No PnL envelope or drawdown cap alert
`config/execution.live.yaml` sets `globalMaxNotionalUsd: 1000000` with `acknowledgeUncapped: true`. There is no daily drawdown cap, no cumulative loss alarm, and no operator notification before the kill switch is tripped.

---

## 4. Redeploy Hazards

### Deploy unconditionally restarts ClickHouse and Postgres
`ansible/playbooks/deploy.yml` lines 52–80 run `docker compose up -d clickhouse` and `docker compose up -d postgres` unconditionally on every deploy. If the execution engine is live and holding a Postgres connection, this interrupts the DB mid-trade. No `when:` guard checks whether the engine is running before restarting infrastructure services.

### No graceful-stop before deploy
The deploy playbook has no task to SIGTERM or drain the execution engine before pulling code and restarting containers. A deploy during a live funding window leaves open positions with no reconciliation.

### In-place git deploy, no atomic rollback
The `ansible.builtin.git` task uses `force: true` on `dest: {{ repo_dir }}`. Code is pulled in place over the live directory. There is no release-directory structure. Rollback requires a re-run of the deploy playbook with a manually specified branch or tag — no single-command rollback exists.

### `EXECUTION_POSTGRES_URL` absent from production env template
`ansible/roles/app/templates/env.prod.j2` templates the individual Postgres connection parts (`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`) but **not** `EXECUTION_POSTGRES_URL`, which is what the execution engine config loader reads. On production the engine would silently fall back to ephemeral mode (no persistence) because `postgresUrl` would be undefined.

### Exchange API credentials absent from production env template
`env.prod.j2` contains no exchange credential variables (`BINANCE_API_KEY`, `OKX_API_KEY`, etc.). The execution engine cannot authenticate to any exchange from the current production template. It would start, connect to no exchange, and produce no trades.

---

## 5. Secret Hazards

### Real Slack webhook committed to version control
`.env.example` line 63 and `ansible/group_vars/all.yml` line 54 contain:
```
REDACTED
```
This appears to be a real active Slack webhook. It is checked into git and will appear in full git history. Slack incoming webhooks are not scoped — anyone with the URL can POST to the workspace channel. **Rotate this URL immediately** and replace with a placeholder (`https://hooks.slack.com/services/REPLACE/ME/HERE`). Do this before merging this branch.

### ClickHouse password hardcoded in group_vars
`ansible/group_vars/all.yml` line 22: `clickhouse_password: <OBSERVABILITY_PASSWORD>`. The same password appears in `.env.example` line 19. Both are committed to version control in plaintext.

### Ansible vault not configured
`ansible/group_vars/all.yml` comment for `postgres_password`: `# set via Ansible vault or env`. No `vault.yml` exists, no vault password configuration in `ansible.cfg`, and Ansible vault is inactive. Exchange API keys, Postgres password, and Slack webhook would be written in plaintext to `/opt/arbinet/.env` on the server.

### Grafana admin password hardcoded
`docker/docker-compose.yml` line 70: `GF_SECURITY_ADMIN_PASSWORD=***REMOVED***`. Even for local dev this should be an env-var reference.

---

## Appendix: Commit Map for This Branch

| Commit | Files | Concern |
|--------|-------|---------|
| feat(execution): add execution engine, configs, and Drizzle schema | `src/execution/`, `config/execution.*.yaml`, `drizzle.config.ts` | New execution engine |
| feat(infra): add Postgres role and wire into Ansible and env templates | `ansible/roles/postgres/`, `ansible/group_vars/all.yml`, `ansible/playbooks/{setup,deploy}.yml`, `ansible/roles/app/templates/{docker-compose.prod.yml.j2,env.prod.j2}`, `.env.{dev,example,prod}` | Postgres infra |
| feat(observability): add Prometheus, Grafana, Jaeger to local dev stack | `docker/grafana/`, `docker/prometheus/`, `docker/docker-compose.yml` | Local observability |
| chore: autoresearch, backtesting, db, logger, and lint touchups | `src/logger.ts`, `src/autoresearch/**`, `src/backtesting/**`, `src/db/**`, `src/exchanges/**`, `src/quotes/**`, `src/scripts/**`, `src/utils/**`, `eslint.config.js` | Misc cleanup |
| chore(deps): bump packages for Drizzle and execution engine | `package.json`, `package-lock.json` | Dependency bump |
| docs: execution engine deployment audit | `AUDIT.md` | Audit deliverable |
