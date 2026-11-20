# Aarogya-Vision

**A photo and a voice note from an ASHA worker become a doctor-ready, guideline-cited case, with urgent newborns flagged first.**

Built for Google DeepMind × Google Cloud **Startup Buildathon India 2026** on Google AI (Gemini) and Google Cloud only.

> **Prototype.** Use synthetic or role-play cases only. Not for clinical use. AI output is a documentation aid; the doctor makes every clinical decision.

Full background, buildathon rules, design decisions and status: **[KNOWLEDGE.md](KNOWLEDGE.md)**.

![Architecture](docs/architecture.svg)

## The problem

ASHA workers are often a village's first health contact, but they cannot *show* a remote doctor what they see. Cases reach doctors by phone or on paper, late and unstructured, and danger signs in newborns are missed.

## What this MVP does

One clinical scenario, end to end: **home visits for young infants (0-59 days)**, using the WHO / MoHFW IMNCI danger signs.

1. **Capture in seconds (ASHA phone, works offline).** Two big buttons, **Take photo** and **Speak** (in Tamil, Hindi or English). Patient details are optional and folded away; one consent switch and an optional **I see a danger sign** switch. The case goes to the shared queue: any doctor on the dashboard can answer, and the phone shows how many doctors are online.
2. **Gemini fills the fields.** Gemini reads the photo and voice note together. It fills in the baby's age, sex, temperature, breath count and which danger signs the worker said were present or absent. It also returns a transcript, an English translation and follow-up questions. It does not diagnose or prescribe.
3. **The worker sees what was understood.** The phone shows the urgency result and a **What we understood** card: each value is tagged *from voice* or *from photo*, and the card lists the questions the doctor may ask.
4. **Offline-safe.** Without network, the visit is encrypted on the phone (AES-GCM, non-extractable key) and sends itself when the network returns. Meanwhile the phone shows a "refer now if you see any of these" danger-sign list. The danger switch gives *Urgent: refer now* instantly, with no AI or network needed.
5. **Cited guidance.** Each case cites curated WHO / MoHFW guidance, matched deterministically to its danger signs.
6. **Safe urgency.** Deterministic rules run on the AI-filled values. AI findings can **raise** urgency, never lower it. A voice-only case without an answer for every sign is at least *doctor review today*. Photo-only AI findings are capped at *review today* and marked *verify*.
7. **Doctor decides, on one dashboard.** The doctor dashboard is a game-like 3D map of the block (`/live`, also `/doctor`). Every place with a new case gets a **red location pin**, and a collapsible **Needs attention** list names the places. Clicking a pin, the village or the list zooms in and opens that place's cases in the side panel. A case shows what the AI organised: symptoms and danger signs with their source and evidence, the photo (click to enlarge) with what is visible in it, the **voice note translated to English** (original and audio on request), patient details, vitals, history, questions still open and the cited guidance. AI describes, it never diagnoses. The doctor then **prescribes medicines** (quick picks of common essential medicines; the doctor gives every dose), **escalates** to a larger hospital (PHC Jamunamarathur, GH Polur or GMCH Tiruvannamalai, now with 108 or within a day), or **asks the ASHA** for more. A private assessment field holds the doctor's own provisional diagnosis.
8. **Act.** The ASHA sees the reply, machine-translated into her language by Gemini, with the doctor's original text always shown below.
9. **Rash photo check (on the phone).** Right after a photo, the ASHA sees what the skin looks like (for example *round or ring-shaped patches* or *blisters, pus spots or crusts*) and which danger signs to check. It never names a disease, isn't saved, and never changes urgency; the doctor decides. Draft wording.
10. **Medicines to the door.** After prescribing, the doctor clicks **Look for medicines**. A scan sweeps out across the map from the patient's home. Every PHC pharmacy, HWC sub-centre and private medical shop that has a prescribed medicine lights up with its stock and its distance from the patient. The doctor ticks one or more places (a suggestion covers everything with the fewest, nearest stops) and clicks **Send bike**. One bike collects from each place in turn and rides to the patient. The ASHA's phone shows *Medicines on the way* with the places and an ETA, then *Delivered*. Stock, distances and bikes are simulated for the demo.
11. **Around it, the block.** The same map shows the hill villages around Jamunamarathur, the PHCs and HWC sub-centres with doctors on duty, free beds and medicine stock, couriers, vans and 108 ambulances, and homes that turn **red** (*urgent*) or **yellow** (*review today*). The block's operations are simulated; the cases from the ASHA app are real. All panels collapse. A phone button at the top right opens the **rural worker app as a phone** on the same screen, for the demo.

## Google stack

| Need | Google service / tool | Where |
|---|---|---|
| Multimodal understanding (photo + voice + form) | **Gemini** via **Vertex AI** in production (`gemini-3.5-flash`, served from asia-south1), Gemini API key in dev | `src/ai/gemini.js`, `src/ai/prompt.js`, `src/ai/schema.js` |
| Live text and spoken follow-up questions | **Gemini Live API** (`gemini-3.8-live`, Vertex AI asia-south1) through a Cloud Run WebSocket relay | `src/speech/geminiLive.js`, `public/js/live-speech.js` |
| Offline danger-sign helper on the phone | **Gemma** 3 1B through **Google AI Edge MediaPipe LLM Inference** (WebGPU). It only suggests signs to check | `public/js/gemma-offline.js`, `public/shared/gemmaPrompt.js` |
| Guideline passages from the PDFs (RAG) | **Vertex AI RAG Engine** over MoHFW PDFs in Cloud Storage. Supplementary only; the curated citations stay authoritative | `src/rag.js`, `scripts/rag-corpus.mjs`, `deploy/guideline-pdfs.txt` |
| FHIR R4 case records | **Cloud Healthcare API** FHIR store (asia-south1) | `src/fhir.js`, `src/healthcare.js` |
| Urgent alerts, live updates across instances | **Cloud Pub/Sub** (topic `aarogya-case-events`, filtered `urgent-alerts` subscription) | `src/events.js` |
| Doctor dashboard hosting | **Firebase Hosting** rewriting to Cloud Run | `firebase.json` |
| Structured output, safety filters | Gemini `responseJsonSchema`; blocked responses fall back to human review | `src/ai/gemini.js` |
| Translation of doctor instructions | Gemini | `src/ai/gemini.js` |
| Prompt testing and model choice | **Google AI Studio** | `docs/ai-studio/` |
| Hosting | **Cloud Run** (asia-south1), built by **Cloud Build** from a Google-hosted base image (`mirror.gcr.io`), images in **Artifact Registry** | `Dockerfile`, `scripts/deploy-cloudrun.sh` |
| Case records | **Firestore** (Native mode) | `src/store/gcpStore.js` |
| Photos and voice notes | **Cloud Storage** (private bucket, 30-day lifecycle) | `src/store/gcpStore.js` |
| Secrets | **Secret Manager** | `scripts/deploy-cloudrun.sh` |
| Audit trail | **Cloud Logging** (structured logs) | `src/audit.js` |
| District analytics | **BigQuery** + BigQuery data agent (Conversational Analytics) | `src/analytics.js`, `docs/bigquery-data-agent.md` |
| UI | **Material 3**: official `@material/web` components, tokens from **Material Color Utilities**, Material Symbols, Roboto and Noto fonts (self-hosted) | `ui/`, `scripts/build-ui.mjs`, `public/` |
| Agentic development | **Google Antigravity** with project **Agent Skills** | `.agents/skills/` |

No third-party AI, database, hosting, analytics, font or icon services are used at runtime. Open-source libraries: Express, Multer, Helmet, zod, Three.js (the 3D live view, bundled and served from our own origin, no CDN), plus Playwright and esbuild for dev.

## Safety and responsible AI

- **Google terms.** The [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) prohibit use "in clinical practice, to provide medical advice, or in any manner that is overseen by or requires clearance or approval from a medical device regulatory agency". This build is therefore a labelled prototype for synthetic cases. A field pilot would need Vertex AI under Google Cloud terms, clinical validation and a regulatory pathway (for example CDSCO software-as-a-medical-device).
- **Human supervision.** Google's [Generative AI Prohibited Use Policy](https://policies.google.com/terms/generative-ai/use-policy) disallows automated healthcare decisions without human supervision. Here the doctor decides every case. The phone's urgent advice comes from published, deterministic danger-sign rules, not from AI.
- **AI can only raise urgency.** Enforced in `public/shared/triage.js` and covered by tests. Values Gemini fills in never override what the worker entered, are range-checked, and are tagged with their source in both UIs.
- **Non-diagnostic prompt.** The prompt forbids diagnoses, medicines and urgency decisions, asks for explicit evidence only, and tells the model to ignore instructions inside the voice note or notes (prompt injection).
- **Fail safe.** Safety blocks, timeouts, invalid JSON or schema failures mark the AI step as failed and raise the case to human review.
- **Transparency.** Every AI output is labelled *AI-generated* with its model. Findings show their source and a *verify* tag. Translations are labelled machine-translated, with the original shown.
- **Data minimisation.** No names go to Gemini (age, sex, checklist, vitals and notes only). The optional reference field is initials only. Re-encoding the photo strips EXIF and GPS data.
- **Security.** Signed role tokens, strict schema validation, file-type sniffing, and media served only to doctors. Strict CSP (scripts `'self'`; only style attributes inline, which Material Web needs; framing only by our own pages, for the dashboard's demo phone), rate-limited login. Production refuses demo codes and the mock AI provider.
- **Privacy.** Data is encrypted on the phone, and at rest in Firestore, Cloud Storage and the Cloud Healthcare FHIR store (Google-managed encryption) in asia-south1. Cases, their media and their FHIR resources are purged after 30 days. The audit trail, Pub/Sub events and BigQuery analytics hold IDs, hashes and de-identified fields only. RAG queries carry danger-sign labels only, never notes or patient details.
- **Gemini Live and Gemma only ask or suggest.** Gemini Live asks at most two spoken follow-up questions, and Gemma (offline) suggests signs to check. Neither answers the checklist or changes urgency.
- **Content review still needed.** The danger-sign wording, guideline corpus and Hindi/Tamil text are **drafts**. They need clinician and native-speaker sign-off.

## Run locally

Requires Node.js 22+.

```bash
npm install
cp .env.example .env        # AI_PROVIDER=mock works with no keys
npm run dev                 # builds the Material UI, then serves http://localhost:8080
```

- Opening screen and doctor dashboard: <http://localhost:8080/> (the 3D live view; also `/live` and `/doctor`). Sign in with the chip in the top bar, demo code `doctor-demo` (Dr. R. Senthil). Without signing in it shows the simulated block only. Options: `?seed=42` repeats a run, `?season=monsoon` or `?season=festival`, `?night=1`, `#case=<id>` opens a case.
- ASHA app: <http://localhost:8080/asha> (also the phone button on the dashboard). Demo code `asha-demo` (Parvati; a second worker: `asha-demo-2`, Meena).
- The earlier list-based console is still at <http://localhost:8080/doctor/classic> (FHIR download, filters).

To use real Gemini, set `AI_PROVIDER=gemini` and either a `GEMINI_API_KEY` from Google AI Studio, or `GOOGLE_GENAI_USE_ENTERPRISE=true` with `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` (Vertex AI with your gcloud credentials).

## Patients, database and all ages (merged from the first prototype)

- **Patient first.** A visit starts with *Who is the patient?*: search the worker's own patients or add one with name, age (days, weeks, months or years) and sex. For a woman, a *Pregnant* switch asks how many months. The same name and sex for the same worker is recognised as a returning patient, and the visit is counted.
- **Local database.** `STORE=sqlite` (the default in development) keeps everything in one SQLite file, `.localdata/aarogya.db`, built into Node: tables `ashas`, `doctors`, `patients`, `cases` and `audit`. Photos and voice notes stay under `.localdata/media/`. `STORE=gcp` still uses Firestore and Cloud Storage.
- **All ages.** The young-infant checklist is unchanged. Older children, adults and pregnant women get the all-ages danger signs (pregnancy bleeding, headache or blurred vision, reduced movement, snake bite, chest pain, wounds, diarrhoea with dehydration and more) and their cited guidance. The worker's typed note is read in English, Hindi or Tamil, with negation ("no fever").
- **People.** `src/people.json` holds the demo ASHA workers (Parvati in Nammiyampattu, Jawadhu Hills) and their doctor (Dr. R. Senthil). The ASHA's phone shows her profile card, and the doctor sees her village and PHC.
- **Worker steps.** *What to do now* shows curated steps from the cited guideline in the worker's language, with a **Read aloud** button. A filter blocks any medicine or dose.
- **Classic list console** (`/doctor/classic`). KPI cards, search, *Today*/*Yesterday*/*Returning*/*Pregnant* filters, patient history, live updates (server-sent events) and **Download FHIR record** (also saved under `.localdata/fhir/`).
- **Safety filter.** Sentences in which the AI names a condition are removed before the doctor sees the summary.
- **Gemini fallback.** `GEMINI_MODEL` can list several models separated by commas. If one is overloaded (503) or rate-limited (429), the next is tried.

```bash
npm run seed           # 6 demo cases from the first prototype (Murugan returns the next day)
```

- Offline rules test: <http://localhost:8080/offline-test>. It runs 16 cases through the phone's offline rules and must show 0 under-triage.

## Three-minute demo

1. Open the ASHA app (`/asha`) on a phone (or Chrome device mode). In demo mode it opens signed in as Parvati, with no access code (`AUTO_LOGIN`, on by default outside production). Switch to **தமிழ்** with the translate button. With `SPEECH_PROVIDER=gemini-live` the Tamil words appear live as she speaks and are translated to English for the doctor (Vertex AI, your `gcloud` login; see `.env.example`).
2. Tap **New visit**, then **Speak**, and say: "Baby girl, 8 days old, not feeding since morning, feels hot, temperature 38.3, no fits." Turn on consent and tap **Send to doctor**.
3. A few seconds later: *Urgent: refer now*, and **What we understood** shows age 8 days, girl and 38.3 °C, each tagged *from voice*, plus the danger signs heard.
4. Turn the network off. Start another visit: take a photo only, turn on **I see a danger sign**, and send. *Urgent: refer now* and the danger-sign list appear instantly, and the visit is saved encrypted.
5. Turn the network on. The saved visit sends itself.
6. Open the doctor dashboard (`/` or `/doctor`) on a laptop. It opens light, signed in as Dr. Senthil in demo mode, with every panel folded and **Active cases** on the right (the full-screen button spreads the list over the map). Nammiyampattu has a **red pin** and appears under **Needs attention**. Tip: the phone button at the top right shows the ASHA app on the same screen, so you can send the visit from there and watch the pin drop.
7. Click the pin (or the list). The map zooms in and the side panel lists the place's cases; open one. Show the symptoms with their evidence, the photo, the voice note in English, the patient details and the WHO guidance.
8. Choose **Escalate**, pick the hospital and send; or **Medicines**, pick from the quick list, give the doses and send. The pin clears.
9. After a prescription, click **Look for medicines**. Watch the scan light up the places with stock, tick a place (or use the suggestion) and click **Send bike**. The run tracker follows the bike from stop to stop to the patient.
10. Back on the phone, the doctor's reply appears in Tamil with the original below, and *Medicines on the way* shows the bike.
With `AI_PROVIDER=mock` there is no model, so any voice note is "heard" as a fixed, clearly labelled demo transcript. Use a Gemini key for a live demo.

## Tests and evaluation

```bash
npm test               # 103 unit + API tests: rules, AI auto-fill, auth, idempotent sync, validation, audit,
                       # Gemini request shape and safety blocks, Firestore/GCS store, analytics de-identification,
                       # live-view traffic (no overlaps, no gridlock) and case and referral simulation
npm run test:e2e       # Playwright: offline photo-only visit -> encryption at rest -> auto-sync -> online
                       # voice-only visit auto-filled by AI -> doctor decision -> translated reply; the 3D live
                       # view on desktop and phone (dark scheme); fails on any CSP violation or console error
npm run eval           # 21 synthetic cases; fails on any under-triage
npm run eval -- --ai   # same cases through live Gemini; checks AI never lowers urgency (needs a key)
```

What was verified where:

- **Verified in this repository:** all of the above, run with the mock AI provider.
- **Verified against the SDK, not live:** the Gemini integration, checked against `@google/genai` request and response shapes. Run `npm run eval -- --ai` with a key to verify it live.
- **Verified against fakes, not real Google Cloud:** the Firestore and Cloud Storage store, against fakes of the client APIs. The deploy script was syntax-checked but not run from the build machine.

## Deploy to Google Cloud

From Cloud Shell, at the repository root:

```bash
PROJECT_ID=your-project ./scripts/deploy-cloudrun.sh
```

The script enables the APIs and creates:
- Firestore, the private media bucket and the BigQuery dataset;
- the Pub/Sub topic and urgent-alert subscription;
- the Cloud Healthcare FHIR R4 store;
- the guideline bucket and Vertex AI RAG Engine corpus (`scripts/rag-corpus.mjs`, PDFs listed in `deploy/guideline-pdfs.txt`);
- a least-privilege service account and Secret Manager secrets.

It then builds with Cloud Build, deploys to Cloud Run in asia-south1 and puts Firebase Hosting in front (`https://<project>.web.app`). It prints one-time demo access codes and the service URL. Gemini, Gemini Live and RAG Engine run on Vertex AI in asia-south1 with the service account, so no API key is needed.

`gemini-3.8-flash` is only served from the `global` endpoint. That's why production uses `gemini-3.5-flash`, which is served from asia-south1. Firebase Hosting can't proxy WebSockets, so the phone opens the Gemini Live socket on the Cloud Run URL directly (`LIVE_WS_URL`). Optional: `GEMMA_MODEL_URL` turns on the offline Gemma helper. Host the Gemma 3 1B web `.task` file yourself, for example in Cloud Storage.

For analytics, see [docs/bigquery-data-agent.md](docs/bigquery-data-agent.md) to create a BigQuery data agent over the de-identified `triage_events` table.

## Building with Antigravity

`.agents/skills/` holds project Agent Skills that Antigravity loads on demand:

- `aarogya-clinical-safety` covers triage, prompt and medical-wording guardrails.
- `aarogya-add-language` adds a worker language.
- `aarogya-add-guideline` adds a cited guideline entry.
- `aarogya-deploy-cloud-run` covers Google Cloud deployment.
- `aarogya-material-ui` covers the Material 3 UI conventions.

## Project structure

```
public/            ASHA PWA (index.html), doctor dashboard (live.html), classic case list (doctor.html), service worker
public/shared/     danger signs + triage rules shared by phone and server
public/js/         UI controllers, i18n (en/hi/ta), encrypted outbox, media capture
public/js/live/    live view: block layout, road network, traffic, operations simulation, Three.js scene
                   (public/js/live-queue.js connects it to the real doctor queue)
src/               Express API, Gemini provider, pipeline, guideline retrieval, stores, audit, analytics
src/guidelines/    curated, cited guideline corpus (draft)
ui/, scripts/      Material Web and Three.js bundles, theme tokens, icons, fonts, deploy, prompt export
test/, e2e/, eval/ unit/API tests, Playwright end-to-end test, safety evaluation set
.agents/skills/    Antigravity Agent Skills
```

## Limitations and roadmap

- **Next:** clinician validation of the rules and corpus, and native-speaker review of the Hindi and Tamil text.
- **Next:** live Gemini evaluation on role-played audio and photos.
- **Then:** Gemma on-device voice transcription (today Gemma reads typed notes only), push notifications from the Pub/Sub urgent-alert subscription, ABDM integration of the FHIR store, more languages and conditions, and a district pilot.

## Buildathon checklist

- [x] New product idea, built on Google AI (Gemini) and deployable on Google Cloud (Cloud Run)
- [x] Prompts prototyped for Google AI Studio; Agent Skills for Google Antigravity
- [ ] Deploy with `scripts/deploy-cloudrun.sh` and test the live URL on a phone
- [ ] Submit the prototype by **9:00 AM on Day 2** (hard deadline, no extension)
- [ ] Presentation PDF, at most 5 MB
