#!/usr/bin/env bash
# Generates ansible/inventory/hosts.ini from Terraform output.
# Run after `npm run infra:apply` or any time the server IP changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVER_IP=$(cd "$REPO_ROOT/terraform" && terraform output -raw server_ip)

cat > "$REPO_ROOT/ansible/inventory/hosts.ini" <<EOF
[servers]
arbinet ansible_host=${SERVER_IP}

[servers:vars]
ansible_user=nicolas
ansible_ssh_private_key_file=~/.ssh/nicolas
EOF

echo "Generated ansible/inventory/hosts.ini with server IP: ${SERVER_IP}"
