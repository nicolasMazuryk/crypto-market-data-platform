#!/usr/bin/env bash
set -euo pipefail

STAGE="${1:-${SST_STAGE:-prod}}"
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

REGION="${AWS_REGION}"
DRY_RUN="${DRY_RUN:-0}"
PROJECT_NAME="${SST_APP:-arbinet}"

# SST asset and state buckets are intentionally NOT deleted so they can be reused
# across stage removals and redeployments.

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] $*"
    return 0
  fi
  "$@"
}

discover_project_ecr_repositories() {
  local explicit="${ECR_REPOSITORIES:-}"
  if [[ -n "$explicit" ]]; then
    tr ',' '\n' <<< "$explicit" | sed '/^[[:space:]]*$/d'
    return 0
  fi

  aws ecr describe-repositories \
    --region "$REGION" \
    --query "repositories[?starts_with(repositoryName, \`${PROJECT_NAME}\`)].repositoryName" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^[[:space:]]*$/d'
}

delete_ecr_repo() {
  local repo="$1"
  if ! aws ecr describe-repositories --repository-names "$repo" --region "$REGION" >/dev/null 2>&1; then
    echo "ECR repository not found, skipping: $repo"
    return 0
  fi

  echo "Deleting ECR repository: $repo"
  run aws ecr delete-repository --repository-name "$repo" --force --region "$REGION"
}

echo "Running SST remove for stage: $STAGE (region: $REGION)"
run npx sst --stage "$STAGE" remove

echo "SST asset/state buckets are preserved (not deleted)."

ecr_repositories=()
while IFS= read -r repo; do
  [[ -z "${repo:-}" ]] && continue
  ecr_repositories+=("$repo")
done < <(discover_project_ecr_repositories)

if [[ "${#ecr_repositories[@]}" -eq 0 ]]; then
  echo "No project ECR repositories found for prefix: ${PROJECT_NAME}"
else
  for repo in "${ecr_repositories[@]}"; do
    delete_ecr_repo "$repo"
  done
fi

echo "deploy:remove cleanup complete"
