# Live Deploy Runbook — Subaccount-Isolated Strategies

Operator runbook for deploying strategies to the Hetzner server with one isolated systemd unit + Docker container per `(strategy, exchange)` combo, each pinned to its own exchange subaccount.

Cross-references: [provisioning.md](./provisioning.md), [runbook.md](./runbook.md), [commands.md](./commands.md), [configuration.md](./configuration.md), [infrastructure.md](./infrastructure.md).

---

## 1. Architecture

- One systemd unit per combo: `execution-engine@<strategy>-<exchange>.service`.
- One Docker container per combo, one strategy per container.
- Unique metrics port (9500–9599) + health port (9600–9699) per combo.
- Per-combo config: `live-configs/strategies/<id>.yaml`.
- Per-combo secrets on server: `/opt/arbinet/execution/secrets/<id>.env` (subaccount key/secret from `registry.yaml`).
- State hash on server: `/opt/arbinet/execution/state/<id>.hash` (drift detection).

Sources of truth:

- **What runs** = `live-configs/fleet.yaml`.
- **Which subaccount keys feed a combo** = `live-configs/registry.yaml`, looked up by `(assigned_strategy, exchange)` at deploy time.

---

## 2. Prerequisites

1. Server provisioned: `npm run setup` already applied (base/docker/hardening/workers). Verify:
   ```bash
   npm run remote:status
   ```
2. Server secrets vaulted in `ansible/group_vars/all.yml`: `execution_postgres_url`, `slack_webhook_url`. Templated to `/opt/arbinet/execution/secrets/base.env`.
3. Postgres + ClickHouse running on server.
4. Local toolchain: Ansible, SSH key `~/.ssh/nicolas`, Terraform reachable (`npm run infra:inventory`).
5. Master broker creds in local `.env` (only needed for provisioning new subaccounts):
   `MASTER_{BINANCE,BYBIT,OKX,GATEIO,KUCOIN,BITGET}_API_KEY` + `_SECRET`.

---

## 3. Set up subaccounts

Goal: one active subaccount per `(strategy, exchange)` combo recorded in `live-configs/registry.yaml`.

### 3.1 Provision (create or claim subaccount, assign to strategy)

```bash
npm run provision -- --strategy <strategy_id> --exchange <exchange> --capital <usdt>
```

What it does:

- Picks an idle subaccount row in `registry.yaml` via LRU, or creates one through master broker creds.
- Flips row to `status: active`, `assigned_strategy: <strategy_id>`.
- Calls `reconcileCapital()` on exchange → moves USDT from master to subaccount to match `--capital`.
- Persists `api_key`, `api_secret`, IP allow-list, passphrase (if exchange requires).

Repeat per combo.

### 3.2 Validate registry

```bash
npm run registry:validate
```

Checks uniqueness of `(exchange, subaccount)`, IP allow-lists, key/passphrase presence.

### 3.3 List / inspect

```bash
npm run provision:list
```

### 3.4 Release a subaccount

```bash
npm run provision:release -- --strategy <strategy_id> --exchange <exchange>
```

Flips row → `status: idle`, clears `assigned_strategy`. Fleet validator then refuses any combo referencing it.

> **Never hand-edit `assigned_strategy` in `registry.yaml`.** Bypasses capital reconciliation + uniqueness checks and does not trigger redeploy (see §8).

---

## 4. Set up a fleet

### 4.1 Author per-combo strategy config

For each combo create `live-configs/strategies/<strategy>-<exchange>.yaml` with strategy params (TP/SL, `fundingWindowMs`, sizing relative to `allocated_capital_usdt`, …). Parameters per strategy doc in `trading-logic.md`.

### 4.2 Populate `live-configs/fleet.yaml`

Replace `combinations: []` with one entry per combo. Ports must be unique.

```yaml
combinations:
  - id: strategy_2-bybit
    strategy: strategy_2
    exchange: bybit
    enabled: true
    strategy_config: live-configs/strategies/strategy_2-bybit.yaml
    runtime:
      metrics_port: 9501
      health_port: 9601
      log_level: info
    risk:
      maxConcurrentIntents: 200
      maxNotionalUsd: 50000
```

### 4.3 Validate fleet + configs

```bash
npm run fleet:validate    # schema + cross-ref vs registry (active rows only)
npm run config:validate   # YAML + semantic rules across all configs
```

Fleet validator enforces: each enabled combo has matching `status: active` registry row; ports unique; `strategy_config` file exists.

### 4.4 Generate merged manifest (inspect before deploy)

```bash
npm run fleet:generate-configs
```

---

## 5. Deploy (first time)

### 5.1 Base deploy in dry-run

```bash
npm run deploy -- -e deploy_execution=true -e execution_mode=dry-run
```

`ansible/playbooks/deploy.yml`: pulls code, builds Docker image tagged with git SHA, restarts Postgres/ClickHouse, templates base secrets, starts `execution-engine@dry-run.service` for smoke.

### 5.2 Reconcile fleet (start per-combo units)

```bash
npm run fleet:reconcile -- --fleet live-configs/fleet.yaml --registry live-configs/registry.yaml
```

Reconcile flow:

1. SSH to server, list running `execution-engine@*` units.
2. Diff against desired fleet → `{toStart, toStop, toRedeploy}`.
3. For each combo: write `execution.<id>.yaml`, `<id>.env` (subaccount keys from registry), template systemd unit.
4. Run `ansible/playbooks/fleet-reconcile.yml` which loops `deploy-instance.yml` per combo.
5. Wait `/ready` on each combo's health port.

Always dry-run first:

```bash
npm run fleet:reconcile -- --dry-run
```

### 5.3 Soak in dry-run

Recommended: 24h. Watch for clean `journalctl`, `/ready` 200, metrics scraping.

### 5.4 Promote to live

```bash
npm run deploy:execution
```

Equivalent to `npm run deploy -- -e deploy_execution=true -e execution_engine_enabled=true -e execution_mode=live -e allow_in_hours_deploy=true`.

Then re-reconcile so combos flip from dry-run → live:

```bash
npm run fleet:reconcile
```

---

## 6. Validate everything runs

```bash
npm run remote:status
ssh nicolas@$SERVER 'systemctl list-units "execution-engine@*"'
ssh nicolas@$SERVER 'curl -s 127.0.0.1:9601/ready'   # per combo health port
ssh nicolas@$SERVER 'sudo journalctl -u execution-engine@strategy_2-bybit -n 200'
```

Per-combo metrics: `http://127.0.0.1:<metrics_port>/metrics`.

End-to-end checks:

1. `registry:validate` + `fleet:validate` + `config:validate` all green locally.
2. `fleet:generate-configs` manifest inspected.
3. All `execution-engine@*` units `active (running)`, `/ready` returns 200.
4. Exchange UI: subaccount activity matches expected strategy only.
5. ClickHouse / Postgres: state rows written per combo, no cross-combo writes.

---

## 7. Redeploy (code or config change)

### 7.1 Strategy param change

Edit `live-configs/strategies/<id>.yaml` → reconcile. Only the affected combo redeploys (hash mismatch).

```bash
npm run fleet:validate
npm run fleet:reconcile -- --dry-run
npm run fleet:reconcile
```

### 7.2 Add a combo

1. Provision subaccount (§3.1).
2. Author `live-configs/strategies/<id>.yaml`.
3. Append entry to `fleet.yaml` with unique ports.
4. Validate + reconcile.

### 7.3 Remove a combo

1. Set `enabled: false` (or delete entry) in `fleet.yaml`.
2. `npm run fleet:reconcile` → unit stopped + disabled.
3. Optionally `provision:release` to free the subaccount.

### 7.4 Code change (server)

```bash
npm run deploy:execution
npm run fleet:reconcile   # codeSha hash flip redeploys all combos
```

### 7.5 Rollback bad code

```bash
ansible-playbook ansible/playbooks/rollback-execution.yml -e target_sha=<sha>
```

---

## 8. Change subaccount ↔ strategy mapping

Editing `assigned_strategy` in `registry.yaml` alone does **NOT** trigger redeploy. Per-combo hash = `sha256({fleetEntry, strategyConfigContent, codeSha})` — registry fields are not in the hash. The deployed `<id>.env` keeps the previous keys.

Always go through `provision:release` + `provision`.

### 8.1 Swap which strategy a subaccount runs

_Subaccount X on Bybit currently runs `strategy_2`. Switch to `strategy_5`._

```bash
# 1. Release old assignment
npm run provision:release -- --strategy strategy_2 --exchange bybit

# 2. Reassign subaccount (LRU picks idle X, reconciles capital)
npm run provision -- --strategy strategy_5 --exchange bybit --capital 100

# 3. Edit fleet.yaml: remove strategy_2-bybit, add strategy_5-bybit
#    Create live-configs/strategies/strategy_5-bybit.yaml

# 4. Validate + reconcile
npm run registry:validate
npm run fleet:validate
npm run fleet:reconcile -- --dry-run
npm run fleet:reconcile
```

Diff shows `- stop strategy_2-bybit`, `+ start strategy_5-bybit`. New subaccount keys land in `/opt/arbinet/execution/secrets/strategy_5-bybit.env`.

### 8.2 Move a strategy to a different subaccount on same exchange

_`strategy_2` on Bybit should run on subaccount Y instead of X._

```bash
npm run provision:release -- --strategy strategy_2 --exchange bybit
npm run provision -- --strategy strategy_2 --exchange bybit --capital <n>
```

Fleet entry unchanged → hash matches → combo shows `unchanged`. Force a redeploy via one of:

1. **Preferred — touch strategy config**:
   ```bash
   # whitespace bump in live-configs/strategies/strategy_2-bybit.yaml
   npm run fleet:reconcile
   ```
2. **Stop unit + drop state hash**:
   ```bash
   ssh nicolas@$SERVER 'sudo systemctl stop execution-engine@strategy_2-bybit'
   ssh nicolas@$SERVER 'sudo rm /opt/arbinet/execution/state/strategy_2-bybit.hash'
   npm run fleet:reconcile
   ```
3. **Code commit** — bumps `codeSha`, redeploys **all** combos. Heavy hammer.

### 8.3 Bulk strategy/subaccount remap

Do per-combo (release → provision → fleet edit → reconcile). Stage in dry-run first.

---

## 9. Critical files

| Path                                                                       | Purpose                                       |
| -------------------------------------------------------------------------- | --------------------------------------------- |
| `live-configs/registry.yaml`                                               | Subaccount inventory + assignments.           |
| `live-configs/fleet.yaml`                                                  | What runs (combos, ports, risk, config path). |
| `live-configs/strategies/<id>.yaml`                                        | Per-combo strategy params.                    |
| `/opt/arbinet/execution/secrets/<id>.env`                                  | Subaccount keys on server (templated).        |
| `/opt/arbinet/execution/state/<id>.hash`                                   | Deploy hash for drift detection.              |
| `src/execution/fleet/cli/reconcile.ts`                                     | Orchestrator.                                 |
| `src/execution/fleet/{loader,validate,reconcile}.ts`                       | Schema + cross-ref + diff.                    |
| `src/execution/provisioning/cli/{provision,release,sync,list}.ts`          | Registry maintenance.                         |
| `ansible/playbooks/{deploy,fleet-reconcile,rollback-execution}.yml`        | Playbooks.                                    |
| `ansible/roles/execution-engine/tasks/{deploy-instance,stop-instance}.yml` | Per-combo tasks.                              |

---

## 10. Quick reference — command order from scratch

```bash
# Subaccounts
npm run provision -- --strategy <s> --exchange <e> --capital <n>   # per combo
npm run registry:validate

# Fleet
# author live-configs/strategies/<id>.yaml + edit live-configs/fleet.yaml
npm run fleet:validate
npm run config:validate
npm run fleet:generate-configs

# First deploy (dry-run)
npm run deploy -- -e deploy_execution=true -e execution_mode=dry-run
npm run fleet:reconcile -- --dry-run
npm run fleet:reconcile

# Soak 24h, then go live
npm run deploy:execution
npm run fleet:reconcile

# Verify
npm run remote:status
ssh nicolas@$SERVER 'systemctl list-units "execution-engine@*"'
```
