#!/usr/bin/env bash
# Live-execution verification fan-out.
# Spawns one `claude -p` per active (exchange, strategy) pair in parallel.
#
# IMPORTANT: Uses --dangerously-skip-permissions. Only run if you trust the
# prompt at prompts/live-execution-verify.md (it is checked into the repo).
#
# Usage:
#   ./scripts/run-live-verification.sh
#   MAX_PARALLEL=3 ./scripts/run-live-verification.sh
#   DRY_RUN=1 ./scripts/run-live-verification.sh
#   PAIRS_FILE=/tmp/pairs.txt ./scripts/run-live-verification.sh   # one "exchange strategy" per line
#
# Update PAIRS below when live-configs/registry.yaml active rows change.
# Source of truth: grep -A3 'status: active' live-configs/registry.yaml | grep assigned_strategy
set -euo pipefail

# Ensure claude CLI is on PATH (installed to ~/.local/bin by default).
export PATH="$HOME/.local/bin:$PATH"

PROMPT_FILE="${PROMPT_FILE:-prompts/live-execution-verify.md}"
MAX_PARALLEL="${MAX_PARALLEL:-6}"
RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG_DIR="${LOG_DIR:-logs/live-verification}/$RUN_ID"
DRY_RUN="${DRY_RUN:-}"

# Hardcoded active pairs (confirmed from registry.yaml at script write-time).
# Update when assignments change.
PAIRS=(
    "binance strategy_1"
    "binance strategy_1_ws"
    "binance strategy_2"
    "binance strategy_4_1a"
    "binance strategy_6"
    "bybit strategy_1"
    "bybit strategy_1_ws"
    "bybit strategy_2"
    "bybit strategy_4_1a"
    "bybit strategy_6"
    "okx strategy_1"
    "okx strategy_1_ws"
    "okx strategy_2"
    "okx strategy_4_1a"
    "okx strategy_6"
    "bitget strategy_1"
    "bitget strategy_1_ws"
    "bitget strategy_2"
    "bitget strategy_4_1a"
    "bitget strategy_6"
    "gateio strategy_1"
    "gateio strategy_1_ws"
    "gateio strategy_2"
    "gateio strategy_4_1a"
    "gateio strategy_6"
    "kucoin strategy_1"
    "kucoin strategy_1_ws"
    "kucoin strategy_2"
    "kucoin strategy_4_1a"
    "kucoin strategy_6"
  )

# Override pair list from file if provided.
if [[ -n "${PAIRS_FILE:-}" ]]; then
  [[ -f "$PAIRS_FILE" ]] || { echo "PAIRS_FILE not found: $PAIRS_FILE" >&2; exit 2; }
  # bash 3.2 compat (macOS default): use while-read instead of mapfile
  PAIRS=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    PAIRS+=("$line")
  done < "$PAIRS_FILE"
fi

[[ -f "$PROMPT_FILE" ]] || { echo "missing $PROMPT_FILE" >&2; exit 2; }

if [[ -z "$DRY_RUN" ]]; then
  mkdir -p "$LOG_DIR"
fi

PROMPT_TEXT="$(cat "$PROMPT_FILE")"

declare -a PIDS=()
declare -a META=()
declare -a EXIT_CODES=()

trap 'echo; echo "[interrupt] killing spawned jobs..."; kill "${PIDS[@]}" 2>/dev/null; exit 130' INT TERM

spawn() {
  local exchange="$1" strategy="$2"
  local logfile="$LOG_DIR/${exchange}__${strategy}.log"
  printf '[spawn] %-10s %-15s → %s\n' "$exchange" "$strategy" "$logfile"
  if [[ -n "$DRY_RUN" ]]; then
    PIDS+=("0")
    META+=("$exchange|$strategy|$logfile")
    return
  fi
  (
    printf '%s %s\n\n%s\n' "$exchange" "$strategy" "$PROMPT_TEXT" \
      | claude -p --dangerously-skip-permissions --model sonnet --effort medium
  ) >"$logfile" 2>&1 &
  PIDS+=("$!")
  META+=("$exchange|$strategy|$logfile")
}

# Spawn pairs with concurrency cap.
for pair in "${PAIRS[@]}"; do
  # Wait until a slot is free.
  while (( $(jobs -rp | wc -l) >= MAX_PARALLEL )); do
    wait -n 2>/dev/null || true
  done
  read -r exchange strategy <<<"$pair"
  spawn "$exchange" "$strategy"
done

# Collect exit codes: wait for each PID individually before the summary loop.
for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  if [[ -n "$DRY_RUN" ]] || [[ "$pid" == "0" ]]; then
    EXIT_CODES[$i]="-"
  else
    wait "$pid" 2>/dev/null; EXIT_CODES[$i]=$?
  fi
done

# Print summary table.
fail=0
echo
printf '%-10s %-15s %-5s %s\n' EXCHANGE STRATEGY EXIT LOG
printf '%-10s %-15s %-5s %s\n' '--------' '--------' '----' '---'
for i in "${!META[@]}"; do
  IFS='|' read -r ex st lg <<<"${META[$i]}"
  ec="${EXIT_CODES[$i]}"
  [[ "$ec" != "-" ]] && (( ec != 0 )) && fail=1
  printf '%-10s %-15s %-5s %s\n' "$ex" "$st" "$ec" "$lg"
done

exit $fail
