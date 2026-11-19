#!/usr/bin/env bash
# Deploy Aarogya-Vision to Cloud Run in asia-south1 using only Google Cloud services.
# Run from the repository root in Cloud Shell:
#   PROJECT_ID=your-project ./scripts/deploy-cloudrun.sh
# Optional: REGION, SERVICE, GEMINI_MODEL, VERTEX_LOCATION, MEDIA_BUCKET, BIGQUERY_DATASET.
# Safe to re-run: existing resources and secrets are kept.
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-aarogya-vision}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
VERTEX_LOCATION="${VERTEX_LOCATION:-$REGION}"
BUCKET="${MEDIA_BUCKET:-${PROJECT_ID}-aarogya-media}"
DATASET="${BIGQUERY_DATASET:-aarogya_analytics}"
TABLE="triage_events"
SA_NAME="aarogya-run"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling Google Cloud APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com storage.googleapis.com secretmanager.googleapis.com \
  aiplatform.googleapis.com bigquery.googleapis.com logging.googleapis.com

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

echo "==> Service account $SA (least privilege)"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="Aarogya-Vision Cloud Run"
fi
for role in roles/datastore.user roles/aiplatform.user roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$role" --condition=None >/dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectUser >/dev/null
bq --project_id="$PROJECT_ID" add-iam-policy-binding --member="serviceAccount:$SA" --role=roles/bigquery.dataEditor "$PROJECT_ID:$DATASET.$TABLE" >/dev/null

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
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 3 \
  --memory 512Mi --cpu 1 --timeout 120 \
  --set-env-vars "NODE_ENV=production,STORE=gcp,MEDIA_BUCKET=$BUCKET,GOOGLE_GENAI_USE_ENTERPRISE=true,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$VERTEX_LOCATION,GEMINI_MODEL=$GEMINI_MODEL,BIGQUERY_DATASET=$DATASET,BIGQUERY_TABLE=$TABLE,RETENTION_DAYS=$RETENTION_DAYS" \
  --set-secrets "SESSION_SECRET=aarogya-session-secret:latest,ACCESS_CODES=aarogya-access-codes:latest,ANALYTICS_SALT=aarogya-analytics-salt:latest"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "==> Deployed: $URL"
echo "    ASHA app:       $URL/"
echo "    Doctor console: $URL/doctor"
curl -fsS "$URL/api/health" && echo
curl -fsS "$URL/api/config" && echo
