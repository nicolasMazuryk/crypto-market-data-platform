# Operational Runbook

## Architecture

Single Hetzner CPX62 server (16 vCPU / 32 GB) running:
- **ClickHouse** — persistent Docker container, data on attached Hetzner volume (`/data`)
- **Workers** — one-shot Docker containers; market sync and funding rates run on systemd timers; quote sync is started manually
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

## SSH Access

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
npm run remote:logs:quotes     # Quote sync logs
```

Or SSH in and use journalctl directly:

```bash
sudo journalctl -u worker-market-sync -n 100 --no-pager
sudo journalctl -u worker-funding-rates -n 100 --no-pager
sudo journalctl -u worker-quote-sync -n 100 --no-pager
```

## Manually Trigger a Worker

```bash
npm run remote:ssh
# Then on the server:
sudo systemctl start worker-market-sync
sudo systemctl start worker-funding-rates
sudo systemctl start worker-quote-sync
sudo systemctl start worker-migrate
```

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
- Scheduled worker timers active (market sync, funding rates)

Manual run:

```bash
# On server:
sudo systemctl start health-check
sudo journalctl -u health-check -n 20 --no-pager
```

## Disaster Recovery

If the server is destroyed, the Hetzner volume persists:

```bash
npm run infra:apply     # Recreates server, reattaches volume
npm run setup           # Provisions everything, mounts /data
```

ClickHouse data survives because it lives on the separate Hetzner volume.

## Firewall

- **Hetzner firewall**: Only SSH (22) open externally
- **UFW on server**: Defense-in-depth, same rules
- **ClickHouse ports** (8123/9000): Bound to 127.0.0.1 only, not externally accessible

Verify externally: `nmap -p 8123,9000 SERVER_IP` — should show ports as filtered/closed.
