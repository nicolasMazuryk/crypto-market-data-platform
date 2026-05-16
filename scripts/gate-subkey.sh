#!/usr/bin/env bash
# Usage: source <(scripts/gate-subkey.sh gateio strategy_1)
# Exports GATE_API_KEY and GATE_API_SECRET for the given exchange+strategy
# combination from live-configs/registry.yaml.
#
# Exits non-zero if no matching active entry is found.

set -euo pipefail

EXCHANGE="${1:-}"
STRATEGY="${2:-}"

if [[ -z "$EXCHANGE" || -z "$STRATEGY" ]]; then
  echo "Usage: source <(scripts/gate-subkey.sh <exchange> <strategy>)" >&2
  exit 1
fi

REGISTRY="$(cd "$(dirname "$0")/.." && pwd)/live-configs/registry.yaml"

if [[ ! -f "$REGISTRY" ]]; then
  echo "Registry not found: $REGISTRY" >&2
  exit 1
fi

# Extract key/secret for matching exchange+strategy block (status: active)
# Uses awk to walk YAML blocks without requiring yq/python
result=$(awk -v ex="$EXCHANGE" -v strat="$STRATEGY" '
  /^  - exchange:/ {
    in_block = 0; key = ""; secret = ""; status = ""; exchange = ""; strategy = ""
  }
  /^  - exchange:/ { exchange = $NF }
  /^    assigned_strategy:/ { strategy = $NF }
  /^    api_key:/ { key = $NF }
  /^    api_secret:/ { secret = $NF }
  /^    status:/ { status = $NF }
  /^  - exchange:/ || /^combinations:/ { next }
  END { }
  {
    if (exchange == ex && strategy == strat && status == "active" && key != "" && secret != "") {
      found_key = key; found_secret = secret
    }
  }
  END {
    if (found_key != "") {
      print "export GATE_API_KEY=" found_key
      print "export GATE_API_SECRET=" found_secret
    } else {
      print "echo \"No active entry for exchange=" ex " strategy=" strat " in registry\" >&2" > "/dev/stderr"
      exit 1
    }
  }
' "$REGISTRY")

if [[ -z "$result" ]]; then
  echo "No active entry for exchange=$EXCHANGE strategy=$STRATEGY in registry" >&2
  exit 1
fi

echo "$result"
