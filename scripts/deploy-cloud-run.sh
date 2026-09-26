#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${GCP_REGION:?Set GCP_REGION}"
: "${CLOUD_RUN_SERVICE:?Set CLOUD_RUN_SERVICE}"
: "${ARTIFACT_REGISTRY_REPO:?Set ARTIFACT_REGISTRY_REPO}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REGISTRY_REPO}/${CLOUD_RUN_SERVICE}:$(date -u +%Y%m%d%H%M%S)"

if [[ "${CLOUD_RUN_BOOTSTRAP:-false}" == 'true' ]]; then
  # Health-only service. /mcp is 503, so no OAuth or Codeforces write can run.
  gcloud builds submit --project "$GCP_PROJECT_ID" --tag "$IMAGE" .
  gcloud run deploy "$CLOUD_RUN_SERVICE" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" \
    --image "$IMAGE" --platform managed --allow-unauthenticated --port 8080 \
    --cpu 1 --memory 1Gi --min-instances 0 --max-instances 1 --concurrency 1 --timeout 300 \
    --set-env-vars 'AUTH_MODE=bootstrap,ALLOW_REAL_SUBMISSIONS=false'
  exit 0
fi

: "${MCP_RESOURCE_URL:?Set MCP_RESOURCE_URL to the final HTTPS /mcp URL}"
: "${MCP_AUTH_ISSUER:?Set MCP_AUTH_ISSUER}"
: "${MCP_AUTH_AUDIENCE:?Set MCP_AUTH_AUDIENCE}"
: "${MCP_AUTH_JWKS_URL:?Set MCP_AUTH_JWKS_URL}"
: "${SUPABASE_URL:?Set SUPABASE_URL}"
: "${CF_STORAGE_STATE_SECRET_NAME:?Set CF_STORAGE_STATE_SECRET_NAME}"
ALLOW_REAL_SUBMISSIONS="${ALLOW_REAL_SUBMISSIONS:-false}"
EXPERIMENT_ENABLED="${EXPERIMENT_ENABLED:-false}"
if [[ "$ALLOW_REAL_SUBMISSIONS" != 'true' && "$ALLOW_REAL_SUBMISSIONS" != 'false' ]]; then
  echo 'ALLOW_REAL_SUBMISSIONS must be true or false.' >&2
  exit 1
fi
if [[ "$EXPERIMENT_ENABLED" != 'true' && "$EXPERIMENT_ENABLED" != 'false' ]]; then
  echo 'EXPERIMENT_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$EXPERIMENT_ENABLED" == 'true' ]]; then
  : "${EXPERIMENT_HANDLE:?Set EXPERIMENT_HANDLE for the authorized test account}"
  : "${CF_EXPECTED_HANDLE:?Set CF_EXPECTED_HANDLE to the same test account}"
  : "${CLOUD_TASKS_QUEUE:?Set CLOUD_TASKS_QUEUE}"
  : "${ORCHESTRATOR_SERVICE_URL:?Set ORCHESTRATOR_SERVICE_URL to the Cloud Run run.app base URL}"
  : "${CLOUD_TASKS_SERVICE_ACCOUNT:?Set CLOUD_TASKS_SERVICE_ACCOUNT}"
  if [[ "$EXPERIMENT_HANDLE" != "$CF_EXPECTED_HANDLE" ]]; then
    echo 'EXPERIMENT_HANDLE and CF_EXPECTED_HANDLE must match.' >&2
    exit 1
  fi
fi
if [[ -n "${SUPABASE_SECRET_NAME:-}" ]]; then
  SUPABASE_KEY_BINDING="SUPABASE_SECRET_KEY=${SUPABASE_SECRET_NAME}:latest"
else
  : "${SUPABASE_SERVICE_ROLE_SECRET_NAME:?Set SUPABASE_SECRET_NAME (preferred) or SUPABASE_SERVICE_ROLE_SECRET_NAME}"
  SUPABASE_KEY_BINDING="SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_SECRET_NAME}:latest"
fi
RESOURCE_HOST="$(node -e 'const u = new URL(process.argv[1]); if (u.protocol !== "https:" || u.pathname !== "/mcp") process.exit(1); process.stdout.write(u.hostname)' "$MCP_RESOURCE_URL")"
: "${ALLOWED_HOSTS:=$RESOURCE_HOST}"
if [[ "$EXPERIMENT_ENABLED" == 'true' ]]; then
  ORCHESTRATOR_HOST="$(node -e 'const u = new URL(process.argv[1]); if (u.protocol !== "https:" || u.pathname !== "/") process.exit(1); process.stdout.write(u.hostname)' "$ORCHESTRATOR_SERVICE_URL")"
  case ",${ALLOWED_HOSTS}," in
    *",${ORCHESTRATOR_HOST},"*) ;;
    *) ALLOWED_HOSTS="${ALLOWED_HOSTS},${ORCHESTRATOR_HOST}" ;;
  esac
fi
ENV_VALUES="AUTH_MODE=oauth@ALLOW_REAL_SUBMISSIONS=${ALLOW_REAL_SUBMISSIONS}@EXPERIMENT_ENABLED=${EXPERIMENT_ENABLED}@SUPABASE_URL=${SUPABASE_URL}@MCP_RESOURCE_URL=${MCP_RESOURCE_URL}@MCP_AUTH_ISSUER=${MCP_AUTH_ISSUER}@MCP_AUTH_AUDIENCE=${MCP_AUTH_AUDIENCE}@MCP_AUTH_JWKS_URL=${MCP_AUTH_JWKS_URL}@ALLOWED_HOSTS=${ALLOWED_HOSTS}"
for optional_name in CF_HANDLE CF_EXPECTED_HANDLE CF_ALLOWED_CONTEST_IDS EXPERIMENT_HANDLE GITHUB_TRIGGER_REPO GCP_PROJECT_ID GCP_REGION CLOUD_TASKS_QUEUE ORCHESTRATOR_SERVICE_URL CLOUD_TASKS_SERVICE_ACCOUNT; do
  if [[ -n "${!optional_name:-}" ]]; then
    ENV_VALUES="${ENV_VALUES}@${optional_name}=${!optional_name}"
  fi
done
SECRET_VALUES="CF_STORAGE_STATE_B64=${CF_STORAGE_STATE_SECRET_NAME}:latest,${SUPABASE_KEY_BINDING}"
if [[ -n "${GITHUB_TRIGGER_TOKEN_SECRET_NAME:-}" ]]; then
  SECRET_VALUES="${SECRET_VALUES},GITHUB_TRIGGER_TOKEN=${GITHUB_TRIGGER_TOKEN_SECRET_NAME}:latest"
fi
RUNTIME_IDENTITY=()
if [[ -n "${CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT:-}" ]]; then
  RUNTIME_IDENTITY=(--service-account "$CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT")
fi
gcloud builds submit --project "$GCP_PROJECT_ID" --tag "$IMAGE" .
gcloud run deploy "$CLOUD_RUN_SERVICE" \
  --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --image "$IMAGE" \
  --platform managed --allow-unauthenticated --port 8080 \
  --cpu 1 --memory 1Gi --min-instances 0 --max-instances 1 \
  --concurrency 1 --timeout 300 \
  "${RUNTIME_IDENTITY[@]}" \
  --set-env-vars "^@^${ENV_VALUES}" \
  --set-secrets "$SECRET_VALUES"
