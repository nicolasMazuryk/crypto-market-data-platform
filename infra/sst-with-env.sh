#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 2 ]]; then
  echo "Usage: $0 <stage> <sst-command> [args...]"
  echo "Example: $0 dev deploy"
  exit 1
fi

STAGE="$1"
shift

ENV_FILE="${SST_ENV_FILE:-.env.${STAGE}}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing environment file: $ENV_FILE"
  exit 1
fi

load_env_file() {
  local env_file="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    [[ "$line" != *=* ]] && continue

    local key="${line%%=*}"
    local value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"

    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done < "$env_file"
}

load_env_file "$ENV_FILE"

export SST_STAGE="$STAGE"
export SST_ENV_FILE="$ENV_FILE"

exec npx sst --stage "$STAGE" "$@"
