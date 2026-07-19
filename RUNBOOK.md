# Operational Runbook

## Architecture

Single Hetzner CPX62 server (16 vCPU / 32 GB) running:

- **ClickHouse** — persistent Docker container, data on attached Hetzner volume (`/data`)
- **Workers** — one-shot Docker containers; market sync and incremental funding sync are driven by systemd timers (not auto-started on provisioning — activate manually when ready); quote sync and funding backfill are started manually
- **Monitoring** — health check script on a 3-minute systemd timer

All services run on one server. ClickHouse is only accessible via localhost (SSH tunnel for remote access).

## Prerequisites

- Terraform and Ansible installed locally: `brew install terraform ansible`
- Hetzner API token in `terraform/terraform.tfvars`
- SSH private key for server access (`~/.ssh/nicolas`)

## First-Time Setup

```bash
# 1. Configure Terraform variables
cat > terraform/terraform.tfvars <<EOF
hcloud_token   = "your-hetzner-api-token"
ssh_public_key = "ssh-ed25519 AAAA... you@host"
EOF

# 2. Provision infrastructure
npm run infra:init
npm run infra:apply

# 3. Update Ansible inventory with server IP
cd terraform && terraform output -raw server_ip
# Edit ansible/inventory/hosts.ini with the IP

# 4. Full server provisioning (installs Docker, clones repo, starts ClickHouse)
npm run setup
# NOTE: On first run, Ansible will print a GitHub deploy key.
# Add it to GitHub repo Settings > Deploy keys (read-only) before proceeding.
# Then re-run: npm run setup
# NOTE: Scheduled timers are NOT auto-started. Activate them manually when ready
# (see "Activate Scheduled Sync" below).

# 5. Apply database migrations
npm run deploy:migrate
```

## Regular Deployment

After pushing code to `main`:

```bash
npm run deploy
```

This runs the Ansible deploy playbook which: git pulls, rebuilds the Docker image, restarts ClickHouse.

## Database Migrations

```bash
# 1. Add .sql file to src/db/migrations/
# 2. Deploy new code to server
npm run deploy
# 3. Run migrations
npm run deploy:migrate
```

## Workflow: Full Data Pipeline Sequence

Run these in order on a fresh server:

```bash
npm run remote:run:markets                 # 1. Sync market listings
npm run remote:funding-backfill            # 2. Backfill historical funding rates
npm run remote:run:funding                 # 3. Run incremental funding sync
npm run remote:validate:funding            # 4. Validate funding data
npm run remote:analyze:funding-download-tasks  # 5. Analyze funding download candidates
npm run remote:create:funding-download-tasks   # 6. Create funding download tasks
npm run remote:quote-sync                  # 7. Run quote sync
npm run remote:report:download-task-progress  # 9. Report download task progress
npm run remote:validate:quotes             # 8. Validate quotes data
npm run backtest                           # 10. Run backtest locally
```

## Activate Scheduled Sync

Timers are not started automatically during provisioning. Enable them when ready:

```bash
npm run remote:timer:add:markets    # Enable + start market sync timer
npm run remote:timer:add:funding    # Enable + start funding sync timer
```

To disable:

```bash
npm run remote:timer:remove:markets
npm run remote:timer:remove:funding
```

## SSH Access

Code agents can connect directly with:

```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10
```

```bash
npm run remote:ssh
```

## Check Server Status

```bash
npm run remote:status
```

Shows running Docker containers and active systemd timers.

## View Worker Logs

```bash
npm run remote:logs:markets    # Market sync logs
npm run remote:logs:funding    # Funding rates logs
npm run remote:logs:quotes     # Quote sync coordinator logs
```

Or SSH in and use journalctl directly:

```bash
sudo journalctl -u worker-market-sync -n 100 --no-pager
sudo journalctl -u worker-funding-rates -n 100 --no-pager
sudo journalctl -u worker-quote-sync-coordinator -n 100 --no-pager
sudo journalctl -u worker-funding-rates-backfill -n 100 --no-pager
```

## Manually Trigger a Worker/Job

```bash
npm run remote:run:markets       # Run market sync + stream logs
npm run remote:run:funding        # Run incremental funding sync + stream logs
npm run remote:funding-backfill   # Run historical funding backfill + stream logs
npm run remote:quote-sync         # Run quote sync coordinator + stream logs
```

Or SSH in and use systemctl directly:

```bash
sudo systemctl start worker-market-sync
sudo systemctl start worker-funding-rates
sudo systemctl start worker-funding-rates-backfill
sudo systemctl start worker-quote-sync-coordinator
sudo systemctl start worker-migrate
```

## Validate Data

```bash
npm run remote:validate:funding   # Run funding rate validation on server
npm run remote:validate:quotes    # Run quotes validation on server
npm run remote:report:download-task-progress  # Run download task progress report on server
```

Quote validation reports are persisted on the server under `/data/reports/quotes-validation`.
Each run updates `latest.json` and also writes a timestamped archive copy in the same directory.

## Run Quote Sync (Coordinator, Recommended)

```bash
npm run remote:quote-sync
```

This starts `worker-quote-sync-coordinator` and streams its logs. The coordinator launches multiple quote workers in parallel.

## Run Funding Backfill (Manual)

```bash
npm run remote:funding-backfill
```

This starts `worker-funding-rates-backfill`, which runs the historical backfill path. The hourly `worker-funding-rates` timer stays on incremental mode only.

## Funding Download Tasks

```bash
npm run remote:analyze:funding-download-tasks
npm run remote:create:funding-download-tasks
```

- Configure `.env`, `.env.dev`, or the production env with the `FUNDING_DOWNLOAD_TASKS_*` variables before running these commands.
- `analyze` mode: prints a summary of candidate funding-triggered download days for the selected date range.
- `create` mode: creates `pending` download tasks for funding events below the configured threshold; with `FUNDING_DOWNLOAD_TASKS_DRY_RUN=true` it only previews the result.

## Check Timer Status

```bash
# On server:
systemctl list-timers worker-* health-check*
```

## Access ClickHouse from Local Tools

Use an SSH tunnel:

```bash
# Terminal 1: open tunnel
ssh -i ~/.ssh/nicolas -L 8123:localhost:8123 -L 9000:localhost:9000 -N nicolas@$(cd terraform && terraform output -raw server_ip)

# Terminal 2: connect with local tools using localhost:8123 / localhost:9000
```

## Health Check

Runs every 3 minutes. Checks:

- ClickHouse ping
- Docker running
- Disk usage < 80%
- Scheduled worker timers active (only if enabled; disabled timers do not alert)

Manual run:

```bash
# On server:
sudo systemctl start health-check
sudo journalctl -u health-check -n 20 --no-pager
```

## Execution Engine Deployment

See **[src/execution/docs/runbook.md](src/execution/docs/runbook.md)** for the full execution-engine runbook (deploy, hotfix, rollback, on-call response, state recovery).

## Disaster Recovery

If the server is destroyed, the Hetzner volume persists:

```bash
npm run infra:apply     # Recreates server, reattaches volume
npm run setup           # Provisions everything, mounts /data
```

ClickHouse data survives because it lives on the separate Hetzner volume.

## Observability Dashboards

All dashboards are publicly accessible over HTTPS via Caddy reverse proxy (nip.io wildcard TLS).

| Service      | URL                                        | Auth                                           |
| ------------ | ------------------------------------------ | ---------------------------------------------- |
| Grafana      | https://grafana.203-0-113-10.nip.io      | admin / `<OBSERVABILITY_PASSWORD>`                 |
| Prometheus   | https://prometheus.203-0-113-10.nip.io   | ops / `<OBSERVABILITY_PASSWORD>` (HTTP Basic Auth) |
| Jaeger       | https://jaeger.203-0-113-10.nip.io       | ops / `<OBSERVABILITY_PASSWORD>` (HTTP Basic Auth) |
| Alertmanager | https://alertmanager.203-0-113-10.nip.io | ops / `<OBSERVABILITY_PASSWORD>` (HTTP Basic Auth) |

To rotate the basic-auth password, re-run `caddy hash-password` on the server, update `observability_basicauth_password_hash` in `ansible/group_vars/all.yml`, then `npm run setup`.

Check Caddy logs if certs lag on first deploy:

```bash
ssh -i ~/.ssh/nicolas nicolas@203.0.113.10 'docker logs arbinet-caddy --tail 80'
```

## Firewall

- **Hetzner firewall**: SSH (22), HTTP (80), HTTPS (443) open externally
- **UFW on server**: Defense-in-depth, same rules
- **ClickHouse ports** (8123/9000): Bound to 127.0.0.1 only, accessible only via Caddy or SSH tunnel
- **Prometheus/Jaeger/Alertmanager**: Bound to 127.0.0.1, protected by HTTP Basic Auth via Caddy

Verify externally: `nmap -p 8123,9000 SERVER_IP` — should show ports as filtered/closed.
