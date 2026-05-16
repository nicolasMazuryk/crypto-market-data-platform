#!/usr/bin/env bash
# Universal sub-account credential loader for all supported exchanges.
#
# Usage:
#   source <(bash scripts/exchange-subkey.sh <exchange> <strategy>)
#
# Prints `export` statements that load the correct env var names for each
# exchange's CLI/skill. Safe for parallel runs — each subprocess gets its
# own env space; never touches shared config files.
#
# Env vars emitted per exchange:
#   binance  → BINANCE_API_KEY, BINANCE_SECRET_KEY
#   bybit    → BYBIT_API_KEY, BYBIT_API_SECRET
#   okx      → OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE
#   bitget   → BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE
#   gateio   → GATE_API_KEY, GATE_API_SECRET
#   kucoin   → KUCOIN_API_KEY, KUCOIN_API_SECRET, KUCOIN_API_PASSPHRASE
#
# Skills/CLIs that consume them:
#   binance-cli  reads BINANCE_API_KEY / BINANCE_SECRET_KEY
#   bybit skill  reads BYBIT_API_KEY / BYBIT_API_SECRET (curl-based HMAC)
#   okx CLI      reads OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE
#   gate-cli     reads GATE_API_KEY / GATE_API_SECRET
#
# IMPORTANT: Never use --profile or config-init for parallel runs — those write
# to shared config files and will race. Always use env vars.

set -euo pipefail

EXCHANGE="${1:-}"
STRATEGY="${2:-}"

if [[ -z "$EXCHANGE" || -z "$STRATEGY" ]]; then
  echo "Usage: source <(bash scripts/exchange-subkey.sh <exchange> <strategy>)" >&2
  echo "Exchanges: binance bybit okx bitget gateio kucoin" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="$SCRIPT_DIR/../live-configs/registry.yaml"

if [[ ! -f "$REGISTRY" ]]; then
  echo "Registry not found: $REGISTRY" >&2
  exit 1
fi

# Extract fields from the matching active block.
CREDS="$(awk -v ex="$EXCHANGE" -v strat="$STRATEGY" '
  /^  - exchange:/ {
    if (exchange == ex && strategy == strat && status == "active" && key != "" && secret != "") {
      found_key = key; found_secret = secret; found_pass = passphrase
    }
    exchange = ""; strategy = ""; key = ""; secret = ""; passphrase = ""; status = ""
  }
  /^  - exchange:/       { exchange    = $NF }
  /^    assigned_strategy:/ { strategy = $NF }
  /^    api_key:/        { key         = $NF }
  /^    api_secret:/     { secret      = $NF }
  /^    api_passphrase:/ { passphrase  = ($NF == "null" ? "" : $NF) }
  /^    status:/         { status      = $NF }
  END {
    if (exchange == ex && strategy == strat && status == "active" && key != "" && secret != "") {
      found_key = key; found_secret = secret; found_pass = passphrase
    }
    if (found_key != "") {
      print found_key "|" found_secret "|" (found_pass == "" ? "" : found_pass)
    }
  }
' "$REGISTRY")"

if [[ -z "$CREDS" ]]; then
  echo "No active entry for exchange=$EXCHANGE strategy=$STRATEGY in registry" >&2
  exit 1
fi

IFS='|' read -r api_key api_secret api_passphrase <<< "$CREDS"

# Emit the right env var names for each exchange's skill/CLI.
case "$EXCHANGE" in
  binance)
    printf 'export BINANCE_API_KEY=%s\n' "$api_key"
    printf 'export BINANCE_SECRET_KEY=%s\n' "$api_secret"
    ;;
  bybit)
    printf 'export BYBIT_API_KEY=%s\n' "$api_key"
    printf 'export BYBIT_API_SECRET=%s\n' "$api_secret"
    ;;
  okx)
    printf 'export OKX_API_KEY=%s\n' "$api_key"
    printf 'export OKX_SECRET_KEY=%s\n' "$api_secret"
    printf 'export OKX_PASSPHRASE=%s\n' "$api_passphrase"
    ;;
  bitget)
    printf 'export BITGET_API_KEY=%s\n' "$api_key"
    printf 'export BITGET_API_SECRET=%s\n' "$api_secret"
    printf 'export BITGET_API_PASSPHRASE=%s\n' "$api_passphrase"
    ;;
  gateio)
    printf 'export GATE_API_KEY=%s\n' "$api_key"
    printf 'export GATE_API_SECRET=%s\n' "$api_secret"
    ;;
  kucoin|kucoinfutures)
    printf 'export KUCOIN_API_KEY=%s\n' "$api_key"
    printf 'export KUCOIN_API_SECRET=%s\n' "$api_secret"
    printf 'export KUCOIN_API_PASSPHRASE=%s\n' "$api_passphrase"
    ;;
  *)
    echo "Unknown exchange: $EXCHANGE (supported: binance bybit okx bitget gateio kucoin)" >&2
    exit 1
    ;;
esac
