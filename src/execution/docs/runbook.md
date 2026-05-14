# Execution Engine — Runbook

> **Real capital is at stake.** Read this document in full before touching any production command.
> When in doubt, the safe choice is dry-run mode and paging a human.

---

## Quick Reference

| Goal | Command |
|------|---------|
| Normal deploy (dry-run, out of hours) | `npm run deploy -- -e deploy_execution=true` |
| Promote to live mode | `npm run deploy -- -e deploy_execution=true -e execution_mode=live -e execution_engine_enabled=true` |
| Deploy with in-hours acknowledgement | add `-e allow_in_hours_deploy=true` |
| Rollback to previous SHA | `ansible-playbook ansible/playbooks/rollback-execution.yml -e target_sha=<sha>` |
| Get current running SHA | `ssh server 'cat /opt/arbinet/execution/current/release'` |
| Validate config locally | `npm run config:validate -- --config config/execution.live.yaml` |
| Smoke-test alert path | `npm run alerts:test -- --severity page --message "pre-deploy smoke test"` |
| Tail execution engine logs | `ssh server 'sudo journalctl -u execution-engine@dry-run -f'` |
| Check engine health | `ssh server 'curl -s http://127.0.0.1:9466/ready'` |
| Start dry-run manually | `ssh server 'sudo systemctl start execution-engine@dry-run'` |
| Stop engine gracefully | `ssh server 'sudo systemctl stop execution-engine@dry-run'` |

---

## Trading-Window Guards

Never deploy, restart, or roll back when a funding settlement is imminent. Avoid these UTC windows:

| Window | Duration |
|--------|----------|
| 23:55–00:05 | ±5 min around midnight |
| 07:55–08:05 | ±5 min around 08:00 |
| 15:55–16:05 | ±5 min around 16:00 |

During these windows, open positions may be entering or exiting. Any forced service stop risks leaving orphaned orders on the exchange.

---

## Start Locally (End-to-End)

Use this to verify the full engine stack works on a developer machine before deploying.

### 1. Start Postgres

```bash
npm run db:postgres:up
```

Wait ~5 seconds for the container to initialize, then confirm:

```bash
docker exec arbinet-postgres pg_isready -U arbinet
```

Expected: `localhost:5432 - accepting connections`

### 2. Apply migrations

```bash
npm run execution:migrate
```

### 3. Validate config

```bash
npm run config:validate -- --config config/execution.dry-run.yaml
```

Expected: `Config valid` with no errors. See [configuration.md](./configuration.md) for config layout and precedence.

### 4. Start the engine in dry-run mode

```bash
npm run execution:dry-run
```

Watch for these startup log events (in order):

```
{"event":"engine.starting","mode":"dry_run",...}
{"event":"lifecycle.markets_fetched",...}
{"event":"lifecycle.adapters_connected",...}
{"event":"lifecycle.recovery_complete",...}
{"event":"engine.ready",...}
```

### 5. Verify health and metrics

```bash
# Health endpoint
curl http://127.0.0.1:9466/ready
# Expected: {"status":"ready"}

# Metrics (spot-check)
curl -s http://127.0.0.1:9464/metrics | grep -E "^(execution_|process_)" | head -10
```

### 6. Smoke-test alerts (optional but recommended)

```bash
npm run alerts:test -- --severity info --message "local smoke test"
```

Confirm the message arrives in Slack `#trading-ops`.

### Tear down

```bash
npm run db:postgres:down
```

---

## Run a Strategy End-to-End

### Phase 1 — Dry-run (shadow mode)

Run on a developer machine or the production server with shadow adapters. No orders reach exchanges.

```bash
npm run execution:dry-run
```

Observe dry-run signals in logs: `strategy.eval`, `intent.created`, `order.shadow_submitted`. Check the Grafana dry-run dashboard (see [infrastructure.md — Observability](./infrastructure.md#observability-stack)) for fill counts and position state.

Minimum observation period before advancing: **24 hours with no unhandled alerts**.

### Phase 2 — Promote to live

Only proceed when:
- Dry-run has been running cleanly for ≥ 24 hours post-deploy
- All pre-flight checklist items are satisfied (see [Pre-flight Checklist](#pre-flight-checklist))
- A second engineer is available and watching

```bash
npm run deploy -- \
  --ask-vault-pass \
  -e deploy_execution=true \
  -e execution_engine_enabled=true \
  -e execution_mode=live
```

Verify:

```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'curl -s http://127.0.0.1:9466/ready && \
   sudo journalctl -u execution-engine@live -n 20 --no-pager'
```

Check Grafana → Execution Engine dashboard → mode label shows `live`.

---

## Pre-flight Checklist

Run this checklist **before the first production deploy**. Do not proceed unless every item is checked.

### Secrets

- [ ] All exchange API key variables are set in `ansible/group_vars/all.yml` (or equivalent secrets source)
- [ ] `ansible-playbook ansible/playbooks/deploy.yml --check` runs without errors
- [ ] API keys are trade-scope (futures trading permission), IP-restricted to `203.0.113.10` where the exchange supports it

### Config

- [ ] `npm run config:validate -- --config config/execution.dry-run.yaml` exits 0
- [ ] `npm run config:validate -- --config config/execution.live.yaml` exits 0
- [ ] Live config risk caps reviewed: `acknowledgeUncapped: true` is intentional
- [ ] `execution_engine_enabled: false` in `ansible/group_vars/all.yml` (default safe; override at deploy time)

### Alerting

- [ ] `SLACK_WEBHOOK_URL` is set and tested
- [ ] `npm run alerts:test -- --severity page` delivers a real Slack `<!channel>` mention
- [ ] At least two humans have confirmed they received the test page

### Database

- [ ] Postgres is running: `ssh server 'docker exec arbinet-postgres pg_isready -U arbinet'`
- [ ] Manual backup taken within the last hour: `ssh server 'ls -lt /data/backups/postgres/ | head -5'`
- [ ] Restore from backup tested in a staging environment (see [State Recovery](#state-recovery))

### Observability

- [ ] Grafana is accessible at `http://localhost:3000` via SSH tunnel (see [SSH Tunnel for Local Tools](#ssh-tunnel-for-local-tools))
- [ ] Prometheus scrape targets green: Grafana → Explore → Prometheus → `up{job="execution-engine"}`
- [ ] Loki ingesting dry-run logs: `{service="execution-engine"}` returns results
- [ ] All Grafana dashboard panels for the dry-run instance show green / no gaps

### Functional Testing (dry-run)

- [ ] Dry-run instance has been running for ≥ 24 hours with no unhandled alerts
- [ ] Kill-switch tested: manually breach notional cap in dry-run, confirm `risk.killSwitch.trip` page fires
- [ ] SIGTERM test: `sudo systemctl stop execution-engine@dry-run` → logs show drain → flush → clean exit within 30s
- [ ] Restart after stop: `sudo systemctl start execution-engine@dry-run` → `/ready` 200 within 5 minutes
- [ ] Position state reconstructed correctly from Postgres after restart (check `recovery.complete` log event)

### Deploy Window

- [ ] Deploy scheduled outside funding-rate windows (avoid 23:55–00:05, 07:55–08:05, 15:55–16:05 UTC)
- [ ] On-call rota set, second engineer confirmed available for the deploy window
- [ ] Rollback SHA recorded: `ssh server 'cat /opt/arbinet/execution/current/release'`

---

## Normal Deploy (Out of Market Hours)

Standard procedure for deploying code changes when the live engine is not active or it is confirmed out of trading hours.

### 1. Pre-deploy checks

```bash
# Confirm working tree is clean and branch is main
git status
git log --oneline -5

# Validate config files
npm run config:validate -- --config config/execution.dry-run.yaml
npm run config:validate -- --config config/execution.live.yaml

# Record current rollback SHA before pushing
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'cat /opt/arbinet/execution/current/release 2>/dev/null || echo "no current release"'
```

### 2. Push code

```bash
git push origin main
```

### 3. Deploy infrastructure + dry-run engine

```bash
npm run deploy -- \
  --ask-vault-pass \
  -e deploy_execution=true \
  -e execution_engine_enabled=true \
  -e execution_mode=dry-run
```

The playbook will:
1. Check that the live engine is not running (or fail if it is, unless `allow_in_hours_deploy=true`)
2. Stop the execution engine gracefully (SIGTERM + 30s drain)
3. Pull latest code from `main`
4. Rebuild the Docker image
5. Update ClickHouse, Postgres, observability, and log-shipping stacks
6. Deploy and start the execution engine in dry-run mode
7. Wait for `/ready` HTTP 200 on port 9466

### 4. Verify dry-run startup

```bash
# Check readiness
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'curl -s http://127.0.0.1:9466/ready'
# Expected: {"status":"ready"}

# Tail logs for first 2 minutes
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'sudo journalctl -u execution-engine@dry-run -n 50 --no-pager'
```

Look for these log events in order:
```
{"event":"engine.starting","mode":"dry_run",...}
{"event":"lifecycle.markets_fetched",...}
{"event":"lifecycle.adapters_connected",...}
{"event":"lifecycle.recovery_complete",...}
{"event":"engine.ready",...}
```

Check Prometheus metrics are being scraped:
```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'curl -s http://127.0.0.1:9464/metrics | grep -E "^(execution_|process_)" | head -20'
```

### 5. Promote to live mode (separate decision)

Only proceed if dry-run has been running cleanly for a minimum observation period (recommend ≥ 1 hour post-deploy, more if there were code changes near the execution path).

```bash
npm run deploy -- \
  --ask-vault-pass \
  -e deploy_execution=true \
  -e execution_engine_enabled=true \
  -e execution_mode=live
```

Verify:
```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'curl -s http://127.0.0.1:9466/ready && \
   sudo journalctl -u execution-engine@live -n 20 --no-pager'
```

Check Grafana → Execution Engine dashboard → mode label shows `live`.

---

## Hotfix Deploy (In Market Hours)

Use this only when a critical bug cannot wait for the next out-of-hours window (e.g., a crash loop or risk-system defect that would be worse if left running).

### Before you start

1. Post the reason in `#trading-ops` Slack before running anything:
   ```
   HOTFIX DEPLOY in progress — reason: <reason>
   Rollback SHA: <sha from step 2>
   Second engineer: @<name>
   ```
2. Record the rollback SHA:
   ```bash
   ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
     'cat /opt/arbinet/execution/current/release'
   ```
3. Confirm the second engineer is watching.

### Deploy command

```bash
npm run deploy -- \
  --ask-vault-pass \
  -e deploy_execution=true \
  -e execution_engine_enabled=true \
  -e execution_mode=live \
  -e allow_in_hours_deploy=true
```

The `allow_in_hours_deploy=true` flag bypasses the safety guard that normally blocks deploys when `execution-engine@live.service` is active. The playbook will still stop the engine gracefully (SIGTERM, 30s drain) before updating.

### After deploy

- Re-verify `/ready` 200 within 5 minutes.
- Post confirmation in `#trading-ops`.
- Monitor Grafana for the next 30 minutes.

---

## Rollback

Use rollback when a deploy causes a regression and you need to revert faster than a forward-fix allows.

### 1. Get the target SHA

```bash
# List last 3 deployed releases (newest last)
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'ls -lt /opt/arbinet/execution/releases/ | tail -5'

# Read the release file to confirm SHA + deployed_at
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'cat /opt/arbinet/execution/releases/<sha>/release'
```

### 2. Run rollback

```bash
ansible-playbook ansible/playbooks/rollback-execution.yml \
  --ask-vault-pass \
  -e target_sha=<sha>
```

The playbook will:
1. Verify the release directory and Docker image exist for the target SHA
2. Stop the current service gracefully (SIGTERM + 30s drain)
3. Update the `current` symlink to the rollback SHA
4. Re-template the systemd unit with the rollback image tag
5. Start the service
6. Wait for `/ready` 200 on port 9466

### 3. Verify rollback

```bash
# Confirm SHA
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'cat /opt/arbinet/execution/current/release'

# Confirm ready
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 \
  'curl -s http://127.0.0.1:9466/ready'
```

### Rollback example

```
# Scenario: deploy e84bc2d broke something; roll back to 160ef16

$ ansible-playbook ansible/playbooks/rollback-execution.yml \
    --ask-vault-pass -e target_sha=160ef16

PLAY [Roll back execution engine to a previous release] ****

TASK [Validate target_sha is provided] ... ok
TASK [Check that release directory exists for target SHA] ... ok
TASK [Check that Docker image exists for target SHA] ... ok
TASK [Stop execution engine gracefully before rollback] ... ok (was active, now stopped)
TASK [Update current symlink to target release] ... changed
TASK [Template execution-engine systemd unit with rollback SHA] ... changed
TASK [Reload systemd after unit update] ... ok
TASK [Start execution engine at rollback SHA] ... changed
TASK [Wait for execution engine /ready after rollback] ... ok (retries: 3)
TASK [Report rollback success] ...
  ok: [server] => {"msg": "Rollback complete — execution-engine@dry-run is running arbinet:160ef16"}

PLAY RECAP: server ok=10 changed=3 failed=0
```

If the rollback target image was pruned (docker image gc), rebuild from that SHA:
```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10
cd /opt/arbinet/repo
git checkout <sha>
docker build -t arbinet:<sha> .
git checkout main
```
Then re-run the rollback playbook.

---

## On-Call Response Guide

### `adapter.broker_disconnect`

**What it means:** A WebSocket connection to one exchange has been down for more than 30 seconds.

**Immediate steps:**
```bash
# Check which exchange is disconnected
ssh server 'sudo journalctl -u execution-engine@live -n 100 --no-pager | grep broker_disconnect'

# Check exchange status pages:
# Binance: https://www.binancezh.io/en/support/announcement
# Bybit:   https://announcements.bybit.com
# OKX:     https://www.okx.com/support/hc/en-us

# Check if it's a server-side network issue
ssh server 'ping -c 5 api.binance.com'
```

**If the exchange is having an outage:**
- The engine will keep retrying. Monitor for 5 minutes.
- If the disconnect persists > 5 minutes and positions are open: consider stopping the engine (`sudo systemctl stop execution-engine@live`) to prevent orders from firing without a price feed.
- Post status in `#trading-ops`.

**If the network looks healthy but the adapter is stuck:**
```bash
# Restart just the engine (graceful — will drain open positions first)
ssh server 'sudo systemctl restart execution-engine@live'
```

**Escalate if:** disconnect persists > 15 minutes on a major exchange while positions are open.

---

### `lifecycle.unexpected_halt` / `ops.fatal`

**What it means:** The engine crashed or received an unhandled fatal error. systemd will attempt to restart it.

**Immediate steps:**
```bash
# Check exit reason
ssh server 'sudo journalctl -u execution-engine@live -n 200 --no-pager | tail -50'

# Check if systemd restarted it successfully
ssh server 'systemctl status execution-engine@live'

# Check /ready
ssh server 'curl -s http://127.0.0.1:9466/ready'
```

**If the engine restarted cleanly:**
- Check logs for `recovery.complete` — confirms position state was reconstructed from Postgres.
- Check for orphaned Postgres WAL entries: `{"event":"wal.replay_count","count":N}` at startup.
- Monitor for 10 minutes; post status in `#trading-ops`.

**If the engine is crash-looping (systemd StartLimitBurst exceeded):**
The paging unit `execution-engine-page@live.service` will have already fired. To investigate without auto-restart:
```bash
ssh server 'sudo systemctl stop execution-engine@live'
# Read last 500 lines of logs
ssh server 'sudo journalctl -u execution-engine@live -n 500 --no-pager > /tmp/engine-crash.log'
```

Fix the root cause, then redeploy or rollback. Do not restart manually until you understand why it crashed.

---

### `risk.killSwitch.trip`

**What it means:** The risk engine tripped the kill switch (notional cap or concurrent-intent cap exceeded). Halt mode blocks new orders; it does not flatten existing positions. Existing positions may remain open until their normal exits unless an operator explicitly runs a flatten action.

**Immediate steps:**
```bash
# Check which cap was breached and current state
ssh server 'sudo journalctl -u execution-engine@live -n 100 --no-pager | grep killSwitch'

# Check live cap values in config
cat config/execution.live.yaml | grep -A 5 'risk:'
```

**If it looks like a legitimate risk breach:**
- Do not reset the kill switch without understanding what caused the breach.
- Check open positions before deciding next action. Halt and flatten are separate actions.
- Either let positions close naturally or explicitly flatten them if exposure must be removed immediately.
- Once flat, stop the engine: `sudo systemctl stop execution-engine@live`
- Investigate before restarting.

**If it looks like a false trigger (e.g., stale position count due to recovery bug):**
- Stop and restart the engine — recovery will reconstruct the correct count from Postgres.
- Monitor closely for 30 minutes post-restart.

**Escalate if:** positions are not closing within `deadlineSeconds` (300s by default).

---

### Order reject rate spike

**What it means:** A high fraction of order submissions are being rejected by an exchange.

**Immediate steps:**
```bash
# Check which exchange and error codes
ssh server 'sudo journalctl -u execution-engine@live -n 200 --no-pager | grep "order.reject"'
```

Common causes:
- **IP rate limit hit** — check Prometheus metric `execution_order_rejects_total{reason="rate_limit"}`. Reduce `FUNDING_RATE_SYMBOL_CONCURRENCY` or back off.
- **Invalid leverage/size** — exchange changed minimum order size. Check exchange API docs.
- **Expired API key** — rotate key per [configuration.md — Secret Rotation Procedure](./configuration.md#secret-rotation-procedure).
- **Exchange maintenance** — check exchange status page.

**Escalate if:** >20% of orders are rejected for more than 5 minutes on any exchange.

---

### Persistence writer queue overflow

**What it means:** The DB write queue has filled up (`writerQueueSize: 1000`), meaning Postgres can't keep up with the write rate.

**Immediate steps:**
```bash
# Check Postgres responsiveness
ssh server 'docker exec arbinet-postgres pg_isready -U arbinet'

# Check disk space on /data
ssh server 'df -h /data'

# Check Postgres logs
ssh server 'docker logs arbinet-postgres --tail 50'
```

**If Postgres is healthy but slow:**
- Check query performance: `docker exec arbinet-postgres psql -U arbinet -c "SELECT query, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"`
- The WAL file (`/data/execution-wal.jsonl`) is buffering writes — as long as the queue isn't overflowing, this is working as designed.

**If Postgres is down:**
- See [State Recovery: Postgres Down](#postgres-is-down-or-corrupt).

---

### `scrape-target-down` (Grafana/Prometheus alert)

**What it means:** Prometheus cannot reach the engine's metrics endpoint at `http://127.0.0.1:9464/metrics`.

**Immediate steps:**
```bash
# Check if engine is running
ssh server 'systemctl status execution-engine@live'

# Test metrics endpoint directly
ssh server 'curl -s http://127.0.0.1:9464/metrics | head -5'

# Check if something else grabbed port 9464
ssh server 'ss -tlnp | grep 9464'
```

If the engine is running and the port is open, the issue is likely Prometheus configuration. Check `docker logs arbinet-prometheus --tail 20`.

---

### PnL envelope breach

**What it means:** Cumulative PnL has fallen outside expected bounds (configured in Grafana alert rule).

**Immediate steps:**
- Check Grafana → Execution Engine → PnL panel for the magnitude and duration of the breach.
- Check for unusual market conditions (high volatility, funding rate anomalies).
- If the loss is larger than `maxNotionalUsd` × `stopLossPercent`, the risk system should have stopped positions automatically — check `risk.killSwitch.trip` logs.
- If the loss is within expected parameters but surprising: do not stop the engine without understanding why. Post in `#trading-ops` and monitor.
- If the loss exceeds what you are comfortable with: stop the engine (`sudo systemctl stop execution-engine@live`) and investigate.

---

## State Recovery

### Postgres is down or corrupt

The engine buffers uncommitted writes to a WAL file at `/data/execution-wal.jsonl`. Position state can be reconstructed from Postgres + WAL on restart.

**If Postgres crashed but data is intact:**
```bash
# Restart Postgres
ssh server 'docker compose -f /opt/arbinet/docker-compose.prod.yml up -d postgres'

# Wait for it to be ready
ssh server 'docker exec arbinet-postgres pg_isready -U arbinet'

# Restart the engine — it will replay the WAL automatically
ssh server 'sudo systemctl start execution-engine@live'
```

On startup, look for:
```
{"event":"wal.replay_start","entries":N}
{"event":"wal.replay_complete","written":N,"errors":0}
{"event":"recovery.complete","intents":N}
```

**If Postgres data is corrupt (table or disk corruption):**
```bash
# 1. Stop the engine immediately
ssh server 'sudo systemctl stop execution-engine@live'

# 2. Check available backups
ssh server 'ls -lt /data/backups/postgres/'
# Backups are named: arbinet_YYYYMMDD_HHMMSS.dump

# 3. Stop Postgres
ssh server 'docker compose -f /opt/arbinet/docker-compose.prod.yml stop postgres'

# 4. Restore from latest backup
ssh server "docker run --rm \
  -v /data/postgres:/var/lib/postgresql/data \
  -v /data/backups/postgres:/backups \
  postgres:18-alpine \
  sh -c 'pg_restore -U arbinet -d arbinet /backups/<backup-file>.dump'"

# 5. Start Postgres + verify
ssh server 'docker compose -f /opt/arbinet/docker-compose.prod.yml up -d postgres'
ssh server 'docker exec arbinet-postgres pg_isready -U arbinet'

# 6. Restart the engine — WAL replay will fill in the gap since the backup
ssh server 'sudo systemctl start execution-engine@live'
```

**Note on data loss window:** The backup is taken daily by the Postgres role's pg_dump cron. The WAL file covers the gap between the backup and the crash. If the WAL file is also lost, position state from the WAL gap cannot be recovered — manually audit open positions on each exchange and close them.

### WAL file lost or truncated

If `/data/execution-wal.jsonl` is missing or truncated after a crash:

```bash
# Audit open positions on each exchange manually
# (login to each exchange UI and check open positions)

# Then: reconstruct known state from Postgres
ssh server 'docker exec arbinet-postgres psql -U arbinet -c \
  "SELECT exchange, symbol, side, size, entry_price FROM execution_intents WHERE status='"'"'open'"'"';"'

# Close any orphaned positions manually via exchange UI
# Then restart the engine with a clean slate
ssh server 'sudo systemctl start execution-engine@live'
```

---

## SSH Tunnel for Local Tools

ClickHouse, Postgres, Grafana, and Jaeger are bound to `127.0.0.1` on the server. To access them from local tools:

```bash
# Open tunnel (keep this terminal running)
ssh -i ~/.ssh/nicolas \
  -L 8123:localhost:8123 \
  -L 9000:localhost:9000 \
  -L 5432:localhost:5432 \
  -L 3000:localhost:3000 \
  -L 16686:localhost:16686 \
  -N nicolas@203.0.113.10

# In another terminal:
# Grafana:    http://localhost:3000
# Jaeger UI:  http://localhost:16686
# Postgres:   localhost:5432
# ClickHouse: localhost:8123/9000
```

---

## Appendix: Staging Rehearsal — What Success Looks Like

Representative output from a full deploy → stop → restart → rollback cycle on the dry-run instance.

### Deploy (dry-run, first time)

```
$ npm run deploy -- --ask-vault-pass \
    -e deploy_execution=true \
    -e execution_engine_enabled=true \
    -e execution_mode=dry-run

PLAY [Deploy latest code] ****

TASK [Check if execution engine is running (live mode)] ... ok (rc=3, not active)
TASK [Stop execution engine gracefully before deploy] ... ok (not running, skipped)
TASK [Pull latest code] ... changed
TASK [Build Docker image] ... changed
TASK [Template docker-compose.prod.yml] ... ok
TASK [Template .env] ... ok
TASK [Restart ClickHouse] ... ok
TASK [Wait for ClickHouse to be healthy] ... ok (1 retry)
TASK [Restart Postgres] ... ok
TASK [Wait for Postgres to be healthy] ... ok
TASK [Deploy observability stack] ... ok
TASK [Deploy log-shipping stack] ... ok
TASK [Deploy execution engine (included)] ...
  TASK [execution-engine : Copy execution engine config] ... changed
  TASK [execution-engine : Get current git SHA] ... ok (sha: e84bc2d)
  TASK [execution-engine : Tag current image with git SHA] ... ok
  TASK [execution-engine : Create release directory for this SHA] ... changed
  TASK [execution-engine : Record deployed SHA and timestamp] ... changed
  TASK [execution-engine : Update current symlink to latest release] ... changed
  TASK [execution-engine : Template execution-engine systemd unit] ... changed
  TASK [execution-engine : Restart execution-engine service] ... changed
  TASK [execution-engine : Wait for execution engine /ready] ... ok (retries: 4)

PLAY RECAP: server ok=22 changed=12 failed=0
```

### Startup logs (first 30 seconds)

```
$ ssh server 'sudo journalctl -u execution-engine@dry-run -n 30 --no-pager'

{"level":"info","time":"2026-04-27T10:00:01.012Z","service":"execution-engine","event":"engine.starting","mode":"dry_run"}
{"level":"info","time":"2026-04-27T10:00:01.500Z","service":"execution-engine","event":"lifecycle.markets_fetched","exchanges":6,"symbols":843}
{"level":"info","time":"2026-04-27T10:00:04.210Z","service":"execution-engine","event":"lifecycle.adapters_connected","exchange":"binance","state":"connected"}
{"level":"info","time":"2026-04-27T10:00:05.780Z","service":"execution-engine","event":"lifecycle.adapters_connected","exchange":"kucoin","state":"connected"}
{"level":"info","time":"2026-04-27T10:00:06.001Z","service":"execution-engine","event":"lifecycle.recovery_complete","intents_restored":0}
{"level":"info","time":"2026-04-27T10:00:06.002Z","service":"execution-engine","event":"engine.ready","healthPort":9466,"metricsPort":9464}
```

### Graceful shutdown (SIGTERM)

```
$ ssh server 'sudo systemctl stop execution-engine@dry-run'

{"level":"info","event":"driver.draining","drainSeconds":10}
{"level":"info","event":"engine.stopping","openIntents":0}
{"level":"info","event":"persistence.flush_complete","written":0}
{"level":"info","event":"engine.stopped"}
```

systemd reports `exit-code=0/SUCCESS`.

### Auto-restart after kill -9

```
$ ssh server 'sudo kill -9 $(docker inspect --format "{{.State.Pid}}" arbinet-execution-dry-run)'

# systemd restarts within RestartSec=10
$ ssh server 'systemctl status execution-engine@dry-run'
● execution-engine@dry-run.service - Arbinet Execution Engine (dry-run mode)
   Active: active (running) since ... ; 8s ago
   (restart #1)

# Startup logs show WAL replay (if any pending writes):
{"level":"info","event":"wal.replay_start","entries":3}
{"level":"info","event":"wal.replay_complete","written":3,"errors":0}
{"level":"info","event":"recovery.complete","intents_restored":0}
{"level":"info","event":"engine.ready"}
```

---

## Cross-references

- [commands.md](./commands.md) — every `npm run` and CLI invocation with flags and examples
- [configuration.md](./configuration.md) — config layout, precedence, validation, secret rotation
- [infrastructure.md](./infrastructure.md) — environment inventory, Ansible roles, observability stack
- `ansible/playbooks/deploy.yml` — deploy playbook source
- `ansible/playbooks/rollback-execution.yml` — rollback playbook source
- `ansible/roles/execution-engine/` — systemd unit templates, release management
- `src/execution/observability/alerts.ts` — alert dispatcher source
- `src/execution/observability/health.ts` — health/ready server source
