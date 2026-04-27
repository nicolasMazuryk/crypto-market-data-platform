# Infrastructure

Where the execution engine runs and how it is deployed.

## Environments

### Local (Docker Compose)

All services run via `docker/docker-compose.yml`. Ports are bound to all interfaces for local development.

| Service | Image | Port(s) | Role |
|---------|-------|---------|------|
| clickhouse | `clickhouse/clickhouse-server:25.5.6` | `8123` (HTTP), `9000` (native) | Time-series store for funding rates, quotes, markets |
| postgres | `postgres:17-alpine` | `5432` | Execution engine state (intents, fills, reconciliation) |
| prometheus | `prom/prometheus:v2.54.0` | `9090` | Metrics collection |
| grafana | `grafana/grafana:11.1.0` | `3000` | Dashboards + alerting UI |
| alertmanager | `prom/alertmanager:v0.27.0` | `9093` | Alert routing → Slack |
| loki | `grafana/loki:3.0.0` | `3100` | Log aggregation |
| promtail | `grafana/promtail:3.0.0` | — | Log shipping (reads Docker container logs, pushes to Loki) |
| jaeger | `jaegertracing/all-in-one:latest` | `16686` (UI), `4318` (OTLP) | Distributed tracing (local only) |

The execution engine itself is **not** containerised locally; it runs as a Node process (`npm run execution:dry-run` or `npm run execution:live`) and connects to the above services over localhost.

### Production (Hetzner)

A single Hetzner Cloud server (`cpx62`, Ubuntu 24.04, Nuremberg `nbg1`) backed by a 200 GB attached volume at `/data`. All service ports are bound to `127.0.0.1` — nothing is exposed to the public internet.

| Service | Image | Port | Role |
|---------|-------|------|------|
| clickhouse | `clickhouse/clickhouse-server:25.5.6` | `127.0.0.1:8123` / `9000` | Same as local |
| postgres | `postgres:18-alpine` | `127.0.0.1:5432` | Execution state |
| prometheus | `prom/prometheus:v2.54.0` | `127.0.0.1:9090` | Metrics |
| grafana | `grafana/grafana:11.1.0` | `127.0.0.1:3000` | Dashboards |
| alertmanager | `prom/alertmanager:v0.27.0` | `127.0.0.1:9093` | Alert routing |
| loki | `grafana/loki:3.0.0` | `127.0.0.1:3100` | Logs |
| promtail | `grafana/promtail:3.0.0` | — | Log shipping |
| execution-engine | `arbinet:latest` | `127.0.0.1:9464` (metrics), `127.0.0.1:9466` (health) | Trading engine |

Jaeger is not deployed in production.

## Deployment Flow

```
Terraform → Hetzner Cloud (server + volume + firewall + network)
    ↓
Ansible playbooks (npm run setup / npm run deploy)
    ↓
systemd (manages execution-engine service lifecycle)
```

### Terraform

Managed under `terraform/`. Provisions:
- Server: `hcloud_server` type `cpx62`, image `ubuntu-24.04`, location `nbg1`
- Volume: 200 GB ext4, attached at `/data`
- Firewall: SSH (port 22) and ICMP only — all other traffic is localhost-routed
- Private network: `10.0.0.0/16`, subnet `10.0.1.0/24` (zone `eu-central`)
- SSH key: user `nicolas`

```bash
npm run infra:plan    # preview
npm run infra:apply   # apply + auto-regenerate ansible/inventory/hosts.ini
```

### Ansible Roles

Playbooks live under `ansible/playbooks/`. Each Ansible role has a single responsibility:

| Role | Purpose |
|------|---------|
| `base` | System packages, timezone (`Europe/Warsaw`), volume mount at `/data` |
| `docker` | Docker Engine + Compose plugin |
| `hardening` | UFW firewall rules (SSH-only inbound) |
| `app` | Clone repo, build Docker image (`arbinet:latest`), write prod `docker-compose.yml` from Jinja2 template |
| `postgres` | Start Postgres container, wait for health, install daily backup cron (02:30 UTC, 7-day retention) |
| `workers` | systemd service + timer units for market-sync, funding-rates, migrations, quote-sync workers |
| `execution-engine` | Create release directories, copy config, tag image with git SHA, atomic `current` symlink, template secrets file, install + conditionally start `execution-engine@<mode>.service` |
| `observability` | Template Prometheus / AlertManager configs, copy Grafana provisioning + dashboards, start `prometheus grafana alertmanager` via Compose |
| `log-shipping` | Template Loki + Promtail configs, start `loki promtail` via Compose |

Full provisioning:
```bash
npm run setup        # runs ansible/playbooks/setup.yml — full stack from scratch
```

Incremental redeploy (code change only):
```bash
npm run deploy       # runs ansible/playbooks/deploy.yml — git pull + build + restart
```

### systemd

The execution engine runs as a systemd **service instance**, not a Docker worker:

```
execution-engine@dry-run.service
execution-engine@live.service
```

The `@` template takes the mode as an instance argument. The service is enabled and started by the `execution-engine` Ansible role only when `execution_engine_enabled: true` (defaults to `false` for safety).

The `execution-engine@<mode>.service` unit:
- Runs the compiled binary from the `current` release symlink
- Injects secrets from `{{ execution_secrets_dir }}/execution.env` (root-owned, mode 0400)
- Uses `network=host` (same as the prod Compose template) so the engine reaches localhost services directly
- WAL directory: `/data/execution`

Workers (market-sync, funding-rates, quote-sync) run as **separate** systemd services + timers. Do not confuse them with the execution engine:

| Timer | Schedule | Service |
|-------|----------|---------|
| `worker-market-sync.timer` | `*:00:00` (every hour) | `worker-market-sync.service` |
| `worker-funding-rates.timer` | `*:05:00` (every hour) | `worker-funding-rates.service` |

The execution engine has its own **internal** funding-event scheduler (`src/execution/scheduler.ts`) that fires based on exchange funding times — this is independent of the systemd timers above.

## Secrets Handling

Secrets are stored as **plaintext in `ansible/group_vars/all.yml`** (intentional post-vault-removal design; the file is private to the repo and not committed with real values in the public tree). Do not put secrets in `config/*.yaml` or in the source tree.

| Secret | Dev (local) | Prod (server) |
|--------|-------------|---------------|
| Exchange API keys | `.env` (git-ignored) | `ansible/group_vars/all.yml` → templated to `{{ execution_secrets_dir }}/execution.env` (0400) |
| Postgres password | `.env` | `ansible/group_vars/all.yml` → injected as `POSTGRES_PASSWORD` env var |
| ClickHouse password | `.env` | `ansible/group_vars/all.yml` → injected as `CLICKHOUSE_PASSWORD` env var |
| Slack webhook | `.env` | `ansible/group_vars/all.yml` → AlertManager config |
| Grafana admin password | `.env` | `ansible/group_vars/all.yml` → `GRAFANA_ADMIN_PASSWORD` |

Exchange credentials are injected at engine startup from env vars following the pattern:

```
{PREFIX}_API_KEY
{PREFIX}_API_SECRET
{PREFIX}_API_PASSPHRASE   # OKX, Bitget, KuCoin only
```

`PREFIX` defaults to the exchange name uppercased (`BINANCE`, `BYBIT`, `OKX`, `BITGET`, `GATEIO`, `KUCOIN`). Override with `credentialsEnvPrefix` in the exchange config.

## Observability

### Endpoints (execution engine)

| Path | Port | Description |
|------|------|-------------|
| `GET /health` | 9466 | Liveness — returns 200 when process is alive |
| `GET /ready` | 9466 | Readiness — returns 200 when engine has finished startup |
| `GET /metrics` | 9464 | Prometheus scrape endpoint |

Ansible waits for `/ready` (200 OK) before marking the deployment successful (`execution_health_ready_retries: 60`, `execution_health_ready_delay: 5s` → 5-minute timeout).

### Prometheus

Scrapes `localhost:9464/metrics`. Alert rules live in `docker/prometheus/rules/execution-engine.yml` (copied to server by the `observability` role). Retention: 30 days.

### Grafana

- UI at `localhost:3000` (prod: access via SSH tunnel)
- Datasources: Prometheus + Loki (provisioned automatically)
- Execution engine dashboard provisioned from `docker/grafana/dashboards/`
- Alerting contact points: Slack (templated from `ansible/roles/observability/templates/grafana-contact-points.yml.j2`)

### Loki + Promtail

Promtail scrapes Docker container log files and ships to Loki. Loki retention: 336 hours (14 days).

### Jaeger

Distributed tracing (local dev only). OTLP endpoint: `localhost:4318`. Enable in config with `observability.tracing.enabled: true` and set `observability.tracing.endpoint`.

### AlertManager

Routes firing alerts to Slack via webhook. Config templated by the `observability` role.

## Data Directories (Production)

All persistent data lives on the attached Hetzner volume mounted at `/data`:

| Path | Owner | Content |
|------|-------|---------|
| `/data/clickhouse` | docker | ClickHouse data |
| `/data/postgres` | docker | Postgres data files |
| `/data/backups/postgres` | root | Daily pg_dump backups (7-day retention) |
| `/data/execution` | root | Execution engine WAL files |
| `/data/reports/quotes-validation` | nicolas | Quote validation reports |

Application files:

| Path | Content |
|------|---------|
| `/opt/arbinet/repo` | Git checkout (branch: `main`) |
| `/opt/arbinet/config` | Execution YAML configs (copied from repo by `execution-engine` role) |
| `/opt/arbinet/execution/releases/<sha>` | Immutable release snapshot |
| `/opt/arbinet/execution/current` | Symlink → latest release |
| `/opt/arbinet/execution/secrets/execution.env` | Secrets file (root, 0400) |

## See Also

- [configuration.md](./configuration.md) — YAML config layout, parameter reference, secrets matrix
- [commands.md](./commands.md) — `npm run setup`, `npm run deploy`, `npm run deploy:migrate`, observability commands
- [runbook.md](./runbook.md) — deploy procedures, rollback, on-call responses
