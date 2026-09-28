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
# gcloud's --set-env-vars delimiter can appear inside values such as service
# account emails. Write only an explicit nonsecret allowlist to a private YAML
# file; JSON-quoted scalars are valid YAML and preserve punctuation/newlines.
ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/cf-agent-mcp-env.XXXXXX")"
chmod 600 "$ENV_FILE"
trap 'rm -f -- "$ENV_FILE"' EXIT
export ALLOW_REAL_SUBMISSIONS EXPERIMENT_ENABLED ALLOWED_HOSTS SUPABASE_URL
export MCP_RESOURCE_URL MCP_AUTH_ISSUER MCP_AUTH_AUDIENCE MCP_AUTH_JWKS_URL
export CF_HANDLE CF_EXPECTED_HANDLE CF_ALLOWED_CONTEST_IDS EXPERIMENT_HANDLE GITHUB_TRIGGER_REPO
export GCP_PROJECT_ID GCP_REGION CLOUD_TASKS_QUEUE ORCHESTRATOR_SERVICE_URL CLOUD_TASKS_SERVICE_ACCOUNT
node - "$ENV_FILE" <<'NODE'
const { writeFileSync } = require('node:fs');
const required = {
  AUTH_MODE: 'oauth',
  ALLOW_REAL_SUBMISSIONS: process.env.ALLOW_REAL_SUBMISSIONS,
  EXPERIMENT_ENABLED: process.env.EXPERIMENT_ENABLED,
  SUPABASE_URL: process.env.SUPABASE_URL,
  MCP_RESOURCE_URL: process.env.MCP_RESOURCE_URL,
  MCP_AUTH_ISSUER: process.env.MCP_AUTH_ISSUER,
  MCP_AUTH_AUDIENCE: process.env.MCP_AUTH_AUDIENCE,
  MCP_AUTH_JWKS_URL: process.env.MCP_AUTH_JWKS_URL,
  ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
  CF_STORAGE_STATE_B64_FILE: '/var/secrets/cf/storage-state-b64',
};
const optional = [
  'CF_HANDLE', 'CF_EXPECTED_HANDLE', 'CF_ALLOWED_CONTEST_IDS',
  'EXPERIMENT_HANDLE', 'GITHUB_TRIGGER_REPO', 'GCP_PROJECT_ID', 'GCP_REGION',
  'CLOUD_TASKS_QUEUE', 'ORCHESTRATOR_SERVICE_URL', 'CLOUD_TASKS_SERVICE_ACCOUNT',
];
for (const name of optional) {
  if (process.env[name]) required[name] = process.env[name];
}
writeFileSync(process.argv[2], Object.entries(required)
  .map(([name, value]) => `${name}: ${JSON.stringify(value)}\n`).join(''), { mode: 0o600 });
NODE
SECRET_VALUES="/var/secrets/cf/storage-state-b64=${CF_STORAGE_STATE_SECRET_NAME}:latest,${SUPABASE_KEY_BINDING}"
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
  --env-vars-file "$ENV_FILE" \
  --set-secrets "$SECRET_VALUES"
