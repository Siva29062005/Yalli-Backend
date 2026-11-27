#!/usr/bin/env bash
# Deploys one environment (staging or production) from THIS machine. There is no CI by the owner's decision, so the
# script itself enforces the gates: a clean, committed tree; `npm run check`; an image scan; migrations as
# yalli_migrator in a one-off task; then a rolling update of the API, worker and frontend services.
#
# UNVERIFIED: written before AWS access existed (Phase 13). Rehearse it on staging with --dry-run first.
#
# Usage: ./scripts/deploy.sh <staging|production> [--dry-run] [--skip-check]
#   --dry-run     print every AWS/Docker command instead of running it (the checks still run)
#   --skip-check  only for re-deploying a commit that already passed the gate (a rollback): its images are rebuilt,
#                 scanned and pushed as usual
#
# Configuration: deploy/<environment>.env (not in git; see deploy/example.env), loaded before anything runs:
#   AWS_REGION, AWS_ACCOUNT_ID, ECR_REPO_API, ECR_REPO_FRONTEND, ECS_CLUSTER,
#   ECS_SERVICE_API, ECS_SERVICE_WORKER, ECS_SERVICE_FRONTEND,
#   MIGRATE_TASK_FAMILY, MIGRATE_SUBNETS (comma-separated), MIGRATE_SECURITY_GROUPS (comma-separated),
#   FRONTEND_BUILD_ENV (path to the env file with API_INTERNAL_URL and the NEXT_PUBLIC_* values for this environment)
# Secrets (database URLs, keys) are NEVER in these files: the task definitions read them from Secrets Manager.
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-}"
DRY_RUN=0
SKIP_CHECK=0
for a in "${@:2}"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --skip-check) SKIP_CHECK=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
[[ "$ENVIRONMENT" == staging || "$ENVIRONMENT" == production ]] || {
  echo "Usage: ./scripts/deploy.sh <staging|production> [--dry-run] [--skip-check]" >&2
  exit 2
}

say() { printf '\n== %s\n' "$1"; }
die() { printf '\n\033[31mDEPLOY REFUSED: %s\033[0m\n' "$1" >&2; exit 1; }
run() { if [[ $DRY_RUN == 1 ]]; then printf '  [dry-run] %q' "$1"; shift; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }

CONFIG="deploy/${ENVIRONMENT}.env"
[[ -f "$CONFIG" ]] || die "$CONFIG is missing (copy deploy/example.env)"
# shellcheck disable=SC1090
set -a; source "$CONFIG"; set +a
for v in AWS_REGION AWS_ACCOUNT_ID ECR_REPO_API ECR_REPO_FRONTEND ECS_CLUSTER ECS_SERVICE_API ECS_SERVICE_WORKER \
  ECS_SERVICE_FRONTEND MIGRATE_TASK_FAMILY MIGRATE_SUBNETS MIGRATE_SECURITY_GROUPS FRONTEND_BUILD_ENV; do
  [[ -n "${!v:-}" ]] || die "$v is not set in $CONFIG"
done
[[ -f "$FRONTEND_BUILD_ENV" ]] || die "FRONTEND_BUILD_ENV ($FRONTEND_BUILD_ENV) does not exist"
for tool in git docker jq aws; do
  command -v "$tool" >/dev/null || [[ $DRY_RUN == 1 && $tool == aws ]] || die "$tool is not installed"
done

say "1. The working tree is clean and committed"
if [[ -n "$(git status --porcelain)" ]]; then
  [[ $DRY_RUN == 1 ]] || die "uncommitted changes: deploy only committed code"
  echo "  (uncommitted changes: allowed for a dry run only)"
fi
SHA="$(git rev-parse --short=12 HEAD)"
if [[ "$ENVIRONMENT" == production ]]; then
  [[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || die "production deploys come from main"
  printf 'Deploying %s to PRODUCTION. Type the environment name to continue: ' "$SHA"
  read -r answer
  [[ "$answer" == production ]] || die "not confirmed"
fi
echo "  commit $SHA"

say "2. Quality gate (npm run check)"
if [[ $SKIP_CHECK == 1 ]]; then
  echo "  skipped on request (--skip-check): commit $SHA must already have passed it"
else
  npm run check || die "npm run check failed"
fi
# The business settings of both apps must agree (npm run check:launch). The backend half comes from a NON-SECRET copy
# of its settings (SELLER_*, FRONTEND_BASE_URL, SUPPORT_INBOX_EMAIL): deploy/<environment>.backend-check.env.
BACKEND_CHECK="deploy/${ENVIRONMENT}.backend-check.env"
if [[ -f "$BACKEND_CHECK" ]]; then
  node dist/cli/check-launch-config.js --frontend-env "$FRONTEND_BUILD_ENV" --backend-env "$BACKEND_CHECK" \
    || [[ "$ENVIRONMENT" == staging ]] || die "the launch configuration check failed"
elif [[ "$ENVIRONMENT" == production ]]; then
  die "$BACKEND_CHECK is missing: production needs the launch configuration check"
else
  echo "  (no $BACKEND_CHECK: launch configuration check skipped on staging)"
fi

REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
API_IMAGE="${REGISTRY}/${ECR_REPO_API}:${SHA}"
FRONTEND_IMAGE="${REGISTRY}/${ECR_REPO_FRONTEND}:${SHA}-${ENVIRONMENT}"
MIGRATE_IMAGE="${REGISTRY}/${ECR_REPO_API}:${SHA}-migrate"

say "3. Build the images"
run docker build --pull --target runtime -t "$API_IMAGE" .
run docker build --pull --target migrate -t "$MIGRATE_IMAGE" .
# NEXT_PUBLIC_* and API_INTERNAL_URL are baked into the frontend build: one image per environment.
BUILD_ARGS=()
while IFS='=' read -r key value; do
  [[ "$key" =~ ^(NEXT_PUBLIC_[A-Z_]+|API_INTERNAL_URL)$ ]] || continue
  value="${value%\"}"; value="${value#\"}"
  BUILD_ARGS+=(--build-arg "${key}=${value}")
done < <(grep -E '^[A-Z_]+=' "$FRONTEND_BUILD_ENV")
run docker build --pull "${BUILD_ARGS[@]}" -t "$FRONTEND_IMAGE" frontend

say "4. Scan the images (HIGH/CRITICAL vulnerabilities stop the deploy)"
command -v trivy >/dev/null || [[ $DRY_RUN == 1 ]] || die "trivy is not installed (brew install trivy): images are never deployed unscanned"
for image in "$API_IMAGE" "$MIGRATE_IMAGE" "$FRONTEND_IMAGE"; do
  run trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$image"
done

say "5. Push to ECR"
if [[ $DRY_RUN == 0 ]]; then
  aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
fi
for image in "$API_IMAGE" "$MIGRATE_IMAGE" "$FRONTEND_IMAGE"; do run docker push "$image"; done

# A new task-definition revision of `family` with every container's image replaced by `image`.
register_with_image() {
  local family="$1" image="$2" def
  if [[ $DRY_RUN == 1 ]]; then echo "  [dry-run] register $family with $image"; echo "$family"; return; fi
  def="$(aws ecs describe-task-definition --region "$AWS_REGION" --task-definition "$family" --query taskDefinition)"
  jq --arg img "$image" '.containerDefinitions |= map(.image = $img)
    | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)' <<< "$def" \
    > "/tmp/yalli-taskdef-$$.json"
  aws ecs register-task-definition --region "$AWS_REGION" --cli-input-json "file:///tmp/yalli-taskdef-$$.json" \
    --query taskDefinition.taskDefinitionArn --output text
  rm -f "/tmp/yalli-taskdef-$$.json"
}

say "6. Migrations (one-off task as yalli_migrator; the app never sees that URL)"
MIGRATE_DEF="$(register_with_image "$MIGRATE_TASK_FAMILY" "$MIGRATE_IMAGE" | tail -1)"
if [[ $DRY_RUN == 0 ]]; then
  TASK="$(aws ecs run-task --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --launch-type FARGATE \
    --task-definition "$MIGRATE_DEF" \
    --network-configuration "awsvpcConfiguration={subnets=[${MIGRATE_SUBNETS}],securityGroups=[${MIGRATE_SECURITY_GROUPS}],assignPublicIp=DISABLED}" \
    --query 'tasks[0].taskArn' --output text)"
  aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --tasks "$TASK"
  EXIT_CODE="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --tasks "$TASK" \
    --query 'tasks[0].containers[0].exitCode' --output text)"
  [[ "$EXIT_CODE" == 0 ]] || die "the migration task failed (exit code $EXIT_CODE): nothing was rolled out; check its CloudWatch log"
else
  echo "  [dry-run] run $MIGRATE_DEF and require exit code 0"
fi

say "7. Roll out (API, worker, frontend) and wait until they are stable"
for pair in "$ECS_SERVICE_API:$API_IMAGE" "$ECS_SERVICE_WORKER:$API_IMAGE" "$ECS_SERVICE_FRONTEND:$FRONTEND_IMAGE"; do
  service="${pair%%:*}"; image="${pair#*:}"
  if [[ $DRY_RUN == 1 ]]; then echo "  [dry-run] update $service to $image"; continue; fi
  family="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --services "$service" \
    --query 'services[0].taskDefinition' --output text | sed 's#.*/##; s#:[0-9]*$##')"
  def="$(register_with_image "$family" "$image" | tail -1)"
  aws ecs update-service --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --service "$service" --task-definition "$def" >/dev/null
done
if [[ $DRY_RUN == 0 ]]; then
  aws ecs wait services-stable --region "$AWS_REGION" --cluster "$ECS_CLUSTER" \
    --services "$ECS_SERVICE_API" "$ECS_SERVICE_WORKER" "$ECS_SERVICE_FRONTEND"
fi

say "Deployed $SHA to $ENVIRONMENT"
echo "  Next: smoke test /health/ready and a page; on trouble, re-run with the previous commit and --skip-check."
