# Aarogya-Vision: project knowledge base

Everything learned and decided while preparing Aarogya-Vision for the **Google DeepMind × Google Cloud Startup Buildathon India 2026**: the problem, the buildathon rules from the Day 0 session, Google's policies, the design decisions, what was built and verified, and what is left to do.

> Prototype for demonstration with synthetic or role-play cases only. Not for clinical use.

## Contents

1. [Team and pitch](#1-team-and-pitch)
2. [The problem statement (from our deck)](#2-the-problem-statement-from-our-deck)
3. [Critical review of the idea](#3-critical-review-of-the-idea)
4. [Buildathon Day 0 session: key information and action points](#4-buildathon-day-0-session-key-information-and-action-points)
5. [Google rules and policies that shape the design](#5-google-rules-and-policies-that-shape-the-design)
6. [What we built](#6-what-we-built)
7. [Design decisions and why](#7-design-decisions-and-why)
8. [Clinical content](#8-clinical-content)
9. [Bugs found and fixed during the build](#9-bugs-found-and-fixed-during-the-build)
10. [Verification status](#10-verification-status)
11. [Runbook](#11-runbook)
12. [Open items and roadmap](#12-open-items-and-roadmap)
13. [References](#13-references)

---

## 1. Team and pitch

- **Team:** Aarogya-Vision, 2 members: Naveen Roshan and Deepak Ganesh.
- **Focus:** AI health intake for rural clinics.
- **One line:** rural health workers can't show doctors what they see, so serious cases reach doctors late and unclear. Aarogya-Vision turns a photo and a voice note from an ASHA worker into a doctor-ready, guideline-cited case, with urgent newborns flagged first.
- **Deck submission rules (from the deck's first slide):** PDF format only, maximum 5 MB.

## 2. The problem statement (from our deck)

**Headline:** rural health workers can't show the doctor what they see.

Context figures used in the deck (they still need precise, dated citations before the pitch; the deck attributes the specialist figure to MoHFW Rural Health Statistics):

- about 65% of Indians live in rural areas, while most doctors work in cities;
- 1M+ ASHA workers are a village's first health contact, with no support at the patient's side;
- about 80% of specialist posts at rural health centres are unfilled.

**How a case reaches a doctor today:** the ASHA sees a rash or wound, describes it by phone or on paper (the photo is lost), the doctor guesses from words (no structure), and the referral is late (danger signs missed).

**Deck's proposed solution:** "a photo + a voice note → a doctor-ready case in seconds":

1. Capture: the ASHA takes a photo and speaks in her own language.
2. Understand: Gemini reads the photo and voice together.
3. Check: matched to official MoHFW / ICMR guidelines, with sources.
4. Act: urgency flag and next steps to the ASHA, full case to the doctor.

The deck also promised: safety (no diagnosis, no prescriptions, the doctor decides) and offline use (an on-phone model flags danger signs).

**Deck architecture:** phone (ASHA app, Gemma offline check, Gemini Live) → AI agent on Cloud Run (read photo + voice with Gemini API, RAG on MoHFW/ICMR PDFs, flag urgency, build an FHIR record) → Cloud Healthcare API, Storage + Firestore, Pub/Sub alerts, Firebase doctor dashboard. Data in India, encrypted, DPDP consent, every AI answer logged, serverless.

**Deck model choice:** Gemini API for every case (Flash for routine, Pro for complex), Gemini Live for hands-free talk in Tamil and Hindi, Gemma on the phone with no network.

**Deck business:** payers are state health missions (NHM), district health offices, telemedicine networks, NGOs and CSR. Pricing is per health worker per month, or per district, plus setup and training. Market: India first (Tamil Nadu pilot), then South Asia and Africa. Roadmap: working prototype in November, guidelines plus Tamil and Hindi in months 1-2, district pilot in months 3-6, first state contract in months 6-12.

## 3. Critical review of the idea

**Verdict:** hackathon-worthy, if sharply scoped and the whole worker-to-doctor handoff is shown working. The problem is concrete, consequential and easy to demo. The risk is over-claiming.

Gaps identified, and how the build addresses them:

| Gap | Risk | How the build handles it |
|---|---|---|
| Offline vs cloud AI were not reconciled | Implies cloud AI or a doctor is available offline | Offline: encrypted capture, an instant danger-sign reminder and a one-tap danger switch; AI runs when the network returns |
| Clinical safety was only a disclaimer | Wrong "not urgent" delays care | Deterministic rules set a floor; AI can only raise urgency; the doctor decides |
| Scope too wide | Nothing done well | One scenario: young infants (0-59 days) at home visits |
| No evidence plan | Unsupported claims | 21-case synthetic safety evaluation; deck statistics need citations |
| Payer story hypothetical | Weak business case | Kept as hypotheses in the pitch |
| Privacy and operations thin | Compliance claims without substance | Consent, encryption, audit, retention, India region, de-identified analytics |

## 4. Buildathon Day 0 session: key information and action points

Source: "Startup Buildathon · Virtual Session", Hack2skill YouTube live stream, 19 November 2026 (about 88 minutes), <https://www.youtube.com/live/U7VaCBgqeTg>. Summarised from YouTube's English auto-captions, so small details may be imprecise.

### Logistics and deadlines

- **Day 1 (20 November):** reach your city venue by **8:00 AM**. Check-in, a quick context-setting session, then build. Venue details come by email; Delhi and Mumbai venue emails were still pending at session time. City events are run by HeadStart.
- **Day 2 deadline:** submit the prototype or product by **9:00 AM the next day**. This is a hard deadline with no extension. Roughly 2,000 teams across 10 cities submit at once.
- **Day 2:** mentors and jury review the builds. The jury hears the top 10-20 teams per city, and about 6-7 teams per city go to the **regional showcase**.
- The program received **25,000+ applications**.
- Mentors from Google and partners are on site both days.

### Product rules

- Build a **net-new product**. Existing products are not accepted. An existing startup may enter only with a significantly new product or a substantial new AI capability, not a small feature.
- Build with **Google AI models**, using Antigravity and AI Studio, and **deploy and scale on Google Cloud**.
- You may start building the MVP before Day 1.

### Credits, badges and subscriptions

- **Workshop Cloud credits** (QR code or link in the session and email): activate with your **personal Gmail**, the same account on phone and laptop, or the billing account won't be where you expect. The credits were described as small (about $5) and valid for about **12 hours**.
- **Google Developer Profile badges:** an applicant badge for everyone, plus a badge for shortlisted participants. Claim both from the QR codes or URLs in your email.
- **Google AI Pro (3 months):** a form arrives by email after check-in on Day 1, for higher Antigravity token limits. Don't request it if you already have AI Pro, because your existing subscription would be cancelled.
- **No Cloud credits are provided during the hackathon itself.** Top 10 teams receive Cloud credits to keep building; the speaker said "$5,000 worth of credits". Public program listings say each top-10 team gets **US$10,000: US$5,000 cash plus US$5,000 in Google AI and Cloud credits**.
- Per public listings: regional showcases in **Gurugram, Mumbai and Hyderabad**, and a **Grand Finale at Google Bengaluru on 2 December 2026**.

### Technical guidance (talk by Abirami Sukumaran, Staff Developer Advocate, Google Cloud)

- **The shift to agentic AI:** from asking questions, to analysis, to agents that plan and act.
- **Choose a model:** Gemini 4 Hydrogen, Carbon and Argon, and Gemini 3.8 Flash were mentioned. Compare them in the Google Cloud console's Model Garden and Agent Garden. A "decisions API" was mentioned for comparing choices.
- **Where to build:**
  - **AI Studio** for prototypes and low-code, single-prompt apps.
  - The **Antigravity IDE** for agent-assisted full builds. The session used this one; download the *standalone* IDE from antigravity.google/download, not the plug-in for another IDE.
  - The **Antigravity CLI** for terminal users.
  - The Antigravity SDK.
- **Lifecycle:**
  1. Plan and research (Gemini; chat or task mode).
  2. Design and architecture (for example the Stitch MCP server).
  3. Autonomous execution (the agent writes code and tests).
  4. Cloud-native deploy.
- **Agent Skills:** a `SKILL.md` with YAML front matter (`name`, `description`) under `<project>/.agents/skills/<skill-name>/`. Skills load **only when relevant** (progressive disclosure), which saves tokens and improves accuracy. You can ask Antigravity to write a skill for you. Example: a DB validator skill (snake_case table names, primary key `id`, no `DROP TABLE`).
- **Extensions:** the Google Cloud **Data Agent Kit** extension in Antigravity bundles MCP servers, tools and Google-authored skills for BigQuery, AlloyDB, Spanner, Cloud SQL, Cloud Storage, Bigtable and Spark. Install it from the Extensions view (or with the `agy` plug-in command in the CLI).
- **AlloyDB Express:** a PostgreSQL 18 instance in about 2 seconds that scales to zero, with a one-click upgrade to production.
- **BigQuery Conversational Analytics:** create a data agent with table and column descriptions and instructions, publish it, and share it via BigQuery or Data Studio. The QueryData API serves as a fallback for natural-language queries.
- **Deploy:** ask Antigravity to deploy to **Cloud Run**.
- **Codelabs:**
  - <https://codelabs.developers.google.com/getting-started-with-antigravity-skills>
  - <https://codelabs.developers.google.com/data-agents-in-agy-and-bq>

### Action checklist

- [ ] Claim the workshop credits and both badges with the same personal Gmail.
- [ ] Install the standalone Antigravity IDE and set up the environment before Day 1.
- [ ] Day 1: arrive by 8:00 AM; request AI Pro from the check-in email if eligible.
- [ ] Build with Google AI and deploy on Google Cloud.
- [ ] Submit by **9:00 AM on Day 2**.
- [ ] Pitch deck: PDF, at most 5 MB.

## 5. Google rules and policies that shape the design

- **Gemini API Additional Terms** (<https://ai.google.dev/gemini-api/terms>): "You may not use the Services in clinical practice, to provide medical advice, or in any manner that is overseen by or requires clearance or approval from a medical device regulatory agency." So the app is labelled everywhere as a prototype for synthetic cases. A field pilot would need Vertex AI under Google Cloud terms, clinical validation and a regulatory pathway (for example CDSCO software as a medical device).
- **Generative AI Prohibited Use Policy** (<https://policies.google.com/terms/generative-ai/use-policy>): it disallows automated decisions with a material detrimental impact on individual rights "without human supervision in high-risk domains", healthcare included. So the doctor decides every case, and the phone's urgent advice comes from published deterministic rules, not AI.
- **Gemini safety filters:** blocked prompts or responses (`blockReason`, or finish reasons such as SAFETY or PROHIBITED_CONTENT) are treated as failures that route the case to human review.
- **Google-only stack:** the team requirement was that only Google AI and Google services are used. No third-party AI, database, hosting, analytics, font or icon services run at runtime.

## 6. What we built

Repository: this repo. Main docs: [README.md](README.md) and [docs/architecture.svg](docs/architecture.svg).

### User flow (simplified "photo or voice" UX)

1. **ASHA phone (Material 3 web app, works offline):** two big buttons, **Take photo** and **Speak** (English, Hindi or Tamil). Patient details (name, age, sex, pregnancy) are optional and folded away; Gemini reads age and sex from the voice note. There is one consent switch and an optional **I see a danger sign** switch. The profile card shows her village, PHC and how many doctors are online: cases go to a shared queue, not a named doctor.
2. **Send:** the visit is encrypted on the phone (AES-GCM, non-extractable key, IndexedDB) and sent. Offline, it is queued and sends itself later.
3. **Gemini reads and fills:** age, sex, temperature, breath count, and danger signs present or absent. It also returns a transcript, an English translation and follow-up questions. No diagnosis.
4. **Rules decide urgency:** WHO / MoHFW young-infant danger signs. AI findings can only raise the level.
5. **Phone shows the result:** the urgency level, then **What we understood**, with each value tagged *from voice* or *from photo*. Offline, the phone shows a "refer now if you see any of these" list instead; the danger switch gives *Urgent: refer now* instantly.
6. **Doctor dashboard (the 3D block view, `/live`; `/doctor` redirects there):** the place gets a red location pin and appears under **Needs attention**. The doctor clicks it, the map zooms in, the side panel lists the place's cases, and one case opens the AI-organised view (symptoms with evidence and source, photo and what is visible, voice note in English, patient details, guidance). The doctor prescribes medicines (doctor-chosen and doctor-dosed), escalates to a larger hospital, or asks the ASHA for more, on the same screen.
7. **Reply:** machine-translated into the worker's language by Gemini, with the doctor's original text shown.

### Doctor dashboard: the 3D block view (`/live`)

The doctor dashboard. There is no separate console in the main flow: `/doctor` redirects here, and the earlier list console stays at `/doctor/classic`. The block's operations (traffic, couriers, ambulances, centre queues) are simulated in the browser; **real cases from the ASHA app** appear once a doctor signs in (top-bar chip, or a console session in the same tab).

- **World:** Jawadhu Hills block (Tiruvannamalai district), built in code with no external models. Seven hill villages sit around the block town Jamunamarathur among paddy, sugarcane, banana and groves, with a tank, a village temple, a bus stand and a school. Village names match `src/people.json`: Parvati's Nammiyampattu and Meena's Kovilur. The layout itself is invented.
- **White and red theme:** buildings are white. Health facilities (PHC Pudurnadu, PHC Melpattu, the upgraded 24x7 PHC Jamunamarathur that is the 108 base, 4 HWC sub-centres and the block drug store) are white with red trim and red signs. Homes turn **red** while a case is *urgent: refer now* (with a pulsing ring) and **yellow** while it needs a *doctor review today*. At night they glow so the colours stay readable. A legend on the map explains the colours.
- **Real cases (doctor queue):** `public/js/live-queue.js` signs in (or reuses the console's `sessionStorage` session), reads `GET /api/doctor/cases?view=open`, `/api/doctor/stats`, `/api/doctor/ashas` and `/api/profile`, and listens to the server-sent events (an open connection also counts the doctor as online for the ASHA's phone). Each open case is placed on a home in the ASHA's village (by village name, else by ASHA id). The simulation never sends an ambulance for a real case and never changes or closes it: the home clears only when the case leaves the open queue (the doctor replied).
- **Needs attention:** each place with open real cases gets a red location pin (pulsing while a case there is unopened) and a red map label; a toast announces new ones and the camera flies there if the doctor is not looking at something else. The collapsible **Needs attention** panel (left; a bottom-sheet tab on phones) lists the places, most urgent first. Pin, label, list or the village itself open the **place panel**: one card per case with patient, age, ASHA, time, the AI gist and photo or voice icons.
- **Case panel** (full height, 400px): back to the place; name, sex, age, pregnancy and case id; level and *ASHA app* tags; the AI banner (provisional while Gemini is reading, then the AI case summary with uncertainty, always labelled as AI that describes and does not diagnose); **symptoms and danger signs** from the rules with source, evidence quote and *verify*, plus signs said to be absent; the **photo** (click to enlarge) with Gemini's neutral photo observations; the **voice note in English** with the original language on request and audio that loads only on *Play*; **patient and medical details** (vitals, history, ASHA flag, sending ASHA with travel distances, received time); what is still unknown; questions to ask; cited guidance.
- **Doctor's decision** (draft clinical wording): **Medicines**: quick picks of common essential medicines (names only) and free entry; the doctor must give every dose, plus how often, days and a follow-up visit. **Escalate**: PHC Jamunamarathur (24x7), GH Polur or GMCH Tiruvannamalai, now with 108 or within 24 hours (urgent cases open on this tab). **Ask the ASHA**: prefilled with the AI's follow-up questions. A private *assessment* field holds the doctor's provisional diagnosis; it is stored with the decision but never sent to the ASHA. The dashboard writes medicines and destination into the instructions, so the ASHA gets them machine-translated with the original; `medicines` and `referTo` are also stored structured. The home and pin clear when the reply is sent.
- **Look for medicines (after a prescription):** the decided case shows **Look for medicines**. It opens a finder panel and a scan sweeps out from the patient's home. Each place that has at least one prescribed medicine lights up as the scan reaches it: green if it has all of them, amber if some. Map labels and panel rows show stock per medicine (units, *low* under 5, *out*) and road distance from the patient. Sources are the 3 PHC pharmacies, the 4 HWC sub-centres (a small share of their stock) and 3 private medical shops in the town market (Murugan Medicals, Lakshmi Pharmacy, Sakthi Medicals).
  - *Suggested pickup* is a greedy cover: the fewest places that together have every medicine, nearest first. Each medicine is then collected from the nearest chosen place that has it, and places that add nothing are shown as *not needed*.
  - The nearest free bike (`MC-01` to `MC-09`) collects. Stops at its own PHC are picked up before leaving; the others follow nearest-next. The route is drawn on the map.
  - **Send bike** saves the dispatch on the server first (`POST /api/doctor/cases/:id/dispatch`, once per case, only after a decision with medicines), then starts the run (`RX-501` onward, type *Prescription delivery*: Prescribed, Bike assigned, Collecting, Collected, On the way, Delivered).
  - Each stop pings when collected and its stock goes down. On arrival the dashboard reports `POST .../dispatch/delivered` (idempotent) and shows a toast. Other open dashboards and a reload resume on-the-way dispatches from the server (`case.dispatch` events, `dispatchStatus` in the case list).
  - Medicine names typed by the doctor map to the stock list by alias (for example *Dolo* and *Crocin* map to paracetamol); unknown names are reported as missing. **Stock, distances and bikes are simulated.** The pharmacist checks each medicine and dose before it leaves.
- **ASHA app:** an open visit shows *Medicines on the way* (bike rider, places, ETA, medicine names) and then *Delivered* with the time, in en/hi/ta (draft translations). The worker view includes names only, not internal source or bike ids.
- **Entry picker (demo):** every load of `/` or `/live` opens on a translucent overlay above the running live map, with two large liquid-glass cards: **Doctor Dashboard** (left) and **Rural Worker App** (right). Material tokens only, light and dark. The overlay is a modal dialog; the page behind is `inert` until a card is chosen, and Esc enters the dashboard. **Switch app** in the top bar (it replaced the phone button) reopens the picker. Choosing the worker app on a phone screen (760 px or less) opens `/asha?from=live` as a full page with a back arrow to the picker; on larger screens it opens as a phone frame (same-origin iframe) beside the dashboard, so a case sent from it lands on the map. Links skip the picker: `?app=doctor` (`/doctor` redirects there), `?app=worker`, `?picker=0`, or a case link `#case=<id>`.
- **Collapsible panels:** KPIs (to compact figures), legend, Needs attention, side panel, run tracker, tables and active runs each fold to their header; remembered in `localStorage`.
- **Life (simulated):** simulated cases open and close. Urgent ones dispatch a 108 ambulance from PHC Jamunamarathur; the home stays red until pickup, and the run ends at "Reached block PHC". Medicine couriers ride from the PHCs to homes and HWCs, and supply vans restock centres from the drug store. Cars, autos, buses, tractors and bullock carts obey signals in the town, take turns at village junctions, and never overlap.
- **Panels:** KPIs (open cases, patients this hour, average medicine delivery, doctors on duty), a run tracker, a detail panel (block, village, home with its case, HWC staff and stock, centre doctors, beds and stock, vehicle, run) and tables (Facilities, Cases, Runs, Fleet). Search, a village switcher, Summer, Monsoon or Festival night, day or night, and a phone layout are included.

### Google stack

| Need | Google service | Code |
|---|---|---|
| Multimodal reading and field filling | Gemini via Vertex AI in production (`gemini-3.5-flash`, served from asia-south1; `gemini-3.8-flash` is `global`-only), API key in dev; `responseJsonSchema` structured output | `src/ai/` |
| Live text while she speaks (transcription only; the model never talks back) | Gemini Live API (`gemini-3.8-live`, Vertex AI asia-south1), WebSocket relay on Cloud Run | `src/speech/geminiLive.js` |
| Offline danger-sign helper | Gemma 3 1B via Google AI Edge MediaPipe LLM Inference (WebGPU), suggestions only | `public/js/gemma-offline.js` |
| Guideline passages (RAG) | Vertex AI RAG Engine over MoHFW PDFs in Cloud Storage; supplementary to the curated citations | `src/rag.js`, `scripts/rag-corpus.mjs` |
| FHIR R4 records | Cloud Healthcare API FHIR store (PUT upserts, purged with the case) | `src/healthcare.js` |
| Urgent alerts and cross-instance live updates | Cloud Pub/Sub | `src/events.js` |
| Doctor dashboard hosting | Firebase Hosting → Cloud Run | `firebase.json` |
| Translation of the doctor's reply | Gemini | `src/ai/gemini.js` |
| Prompt testing and model choice | Google AI Studio | `docs/ai-studio/` |
| Hosting | Cloud Run (asia-south1) via Cloud Build and Artifact Registry | `Dockerfile`, `scripts/deploy-cloudrun.sh` |
| Records and media | Firestore and Cloud Storage | `src/store/gcpStore.js` |
| Secrets | Secret Manager | deploy script |
| Audit | Cloud Logging (IDs and hashes only) | `src/audit.js` |
| District analytics | BigQuery and a BigQuery data agent (de-identified) | `src/analytics.js`, `docs/bigquery-data-agent.md` |
| UI | Material 3: `@material/web`, Material Color Utilities tokens (seed `#0B57D0`, vibrant scheme, light and dark), Material Symbols, self-hosted Roboto and Noto | `ui/`, `scripts/build-ui.mjs`, `public/` |
| Agentic dev | Antigravity Agent Skills | `.agents/skills/` |

### Code map

- `public/shared/`: danger signs and triage rules, shared by the phone (offline) and the server.
- `public/js/worker-app.js`: capture, encrypted outbox, sync, the result screen and "What we understood".
- `public/js/doctor-app.js`: the review console.
- `src/pipeline.js`: read (Gemini), then auto-fill, find guideline, flag urgency, build record.
- `src/autofill.js`: fills gaps from Gemini's `reported` values, range-checked and source-tagged.
- `src/ai/prompt.js` and `src/ai/schema.js`: the non-diagnostic prompt (`intake-v2`) and the output schema.
- `src/guidelines/young-infant.json`: the curated, cited corpus (draft).
- `eval/`: the 21-case safety evaluation. `test/`: unit and API tests. `e2e/`: the Playwright loop.
- `public/live.html`, `public/js/live-app.js` and `public/js/live/`: the lead doctor live view. These cover the layout, the road network, traffic, the operations simulation (pure logic, unit-tested in `test/live.test.js`), and the Three.js world, vehicles, camera and controls.

## 7. Design decisions and why

- **One clinical scenario:** home visits for babies aged 0-59 days, which matches the ASHA home-based newborn care (HBNC) visit schedule and the deck's example (an 8-day-old with a red navel, not feeding, feeling hot).
- **Deterministic rules plus AI documentation:** rules are auditable and testable, and AI adds reading, transcription and filling. It never decides alone.
- **AI can only raise urgency:**
  - Voice findings at medium or high confidence count fully.
  - Photo-only or low-confidence findings are capped at "review today" and marked *verify*.
  - An AI failure with media present goes to human review.
- **No auto-lowering:** a voice-only case that doesn't answer every required sign is at least "Doctor review today". AI-stated absences fill the table but can't make a case routine.
- **Auto-fill only fills gaps:** it never overrides worker input, range-checks every value, and records provenance so both UIs show the source.
- **Offline honesty:** AI needs network. Offline, the phone saves encrypted and shows the danger-sign reminder; the danger switch gives instant urgent advice.
- **Consent:** one required switch; the consent time is recorded and the server rejects cases without consent.
- **Data minimisation:**
  - No names go to Gemini.
  - Re-encoding the photo strips EXIF and GPS data.
  - Audit and analytics hold IDs and hashes, never notes, transcripts or media.
  - Retention is 30 days.
- **Security:**
  - Signed role tokens and strict schemas (unknown fields rejected).
  - File-type sniffing; media served only to doctors.
  - Rate-limited login.
  - A strict CSP. Only inline *style attributes* are allowed, because Material Web's Lit needs them; scripts are `'self'`.
  - Production refuses demo access codes and the mock AI.
- **Material 3 done officially:** `@material/web` components, generated tokens, generated icon paths from Material Symbols, and fonts self-hosted, not hand-made CSS imitations.
- **Mock AI provider:** deterministic and clearly labelled MOCK, for tests and key-less demos. It is refused in production.
- **Live view built to the project rules, not the brief's single file:** the brief asked for a single-file page with Three.js from a CDN. We kept the strict CSP and the no-CDN rule. Three.js is bundled by esbuild into `public/vendor/three.js` and served from our own origin, and the code is split into tested modules. The panels are Material 3 (frosted glass from tokens). The brief's tomato-red accent became the M3 primary blue, because red means urgent here.
- **One doctor dashboard:** the doctor works on the 3D block view: see where help is needed (red pins), open the place, open the case, answer. The list console survives at `/doctor/classic` for FHIR download and filters, but it is not part of the demo flow.
- **Medicines come from the doctor, never from AI:** the AI prompt and the `noMedicine` filter still keep medicines and doses out of everything AI writes and out of the guideline steps shown to ASHAs. The doctor may prescribe: the quick list holds names only, every dose is typed by the doctor, and the decision records who prescribed. The doctor's provisional diagnosis stays in a private assessment field. Draft wording; needs clinician sign-off.
- **No named doctor:** a case goes to the shared queue; the ASHA sees how many doctors have the dashboard open (`doctorsOnline`) instead of one assigned doctor.
- **Rural, case-first live view:** the lead doctor needs to see where to act. Homes are coloured only by the level from the danger-sign rules (urgent red, review-today yellow). The doctor still makes every clinical decision, and the case wording is a draft. Shops and the school stay white.

## 8. Clinical content

Young-infant danger signs (draft wording; needs clinician sign-off, and Hindi and Tamil need native-speaker review):

| Sign | Level |
|---|---|
| Not able to feed, or stopped feeding well | URGENT |
| Convulsions | URGENT |
| Fast breathing: 60 or more breaths per minute | URGENT |
| Severe chest indrawing | URGENT |
| Fever: 37.5 °C or above, or feels hot | URGENT |
| Low temperature: below 35.5 °C, or feels cold | URGENT |
| Moves only when stimulated, or not at all | URGENT |
| Redness around the navel spreading to the skin | URGENT |
| 10 or more skin pustules, or a big boil | URGENT |
| Yellow palms and soles, or yellow skin in the first 24 hours | URGENT |
| Navel red or draining pus (not spreading) | PRIORITY |
| A few skin pustules | PRIORITY |
| Yellow eyes or skin (palms and soles not yellow) | PRIORITY |

Other rules:

- Measured or stated temperature and breath counts override a "no".
- Any jaundice on day 0 counts as severe.
- Babies older than 59 days are out of scope and go to review.
- The ASHA danger switch is always URGENT.

Sources (paraphrased in the corpus):

- WHO, *Management of the sick young infant aged up to 2 months: IMCI chart booklet* (2019).
- MoHFW, *IMNCI chart booklet*.
- MoHFW, *Home Based Newborn Care operational guidelines* (2014).

Worker guidance for an urgent case: refer to the nearest facility now, following HBNC referral steps; keep the baby warm (skin-to-skin); keep breastfeeding if the baby can feed; arrange transport (102/108); don't wait for the doctor's reply.

## 9. Bugs found and fixed during the build

| Bug | Cause | Fix |
|---|---|---|
| "Record" or "Take photo" submitted the form early | Material Web buttons default to `type="submit"` inside a `<form>` | `type="button"` on non-submit buttons; the capture screen no longer uses a form |
| Consent stayed on for the next family's visit | `md-switch` binds `?checked` as an attribute, so once toggled, `selected = false` doesn't reset it | Replace the switch elements for every new visit (`resetSwitch`) |
| An online send showed "saved offline" | A background sync already in progress returned without the new visit | Chain onto in-flight syncs, and check the outbox |
| The offline message pushed the app-bar actions off-screen | Long status text in the top app bar | Short status pill (icon-only on narrow phones) and a separate offline banner |
| CSP blocked Material styles | Lit applies some styles via style attributes | Allow only `style-src-attr 'unsafe-inline'` |
| Stray "null" text in cards | DOM `append(null)` renders "null" | `setChildren` / `appendChildren` filter out nulls |
| Washed-out theme | Tonal-spot scheme desaturated Google Blue | Vibrant scheme (primary `#0056D2`) |
| Live view: a car clipped a slow bullock cart turning a village corner | A vehicle could follow a leader from the same approach into the junction while the leader was still turning | Follow into the box only behind a vehicle going straight; a turning leader must clear first |
| Doctor dashboard: the demo phone stayed blank | The CSP had `frame-ancestors 'none'` | `frame-ancestors 'self'` (and `frame-src 'self'`): only our own pages may frame the app |
| Doctor dashboard: CSP console errors for `blob:` media | Chrome re-reads object URLs it made through `connect-src` | Load audio only on *Play*, and allow `blob:` in `connect-src` (object URLs are created by our own page) |
| Live view: urgent homes piled up waiting for an ambulance | Returning vehicles held the block PHC's gate kerb for their whole drive back | Wait at a staging kerb one junction before the gate; cap open simulated urgent cases at 3 |

## 10. Verification status

**Verified locally (mock AI):**

- **Unit and API tests:** 103 (after merging the patient register, SQLite and all-ages work), covering:
  - rules, auto-fill, auth and roles, idempotent sync, validation, the audit trail (no health content);
  - Gemini request shape, safety blocks and timeouts;
  - the Firestore and Cloud Storage store against API fakes;
  - analytics de-identification;
  - the live view: no vehicle overlaps or gridlock, the urgent-case cap, referrals that reach the block PHC, real cases mirrored into the ASHA's village and never closed or escalated by the simulation, the medicine finder (name matching, a suggested round that covers the prescription, a two-stop bike run that collects every stop in order and lowers stock), and the `/live` page under the strict CSP;
  - the dispatch API: doctor-only, only after a prescription, once per case, shown to the ASHA, delivery idempotent.
- **Playwright end-to-end tests:** 7, covering:
  - an offline photo-only visit with the danger switch, encryption at rest, then auto-sync;
  - an online voice-only visit auto-filled by AI, with "What we understood" in Tamil;
  - the doctor decision, then the translated reply on the phone;
  - the 3D live view on desktop (cases table, home detail, village search, night), with the real doctor queue (a case sent by Parvati appears in Nammiyampattu without a refresh), and on a phone in the dark scheme;
  - prescribe, **Look for medicines** (scan, places with stock on the map and in the panel, suggested round), **Send bike** (the RX run is tracked and the ASHA's case shows the medicines on the way);
  - dark mode, and zero CSP or console errors.
- **Safety evaluation:** 21 synthetic cases, zero under-triage.

**Not yet verified:**

- **Live Gemini:** checked only against SDK request and response shapes. Run `npm run eval -- --ai` with a key.
- **Real Google Cloud:** the deploy script is syntax-checked only; Firestore and GCS were tested against fakes.

- **Demo auto sign-in:** `POST /api/login/auto {role}` issues a session for the first ASHA or doctor account with no code. `AUTO_LOGIN` defaults to on outside production and off in production unless `AUTO_LOGIN=true`. The ASHA app, the 3D dashboard and the classic console use it on load and when a session expires; `/api/config` reports `autoLogin`. Playwright runs with `AUTO_LOGIN=false` to keep testing the code screens.
- **Local Vertex AI (live Tamil to English):** a gitignored `.env` with `AI_PROVIDER=gemini`, `GOOGLE_GENAI_USE_ENTERPRISE=true`, `GOOGLE_CLOUD_PROJECT=arogya-515308`, `GEMINI_MODEL=gemini-3.5-flash`, `SPEECH_PROVIDER=gemini-live`, `LIVE_MODEL=gemini-3.8-live` (asia-south1) runs on the `gcloud` Application Default Credentials, with no API key. Verified on 20 Nov 2026: Tamil speech gave a live Tamil transcript, a Tamil follow-up question and the English 'The baby is eight days old. Has not drunk milk since morning. The body is hot. There are red rashes on the hand.', and the doctor's case showed the same English with the urgent level.

- **Rash photo check (ASHA phone only, draft):** right after the worker takes a photo, `POST /api/worker/photo-check` (worker only) asks Gemini vision which *visual pattern* it shows, never a disease. The patterns are ring-shaped patches, small bumps or lines, blisters or pus spots, red swollen area, dry scaly patches, many red spots, yellow skin, wound or burn, other, unclear and not skin (`public/shared/skinPatterns.js`, en/hi/ta). The card lists the matching danger signs to check and points to the "I see a danger sign" switch. The photo and the result are not stored, the result never reaches the case, the dashboard or the urgency level, and the parser drops any disease word. Offline, it says the doctor will still see the photo. Verified live on 20 Nov 2026 with CDC/Wikimedia test photos: ringworm gave ring-shaped patches, impetigo gave blisters or pus spots, and measles gave many red spots, all with high confidence. A drawing was classed as "not skin". Prompt `intake-v4-skin-pattern`.
- **Dashboard first start:** light theme on first open (night only from the URL or a saved choice, `av_live_theme`). Every panel is folded except the right panel (`av_live_collapsed_v2`). The right panel's main view is **Active cases**: ASHA-app cases grouped by place (cards with the AI gist, click to open), then simulated home-visit cases, with the block overview in a fold. The full-screen button (or Esc to return) spreads Active cases, and any case opened from it, over the map. Choosing a table tab opens the tables.
- **Live events behind Firebase Hosting:** Hosting buffers server-sent events, so `/api/config` returns `eventsUrl` (the Cloud Run URL taken from `LIVE_WS_URL`). Both doctor UIs open the event stream there; CORS allows only `https://<project>.web.app` and `.firebaseapp.com`.
- **Login limiter:** counts failed sign-ins only (10 per 5 minutes per IP). Successful and automatic sign-ins never lock anyone out.
- **Deployed (20 Nov 2026):** Cloud Run `aarogya-vision` revision `00005` in asia-south1 with `AUTO_LOGIN=true`, behind Firebase Hosting at https://arogya-515308.web.app. Checked live:
  - auto sign-in for both roles;
  - Tamil speech through Gemini Live: a word-for-word Tamil transcript, a Tamil follow-up question, and English ("My son is six years old. For two weeks, there are circular red patches on the hand. It itches a lot. There is no fever.");
  - a voice and photo visit analysed by `gemini-3.5-flash`, with an English transcript, a doctor summary, 3 guidelines and the Review today level;
  - the rash photo check;
  - the dashboard with "Live queue", Active cases and full screen.

## 11. Runbook

```bash
npm install
cp .env.example .env              # AI_PROVIDER=mock works with no keys
npm run dev                       # http://localhost:8080 = 3D dashboard (doctor-demo); /asha = ASHA app (asha-demo); /doctor/classic
npm test && npm run test:e2e && npm run eval
npm run eval -- --ai              # with GEMINI_API_KEY: live Gemini safety check
npm run prompt:export             # AI Studio prompt pack in docs/ai-studio/
PROJECT_ID=your-project ./scripts/deploy-cloudrun.sh   # from Cloud Shell
```

**Three-minute demo:**

1. Open `/asha` on a phone (auto signed in as Parvati in demo mode) and switch to Tamil.
2. **New visit**, then **Speak**: "Baby girl, 8 days old, not feeding since morning, feels hot, temperature 38.3, no fits." Turn on consent and send.
3. Show *Urgent* and **What we understood**, with each value tagged *from voice*.
4. Turn the network off. Send a photo-only visit with the danger switch on: urgent advice appears instantly.
5. Turn the network on: it auto-syncs.
6. Open `/`, choose **Doctor Dashboard** on the entry picker; demo mode signs in as Dr. Senthil. Nammiyampattu has a red pin and is listed under **Needs attention** (or choose **Rural Worker App** from **Switch app** and send the visit from the phone and watch the pin drop).
7. Click it, open the case: symptoms with evidence, photo, voice note in English, patient details, guidance. Choose **Escalate** (or **Medicines** with doses) and send; the pin clears.
8. After a prescription: **Look for medicines**, watch the scan, tick a place, **Send bike**, and follow the bike.
9. On the phone, the Tamil reply appears with the original below, plus *Medicines on the way*.

## 12. Open items and roadmap

**Before submission (9:00 AM on Day 2):**

- [ ] Deploy to Cloud Run with `scripts/deploy-cloudrun.sh`. Confirm `gemini-3.8-flash` is available in asia-south1, or set `VERTEX_LOCATION`.
- [ ] Live Gemini test with role-played audio (`npm run eval -- --ai`) and a phone demo.
- [ ] Update the deck: simplified UX, safety design, Google stack, demo screenshots. PDF at most 5 MB.
- [ ] Add dated citations for the deck's statistics.

**After the buildathon:**

- Clinician sign-off on the rules and corpus; native-speaker review of Hindi and Tamil.
- Gemma on-device voice transcription and field filling (today it only suggests signs from typed notes).
- Push notifications to doctors from the Pub/Sub urgent-alert subscription.
- ABDM integration of the Cloud Healthcare FHIR store.
- More languages and conditions; a district pilot; a regulatory pathway.

## 13. References

- Session recording: <https://www.youtube.com/live/U7VaCBgqeTg>
- Program page: <https://hack2skill.com/event/startupbuildathon2026>
- Antigravity Skills codelab: <https://codelabs.developers.google.com/getting-started-with-antigravity-skills>
- Data agents in Antigravity and BigQuery codelab: <https://codelabs.developers.google.com/data-agents-in-agy-and-bq>
- Gemini API Additional Terms: <https://ai.google.dev/gemini-api/terms>
- Generative AI Prohibited Use Policy: <https://policies.google.com/terms/generative-ai/use-policy>
- WHO young-infant IMCI chart booklet (2019): <https://www.who.int/publications/i/item/9789241516365>
- Material Web: <https://github.com/material-components/material-web>
