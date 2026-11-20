#!/usr/bin/env bash
# Deploy Aarogya-Vision to Cloud Run in asia-south1 using only Google Cloud services.
# Run from the repository root in Cloud Shell:
#   PROJECT_ID=your-project ./scripts/deploy-cloudrun.sh
# Optional: REGION, SERVICE, GEMINI_MODEL, VERTEX_LOCATION, LIVE_MODEL, LIVE_LOCATION, MEDIA_BUCKET,
# BIGQUERY_DATASET, GEMMA_MODEL_URL, SKIP_RAG=1, SKIP_FIREBASE=1.
# Safe to re-run: existing resources and secrets are kept.
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-aarogya-vision}"
# gemini-3.5-flash is served from asia-south1, so Gemini processing stays in India.
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash}"
VERTEX_LOCATION="${VERTEX_LOCATION:-$REGION}"
LIVE_MODEL="${LIVE_MODEL:-gemini-3.8-live}"
LIVE_LOCATION="${LIVE_LOCATION:-$REGION}"
BUCKET="${MEDIA_BUCKET:-${PROJECT_ID}-aarogya-media}"
GUIDELINE_BUCKET="${GUIDELINE_BUCKET:-${PROJECT_ID}-aarogya-guidelines}"
DATASET="${BIGQUERY_DATASET:-aarogya_analytics}"
TABLE="triage_events"
TOPIC="${PUBSUB_TOPIC:-aarogya-case-events}"
ALERT_SUB="${TOPIC}-urgent-alerts"
HC_DATASET="${HEALTHCARE_DATASET:-aarogya}"
FHIR_STORE="${FHIR_STORE:-aarogya-fhir}"
SA_NAME="aarogya-run"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "==> Enabling Google Cloud APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com storage.googleapis.com secretmanager.googleapis.com \
  aiplatform.googleapis.com bigquery.googleapis.com logging.googleapis.com \
  pubsub.googleapis.com healthcare.googleapis.com iam.googleapis.com \
  firebase.googleapis.com firebasehosting.googleapis.com

echo "==> Cloud Build can build from source (default compute service account)"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/run.builder roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$BUILD_SA" --role="$role" --condition=None >/dev/null
done

echo "==> Firestore (Native mode) in $REGION"
if ! gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  gcloud firestore databases create --database="(default)" --location="$REGION" --type=firestore-native
fi

echo "==> Private media bucket gs://$BUCKET (media deleted after $RETENTION_DAYS days)"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
fi
LIFECYCLE="$(mktemp)"
printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":%s}}]}' "$RETENTION_DAYS" > "$LIFECYCLE"
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file="$LIFECYCLE" >/dev/null
rm -f "$LIFECYCLE"

echo "==> BigQuery dataset for de-identified analytics"
if ! bq --project_id="$PROJECT_ID" show "$DATASET" >/dev/null 2>&1; then
  bq --project_id="$PROJECT_ID" --location="$REGION" mk --dataset "$PROJECT_ID:$DATASET"
fi
if ! bq --project_id="$PROJECT_ID" show "$DATASET.$TABLE" >/dev/null 2>&1; then
  bq --project_id="$PROJECT_ID" mk --table --time_partitioning_field=event_at "$PROJECT_ID:$DATASET.$TABLE" deploy/bigquery-schema.json
fi

echo "==> Pub/Sub topic $TOPIC (case events) and urgent-alert subscription"
if ! gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1; then
  gcloud pubsub topics create "$TOPIC" --message-storage-policy-allowed-regions="$REGION"
fi
if ! gcloud pubsub subscriptions describe "$ALERT_SUB" >/dev/null 2>&1; then
  gcloud pubsub subscriptions create "$ALERT_SUB" --topic="$TOPIC" --message-filter='attributes.urgent = "true"' --message-retention-duration=7d
fi

echo "==> Cloud Healthcare API FHIR R4 store in $REGION"
if ! gcloud healthcare datasets describe "$HC_DATASET" --location="$REGION" >/dev/null 2>&1; then
  gcloud healthcare datasets create "$HC_DATASET" --location="$REGION"
fi
if ! gcloud healthcare fhir-stores describe "$FHIR_STORE" --dataset="$HC_DATASET" --location="$REGION" >/dev/null 2>&1; then
  gcloud healthcare fhir-stores create "$FHIR_STORE" --dataset="$HC_DATASET" --location="$REGION" --version=R4 --enable-update-create
fi

echo "==> Service account $SA (least privilege)"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="Aarogya-Vision Cloud Run"
fi
# pubsub.editor: each instance creates (and deletes) its own fan-out subscription for live updates.
for role in roles/datastore.user roles/aiplatform.user roles/logging.logWriter roles/pubsub.editor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$role" --condition=None >/dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectUser >/dev/null
bq --project_id="$PROJECT_ID" add-iam-policy-binding --member="serviceAccount:$SA" --role=roles/bigquery.dataEditor "$PROJECT_ID:$DATASET.$TABLE" >/dev/null
gcloud healthcare fhir-stores add-iam-policy-binding "$FHIR_STORE" --dataset="$HC_DATASET" --location="$REGION" \
  --member="serviceAccount:$SA" --role=roles/healthcare.fhirResourceEditor >/dev/null

RAG_CORPUS="${RAG_CORPUS:-}"
if [[ -z "$RAG_CORPUS" && "${SKIP_RAG:-0}" != "1" ]]; then
  echo "==> Vertex AI RAG Engine corpus of guideline PDFs (gs://$GUIDELINE_BUCKET)"
  if ! gcloud storage buckets describe "gs://$GUIDELINE_BUCKET" >/dev/null 2>&1; then
    gcloud storage buckets create "gs://$GUIDELINE_BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  fi
  [[ -d node_modules ]] || npm ci --omit=dev --ignore-scripts
  RAG_LOG="$(mktemp)"
  PROJECT_ID="$PROJECT_ID" PROJECT_NUMBER="$PROJECT_NUMBER" RAG_LOCATION="$REGION" GUIDELINE_BUCKET="$GUIDELINE_BUCKET" \
    node scripts/rag-corpus.mjs | tee "$RAG_LOG"
  RAG_CORPUS="$(sed -n 's/^RAG_CORPUS=//p' "$RAG_LOG")"
  rm -f "$RAG_LOG"
fi

echo "==> Secrets in Secret Manager (stored in $REGION)"
ensure_secret() {
  local name="$1" value="$2"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=user-managed --locations="$REGION" >/dev/null
    echo "    created $name"
  fi
  gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null
}
ensure_secret aarogya-session-secret "$(openssl rand -hex 32)"
ensure_secret aarogya-analytics-salt "$(openssl rand -hex 32)"
if ! gcloud secrets describe aarogya-access-codes >/dev/null 2>&1; then
  WORKER_CODE="asha-$(openssl rand -hex 6)"
  DOCTOR_CODE="doctor-$(openssl rand -hex 6)"
  ensure_secret aarogya-access-codes "[{\"code\":\"$WORKER_CODE\",\"role\":\"worker\",\"id\":\"asha-001\",\"name\":\"ASHA (demo)\"},{\"code\":\"$DOCTOR_CODE\",\"role\":\"doctor\",\"id\":\"dr-001\",\"name\":\"Doctor (demo)\"}]"
  echo "    Demo access codes, shown once. Store them safely:"
  echo "      ASHA worker: $WORKER_CODE"
  echo "      Doctor:      $DOCTOR_CODE"
else
  ensure_secret aarogya-access-codes ""
fi

echo "==> Building with Cloud Build and deploying to Cloud Run"
ENV_VARS="NODE_ENV=production,STORE=gcp,MEDIA_BUCKET=$BUCKET,GOOGLE_GENAI_USE_ENTERPRISE=true,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$VERTEX_LOCATION,GEMINI_MODEL=$GEMINI_MODEL,BIGQUERY_DATASET=$DATASET,BIGQUERY_TABLE=$TABLE,RETENTION_DAYS=$RETENTION_DAYS"
ENV_VARS+=",SPEECH_PROVIDER=gemini-live,LIVE_MODEL=$LIVE_MODEL,LIVE_LOCATION=$LIVE_LOCATION,PUBSUB_TOPIC=$TOPIC"
ENV_VARS+=",FHIR_STORE=$FHIR_STORE,HEALTHCARE_DATASET=$HC_DATASET,HEALTHCARE_LOCATION=$REGION"
# Demo deployments with synthetic data only: AUTO_LOGIN=true opens both apps without an access code.
if [ -n "${AUTO_LOGIN:-}" ]; then ENV_VARS+=",AUTO_LOGIN=$AUTO_LOGIN"; fi
[[ -n "$RAG_CORPUS" ]] && ENV_VARS+=",RAG_CORPUS=$RAG_CORPUS"
[[ -n "${GEMMA_MODEL_URL:-}" ]] && ENV_VARS+=",GEMMA_MODEL_URL=$GEMMA_MODEL_URL"
# --timeout 300: a live voice session lasts up to 3 minutes over one WebSocket.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 3 \
  --memory 512Mi --cpu 1 --timeout 300 --session-affinity \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "SESSION_SECRET=aarogya-session-secret:latest,ACCESS_CODES=aarogya-access-codes:latest,ANALYTICS_SALT=aarogya-analytics-salt:latest"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
# Behind Firebase Hosting (no WebSockets) the phone opens the Gemini Live socket on Cloud Run directly.
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "LIVE_WS_URL=${URL/https:/wss:}" >/dev/null

if [[ "${SKIP_FIREBASE:-0}" != "1" ]]; then
  echo "==> Firebase Hosting in front of Cloud Run (doctor dashboard)"
  npx --yes firebase-tools@latest projects:addfirebase "$PROJECT_ID" >/dev/null 2>&1 || true
  npx --yes firebase-tools@latest deploy --only hosting --project "$PROJECT_ID" --non-interactive
fi

echo "==> Deployed: $URL"
echo "    Live 3D dashboard: $URL/  (also https://$PROJECT_ID.web.app/)"
echo "    ASHA app:          $URL/asha"
curl -fsS "$URL/api/health" && echo
curl -fsS "$URL/api/config" && echo
