---
name: aarogya-deploy-cloud-run
description: Use when deploying, redeploying or configuring Aarogya-Vision on Google Cloud (Cloud Run, Cloud Build, Firestore, Cloud Storage, Secret Manager, Vertex AI Gemini, BigQuery), or when troubleshooting the deployed service.
---

# Deploy Aarogya-Vision to Google Cloud

## Goal
Run the app on Cloud Run in asia-south1 (Mumbai), using only Google Cloud services, with no secrets in source control.

## Instructions
1. Confirm `gcloud auth list` and `gcloud config get-value project`. Activate the buildathon credits on the same Gmail account.
2. Run `scripts/deploy-cloudrun.sh` from Cloud Shell (or any shell with `gcloud`) with `PROJECT_ID` set. The script is safe to re-run. It:
   - enables Cloud Run, Cloud Build, Artifact Registry, Firestore, Cloud Storage, Secret Manager, Vertex AI and BigQuery APIs;
   - creates a Firestore database, a private media bucket and a BigQuery dataset in asia-south1;
   - creates a dedicated service account with least-privilege roles;
   - stores `SESSION_SECRET`, `ACCESS_CODES` and `ANALYTICS_SALT` in Secret Manager;
   - builds from source with Cloud Build (`gcloud run deploy --source .`) and deploys.
3. Gemini runs through Vertex AI (`GOOGLE_GENAI_USE_ENTERPRISE=true`) with the service account, so no API key is needed. Check that `GEMINI_MODEL` is available in `GOOGLE_CLOUD_LOCATION`; if not, choose a supported region and update the data-residency statement in README.md.
4. Verify with `curl https://<service-url>/api/health` and `/api/config`, then run the demo in README.md.

## Constraints
- Never commit `.env`, access codes, API keys or service-account keys. Use Secret Manager.
- Keep `NODE_ENV=production`. The server refuses to start without real secrets, and refuses the mock AI provider in production.
- Do not use real patient data. The deployment is a prototype for synthetic cases.
