#!/usr/bin/env bash
# Deploys one environment (staging or production) from THIS machine. There is no CI by the owner's decision, so the
# script itself enforces the gates: a clean, committed tree; `npm run check`; the launch check; an image scan;
# migrations as yalli_migrator in a one-off task; then a rolling update of the API, worker and frontend services,
# verified to have really reached the new revision.
#
# UNVERIFIED against AWS: written before AWS access existed (Phase 13). --dry-run exercises the local steps only (no
# describe/register/wait call is made); rehearse a real staging deploy before relying on it.
#
# Usage:
#   ./scripts/deploy.sh <staging|production> [--dry-run] [--skip-check]
#   ./scripts/deploy.sh <staging|production> --rollback <commit> [--dry-run]
#     --skip-check       re-deploy a commit that already passed the gate (rebuilds dist/ and checks the launch config)
#     --rollback <sha>   point the services back at the task revisions of an EARLIER deploy of <sha>: no build, no
#                        scan, no migration (migrations are additive, the old images run on the new schema)
#
# Configuration: deploy/<environment>.env (git-ignored; see deploy/example.env). Secrets (database URLs, keys) are
# NEVER in these files: the task definitions read them from Secrets Manager.
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-}"
DRY_RUN=0
SKIP_CHECK=0
ROLLBACK=""
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-check) SKIP_CHECK=1 ;;
    --rollback) ROLLBACK="${2:-}"; [[ -n "$ROLLBACK" ]] || { echo "--rollback needs a commit" >&2; exit 2; }; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$ENVIRONMENT" == staging || "$ENVIRONMENT" == production ]] || {
  echo "Usage: ./scripts/deploy.sh <staging|production> [--dry-run] [--skip-check] | --rollback <commit>" >&2
  exit 2
}

say() { printf '\n== %s\n' "$1"; }
die() { printf '\n\033[31mDEPLOY STOPPED: %s\033[0m\n' "$1" >&2; exit 1; }
run() { if [[ $DRY_RUN == 1 ]]; then printf '  [dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CONFIG="deploy/${ENVIRONMENT}.env"
[[ -f "$CONFIG" ]] || die "$CONFIG is missing (copy deploy/example.env)"
# The config is a plain KEY=value file read line by line (it is never executed as shell code).
while IFS='=' read -r key value; do
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
  value="${value%\"}"; value="${value#\"}"
  printf -v "$key" '%s' "$value"
done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$CONFIG")
for v in AWS_REGION AWS_ACCOUNT_ID ECR_REPO_API ECR_REPO_FRONTEND ECS_CLUSTER ECS_SERVICE_API ECS_SERVICE_WORKER \
  ECS_SERVICE_FRONTEND MIGRATE_TASK_FAMILY MIGRATE_SUBNETS MIGRATE_SECURITY_GROUPS FRONTEND_BUILD_ENV; do
  [[ -n "${!v:-}" ]] || die "$v is not set in $CONFIG"
done
# Images are built for the CPU the tasks run on; the task definitions must declare the same (runtimePlatform).
DEPLOY_PLATFORM="${DEPLOY_PLATFORM:-linux/arm64}"
case "$DEPLOY_PLATFORM" in
  linux/arm64) CPU_ARCH=ARM64 ;;
  linux/amd64) CPU_ARCH=X86_64 ;;
  *) die "DEPLOY_PLATFORM must be linux/arm64 or linux/amd64" ;;
esac
# The container to update in each task definition (sidecars such as a log router keep their own image).
API_CONTAINER="${API_CONTAINER:-api}"
WORKER_CONTAINER="${WORKER_CONTAINER:-worker}"
FRONTEND_CONTAINER="${FRONTEND_CONTAINER:-frontend}"
MIGRATE_CONTAINER="${MIGRATE_CONTAINER:-migrate}"
for tool in git docker jq node aws; do
  command -v "$tool" >/dev/null || [[ $DRY_RUN == 1 && $tool == aws ]] || die "$tool is not installed"
done
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

say "1. What is deployed"
if [[ -n "$(git status --porcelain)" ]]; then
  [[ $DRY_RUN == 1 ]] || die "uncommitted changes: deploy only committed code"
  echo "  (uncommitted changes: allowed for a dry run only)"
fi
if [[ -n "$ROLLBACK" ]]; then
  SHA="$(git rev-parse --short=12 "$ROLLBACK^{commit}" 2>/dev/null)" || die "$ROLLBACK is not a commit"
  echo "  ROLLBACK to the images of commit $SHA"
else
  SHA="$(git rev-parse --short=12 HEAD)"
  if [[ "$ENVIRONMENT" == production ]]; then
    git merge-base --is-ancestor HEAD origin/main 2>/dev/null || die "production deploys only commits that are on origin/main"
  fi
  echo "  commit $SHA"
fi
if [[ "$ENVIRONMENT" == production ]]; then
  printf 'This changes PRODUCTION. Type the environment name to continue: '
  read -r answer || true
  [[ "${answer:-}" == production ]] || die "not confirmed"
fi
API_IMAGE="${REGISTRY}/${ECR_REPO_API}:${SHA}"
MIGRATE_IMAGE="${REGISTRY}/${ECR_REPO_API}:${SHA}-migrate"
FRONTEND_IMAGE="${REGISTRY}/${ECR_REPO_FRONTEND}:${SHA}-${ENVIRONMENT}"

aws_() { aws --region "$AWS_REGION" "$@"; }
# The task-definition ARN currently used by a service.
service_def() { aws_ ecs describe-services --cluster "$ECS_CLUSTER" --services "$1" --query 'services[0].taskDefinition' --output text; }
family_of() { sed 's#.*/##; s#:[0-9]*$##' <<< "$1"; }

# Waits until a service's PRIMARY deployment runs `def` and is complete; a rollout the deployment circuit breaker
# reverted (stable again, but on the OLD revision) is a failure, not a success.
wait_rolled_out() {
  local service="$1" def="$2" state cur rollout running desired
  for _ in $(seq 1 60); do
    state="$(aws_ ecs describe-services --cluster "$ECS_CLUSTER" --services "$service" \
      --query 'services[0].deployments[?status==`PRIMARY`] | [0].[taskDefinition, rolloutState, runningCount, desiredCount]' --output text)"
    read -r cur rollout running desired <<< "$state"
    [[ "$cur" == "$def" ]] || die "$service is no longer on the new revision (circuit breaker rollback?): check its events"
    [[ "$rollout" == FAILED ]] && die "$service rollout FAILED: check its events"
    if [[ "$rollout" == COMPLETED || ( "$rollout" == None && "$running" == "$desired" && "$desired" != 0 ) ]]; then
      echo "  $service: on $def"; return 0
    fi
    sleep 15
  done
  die "$service did not finish rolling out within 15 minutes"
}

if [[ -n "$ROLLBACK" ]]; then
  say "2. Find the earlier task revisions of $SHA"
  # The newest ACTIVE revision of a family whose container `name` runs exactly `image`.
  revision_with_image() {
    local family="$1" name="$2" image="$3" arn
    for arn in $(aws_ ecs list-task-definitions --family-prefix "$family" --status ACTIVE --sort DESC --max-items 100 \
      --query 'taskDefinitionArns[]' --output text); do
      [[ "$(aws_ ecs describe-task-definition --task-definition "$arn" \
        --query "taskDefinition.containerDefinitions[?name=='$name'].image | [0]" --output text)" == "$image" ]] \
        && { echo "$arn"; return 0; }
    done
    return 1
  }
  declare -a PLAN=()
  for spec in "$ECS_SERVICE_API|$API_CONTAINER|$API_IMAGE" "$ECS_SERVICE_WORKER|$WORKER_CONTAINER|$API_IMAGE" \
    "$ECS_SERVICE_FRONTEND|$FRONTEND_CONTAINER|$FRONTEND_IMAGE"; do
    IFS='|' read -r service name image <<< "$spec"
    if [[ $DRY_RUN == 1 ]]; then echo "  [dry-run] $service -> the revision running $image"; continue; fi
    family="$(family_of "$(service_def "$service")")"
    def="$(revision_with_image "$family" "$name" "$image")" || die "no ACTIVE revision of $family runs $image"
    PLAN+=("$service|$def")
    echo "  $service -> $def"
  done
  say "3. Roll back and verify"
  for p in "${PLAN[@]+"${PLAN[@]}"}"; do
    IFS='|' read -r service def <<< "$p"
    aws_ ecs update-service --cluster "$ECS_CLUSTER" --service "$service" --task-definition "$def" >/dev/null
  done
  for p in "${PLAN[@]+"${PLAN[@]}"}"; do IFS='|' read -r service def <<< "$p"; wait_rolled_out "$service" "$def"; done
  say "Rolled $ENVIRONMENT back to $SHA"
  exit 0
fi

say "2. Quality gate"
if [[ $SKIP_CHECK == 1 ]]; then
  echo "  npm run check skipped on request (--skip-check): commit $SHA must already have passed it"
  npm run build >/dev/null || die "the backend build failed" # fresh dist/ for the checks below
else
  npm run check || die "npm run check failed"
fi
[[ -f "$FRONTEND_BUILD_ENV" ]] || die "FRONTEND_BUILD_ENV ($FRONTEND_BUILD_ENV) does not exist"
# The business settings of both apps must agree. The backend half comes from a NON-SECRET copy of its settings.
BACKEND_CHECK="deploy/${ENVIRONMENT}.backend-check.env"
if [[ -f "$BACKEND_CHECK" ]]; then
  node dist/cli/check-launch-config.js --frontend-env "$FRONTEND_BUILD_ENV" --backend-env "$BACKEND_CHECK" \
    || [[ "$ENVIRONMENT" == staging ]] || die "the launch configuration check failed"
elif [[ "$ENVIRONMENT" == production ]]; then
  die "$BACKEND_CHECK is missing: production needs the launch configuration check"
else
  echo "  (no $BACKEND_CHECK: launch configuration check skipped on staging)"
fi

image_in_ecr() { # repo tag
  [[ $DRY_RUN == 0 ]] && aws_ ecr describe-images --repository-name "$1" --image-ids "imageTag=$2" >/dev/null 2>&1
}
if [[ $DRY_RUN == 0 ]]; then
  aws_ ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
fi
# Builds, scans (HIGH/CRITICAL stop the deploy) and pushes one image, unless that exact tag is already in ECR: the
# API/migrate images of a commit are built ONCE (staging) and the same bytes are promoted to production.
build_scan_push() { # image repo tag docker-build-args...
  local image="$1" repo="$2" tag="$3"; shift 3
  if image_in_ecr "$repo" "$tag"; then echo "  $image is already in ECR (built and scanned earlier): reused"; return 0; fi
  run docker build --pull --platform "$DEPLOY_PLATFORM" -t "$image" "$@" # "$@" ends with the build context
  command -v trivy >/dev/null || [[ $DRY_RUN == 1 ]] || die "trivy is not installed (brew install trivy): images are never deployed unscanned"
  run trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$image"
  run docker push "$image"
}

say "3. Images ($DEPLOY_PLATFORM)"
build_scan_push "$API_IMAGE" "$ECR_REPO_API" "$SHA" --target runtime .
build_scan_push "$MIGRATE_IMAGE" "$ECR_REPO_API" "${SHA}-migrate" --target migrate .
# NEXT_PUBLIC_* and API_INTERNAL_URL are baked into the frontend: read exactly as the launch check read them.
BUILD_ARGS=()
while IFS= read -r -d '' kv; do BUILD_ARGS+=(--build-arg "$kv"); done < <(node dist/cli/frontend-build-args.js "$FRONTEND_BUILD_ENV")
[[ ${#BUILD_ARGS[@]} -gt 0 ]] || die "no build arguments found in $FRONTEND_BUILD_ENV"
build_scan_push "$FRONTEND_IMAGE" "$ECR_REPO_FRONTEND" "${SHA}-${ENVIRONMENT}" "${BUILD_ARGS[@]}" frontend

# A new revision of `family` with ONLY container `name` switched to `image`. Prints the new ARN; fails loudly.
register_with_image() { # family name image
  local family="$1" name="$2" image="$3" def arch out
  def="$(aws_ ecs describe-task-definition --task-definition "$family" --query taskDefinition)" || return 1
  arch="$(jq -r '.runtimePlatform.cpuArchitecture // "X86_64"' <<< "$def")" || return 1
  [[ "$arch" == "$CPU_ARCH" ]] || { echo "$family runs on $arch but the images are $CPU_ARCH" >&2; return 1; }
  jq -e --arg n "$name" '.containerDefinitions | any(.name == $n)' <<< "$def" >/dev/null \
    || { echo "$family has no container named $name" >&2; return 1; }
  jq --arg n "$name" --arg img "$image" '.containerDefinitions |= map(if .name == $n then .image = $img else . end)
    | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)' \
    <<< "$def" > "$TMP_DIR/taskdef.json" || return 1
  out="$(aws_ ecs register-task-definition --cli-input-json "file://$TMP_DIR/taskdef.json" \
    --query taskDefinition.taskDefinitionArn --output text)" || return 1
  [[ "$out" == arn:aws:ecs:* ]] || return 1
  echo "$out"
}

say "4. Register every new task revision (nothing changes yet)"
declare -a ROLLOUT=()
if [[ $DRY_RUN == 1 ]]; then
  echo "  [dry-run] register $MIGRATE_TASK_FAMILY ($MIGRATE_CONTAINER) and the api/worker/frontend services' families"
else
  MIGRATE_DEF="$(register_with_image "$MIGRATE_TASK_FAMILY" "$MIGRATE_CONTAINER" "$MIGRATE_IMAGE")" \
    || die "could not register the migration task revision"
  for spec in "$ECS_SERVICE_API|$API_CONTAINER|$API_IMAGE" "$ECS_SERVICE_WORKER|$WORKER_CONTAINER|$API_IMAGE" \
    "$ECS_SERVICE_FRONTEND|$FRONTEND_CONTAINER|$FRONTEND_IMAGE"; do
    IFS='|' read -r service name image <<< "$spec"
    family="$(family_of "$(service_def "$service")")"
    def="$(register_with_image "$family" "$name" "$image")" || die "could not register a revision for $service ($family)"
    ROLLOUT+=("$service|$def")
    echo "  $service -> $def"
  done
fi

say "5. Migrations (one-off task as yalli_migrator; the app never sees that URL)"
if [[ $DRY_RUN == 1 ]]; then
  echo "  [dry-run] run the migration revision and require container $MIGRATE_CONTAINER to exit 0"
else
  TASK="$(aws_ ecs run-task --cluster "$ECS_CLUSTER" --launch-type FARGATE --task-definition "$MIGRATE_DEF" \
    --network-configuration "awsvpcConfiguration={subnets=[${MIGRATE_SUBNETS}],securityGroups=[${MIGRATE_SECURITY_GROUPS}],assignPublicIp=DISABLED}" \
    --query 'tasks[0].taskArn' --output text)" || die "could not start the migration task"
  [[ "$TASK" == arn:aws:ecs:* ]] || die "could not start the migration task"
  stopped=0
  for _ in 1 2 3; do # each wait gives up after 10 minutes
    if aws_ ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$TASK" 2>/dev/null; then stopped=1; break; fi
  done
  [[ $stopped == 1 ]] || die "the migration task is still running after 30 minutes: nothing was rolled out; check $TASK"
  EXIT_CODE="$(aws_ ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$TASK" \
    --query "tasks[0].containers[?name=='$MIGRATE_CONTAINER'].exitCode | [0]" --output text)"
  [[ "$EXIT_CODE" == 0 ]] || die "the migration task failed (exit code $EXIT_CODE; stopped reason in the task): nothing was rolled out"
fi

say "6. Roll out (API, worker, frontend) and verify"
if [[ $DRY_RUN == 1 ]]; then
  echo "  [dry-run] update $ECS_SERVICE_API, $ECS_SERVICE_WORKER, $ECS_SERVICE_FRONTEND and wait for the new revisions"
else
  for p in "${ROLLOUT[@]}"; do
    IFS='|' read -r service def <<< "$p"
    aws_ ecs update-service --cluster "$ECS_CLUSTER" --service "$service" --task-definition "$def" >/dev/null \
      || die "update of $service failed (services updated before it keep the new revision: check the console)"
  done
  for p in "${ROLLOUT[@]}"; do IFS='|' read -r service def <<< "$p"; wait_rolled_out "$service" "$def"; done
fi

say "Deployed $SHA to $ENVIRONMENT"
echo "  Next: smoke test /health/ready and a page. To go back: ./scripts/deploy.sh $ENVIRONMENT --rollback <previous commit>"
