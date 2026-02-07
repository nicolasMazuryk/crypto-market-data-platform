#!/usr/bin/env bash
set -euo pipefail

STAGE="${1:-prod}"
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

echo "Starting migration task for stage: $STAGE (region: $REGION)"
start_output="$(bash infra/sst-with-env.sh "$STAGE" shell -- node --input-type=module -e "import { Resource } from 'sst'; import { task } from 'sst/aws/task'; const result = await task.run(Resource.MigrationRunner); console.log(result.arn)")"
echo "$start_output"

task_arn="$(printf '%s\n' "$start_output" | grep -Eo 'arn:aws:ecs:[^[:space:]]+' | tail -n 1)"
if [[ -z "${task_arn}" ]]; then
  echo "Failed to extract migration task ARN from output"
  exit 1
fi

cluster_name="$(echo "$task_arn" | sed -E 's#^arn:aws:ecs:[^:]+:[0-9]+:task/([^/]+)/([^/]+)$#\1#')"
task_id="${task_arn##*/}"

if [[ -z "${cluster_name}" || "$cluster_name" == "$task_arn" ]]; then
  echo "Failed to parse ECS cluster name from task ARN: $task_arn"
  exit 1
fi

echo "Waiting for task to stop: $task_arn"
while true; do
  last_status="$(aws ecs describe-tasks --cluster "$cluster_name" --tasks "$task_arn" --region "$REGION" --query 'tasks[0].lastStatus' --output text 2>/dev/null || true)"
  if [[ "$last_status" == "STOPPED" ]]; then
    break
  fi
  if [[ "$last_status" == "None" || -z "$last_status" ]]; then
    echo "Task not found while waiting: $task_arn"
    exit 1
  fi
  sleep 4
done

exit_code="$(aws ecs describe-tasks --cluster "$cluster_name" --tasks "$task_arn" --region "$REGION" --query 'tasks[0].containers[0].exitCode' --output text)"
stopped_reason="$(aws ecs describe-tasks --cluster "$cluster_name" --tasks "$task_arn" --region "$REGION" --query 'tasks[0].stoppedReason' --output text)"
container_reason="$(aws ecs describe-tasks --cluster "$cluster_name" --tasks "$task_arn" --region "$REGION" --query 'tasks[0].containers[0].reason' --output text)"

if [[ "$exit_code" != "0" ]]; then
  echo "Migration task failed (exitCode=$exit_code)"
  echo "Stopped reason: $stopped_reason"
  echo "Container reason: $container_reason"

  task_definition_arn="$(aws ecs describe-tasks --cluster "$cluster_name" --tasks "$task_arn" --region "$REGION" --query 'tasks[0].taskDefinitionArn' --output text)"
  container_name="$(aws ecs describe-task-definition --task-definition "$task_definition_arn" --region "$REGION" --query 'taskDefinition.containerDefinitions[0].name' --output text)"
  log_group="$(aws ecs describe-task-definition --task-definition "$task_definition_arn" --region "$REGION" --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-group"' --output text)"
  log_prefix="$(aws ecs describe-task-definition --task-definition "$task_definition_arn" --region "$REGION" --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-stream-prefix"' --output text)"
  log_stream="${log_prefix}/${container_name}/${task_id}"

  echo "Last migration logs (${log_group} :: ${log_stream}):"
  log_events_file="$(mktemp)"
  if aws logs get-log-events \
    --log-group-name "$log_group" \
    --log-stream-name "$log_stream" \
    --region "$REGION" \
    --limit 200 \
    --output json > "$log_events_file"; then
    node --input-type=module -e "import fs from 'node:fs'; const payload = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); for (const event of payload.events ?? []) { if (typeof event.message === 'string') process.stdout.write(event.message.endsWith('\n') ? event.message : event.message + '\n'); }" "$log_events_file" || cat "$log_events_file"
  else
    echo "Failed to fetch CloudWatch log events"
  fi
  rm -f "$log_events_file"

  exit 1
fi

echo "Migration task completed successfully: $task_arn"
