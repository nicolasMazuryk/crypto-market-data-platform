#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: npm run remote:clickhouse:query -- \"<SQL>\"" >&2
  echo "Example: npm run remote:clickhouse:query -- \"SELECT count() FROM arbinet.orderbooks\"" >&2
  exit 2
fi

SQL="$*"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ -z "${REMOTE_SERVER_HOST:-}" ]; then
  for env_file in "${REPO_ROOT}/.env" "${REPO_ROOT}/.env.dev"; do
    if [ -f "${env_file}" ]; then
      # shellcheck source=/dev/null
      set -a
      . "${env_file}"
      set +a
      if [ -n "${REMOTE_SERVER_HOST:-}" ]; then
        break
      fi
    fi
  done
fi

SERVER_HOST="${REMOTE_SERVER_HOST:-}"
if [ -z "${SERVER_HOST}" ]; then
  if SERVER_HOST="$(cd "${REPO_ROOT}/terraform" && terraform output -raw server_ip 2>/dev/null)"; then
    :
  else
    echo "Could not resolve remote host." >&2
    echo "Set REMOTE_SERVER_HOST (for example in .env.dev), or run terraform init in terraform/ so fallback can read server_ip." >&2
    exit 1
  fi
fi

ssh -i ~/.ssh/nicolas "nicolas@${SERVER_HOST}" \
  "docker exec -i arbinet-clickhouse clickhouse-client --database=arbinet --query=\"${SQL//\"/\\\"}\""
