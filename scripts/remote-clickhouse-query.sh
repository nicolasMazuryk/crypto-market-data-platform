#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: npm run remote:clickhouse:query -- \"<SQL>\"" >&2
  echo "Example: npm run remote:clickhouse:query -- \"SELECT count() FROM arbinet.orderbooks\"" >&2
  exit 2
fi

SQL="$*"

SERVER_IP=$(cd "$(dirname "$0")/../terraform" && terraform output -raw server_ip)

ssh -i ~/.ssh/nicolas "nicolas@${SERVER_IP}" \
  "docker exec -i arbinet-clickhouse clickhouse-client --database=arbinet --query=\"${SQL//\"/\\\"}\""
