#!/usr/bin/env bash
# Generates ansible/inventory/hosts.ini from Terraform output.
# Run after `npm run infra:apply` or any time the server IP changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${SERVER_IP:-}" ]]; then
  SERVER_IP=$(cd "$REPO_ROOT/terraform" && terraform output -raw server_ip 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tr -d '\n')
fi

if [[ ! "$SERVER_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: could not get a valid server IP from Terraform." >&2
  echo "Run 'npm run infra:apply' first, or pass SERVER_IP=x.x.x.x before running this script." >&2
  exit 1
fi

cat > "$REPO_ROOT/ansible/inventory/hosts.ini" <<EOF
[servers]
arbinet ansible_host=${SERVER_IP}

[servers:vars]
ansible_user=nicolas
ansible_ssh_private_key_file=~/.ssh/nicolas
EOF

echo "Generated ansible/inventory/hosts.ini with server IP: ${SERVER_IP}"
