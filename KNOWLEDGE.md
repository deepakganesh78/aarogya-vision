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

1. **ASHA phone (Material 3 web app, works offline):** two big buttons, **Take photo** and **Speak** (English, Hindi or Tamil). There is one consent switch and an optional **I see a danger sign** switch. *Type instead* is available. There is no form.
2. **Send:** the visit is encrypted on the phone (AES-GCM, non-extractable key, IndexedDB) and sent. Offline, it is queued and sends itself later.
3. **Gemini reads and fills:** age, sex, temperature, breath count, and danger signs present or absent. It also returns a transcript, an English translation and follow-up questions. No diagnosis.
4. **Rules decide urgency:** WHO / MoHFW young-infant danger signs. AI findings can only raise the level.
5. **Phone shows the result:** the urgency level, then **What we understood**, with each value tagged *from voice* or *from photo*. Offline, the phone shows a "refer now if you see any of these" list instead; the danger switch gives *Urgent: refer now* instantly.
6. **Doctor console (Material 3 list-detail):** urgent cases first, the photo and voice note, a labelled AI summary, every AI-filled value tagged with its source, and cited guidelines. The doctor records the decision.
7. **Reply:** machine-translated into the worker's language by Gemini, with the doctor's original text shown.

### Google stack

| Need | Google service | Code |
|---|---|---|
| Multimodal reading and field filling | Gemini (`gemini-3.8-flash` default) via Vertex AI in production, API key in dev; `responseJsonSchema` structured output | `src/ai/` |
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

## 10. Verification status

**Verified locally (mock AI):**

- **Unit and API tests:** 55, covering:
  - rules, auto-fill, auth and roles, idempotent sync, validation, the audit trail (no health content);
  - Gemini request shape, safety blocks and timeouts;
  - the Firestore and Cloud Storage store against API fakes;
  - analytics de-identification.
- **Playwright end-to-end tests:** 2, covering:
  - an offline photo-only visit with the danger switch, encryption at rest, then auto-sync;
  - an online voice-only visit auto-filled by AI, with "What we understood" in Tamil;
  - the doctor decision, then the translated reply on the phone;
  - dark mode, and zero CSP or console errors.
- **Safety evaluation:** 21 synthetic cases, zero under-triage.

**Not yet verified:**

- **Live Gemini:** checked only against SDK request and response shapes. Run `npm run eval -- --ai` with a key.
- **Real Google Cloud:** the deploy script is syntax-checked only; Firestore and GCS were tested against fakes.

## 11. Runbook

```bash
npm install
cp .env.example .env              # AI_PROVIDER=mock works with no keys
npm run dev                       # http://localhost:8080 (ASHA: asha-demo) and /doctor (doctor-demo)
npm test && npm run test:e2e && npm run eval
npm run eval -- --ai              # with GEMINI_API_KEY: live Gemini safety check
npm run prompt:export             # AI Studio prompt pack in docs/ai-studio/
PROJECT_ID=your-project ./scripts/deploy-cloudrun.sh   # from Cloud Shell
```

**Three-minute demo:**

1. Sign in on a phone and switch to Tamil.
2. **New visit**, then **Speak**: "Baby girl, 8 days old, not feeding since morning, feels hot, temperature 38.3, no fits." Turn on consent and send.
3. Show *Urgent* and **What we understood**, with each value tagged *from voice*.
4. Turn the network off. Send a photo-only visit with the danger switch on: urgent advice appears instantly.
5. Turn the network on: it auto-syncs.
6. In the doctor console, show the tagged AI values and the WHO citation, then send *Refer now*.
7. On the phone, the Tamil reply appears with the original below.

## 12. Open items and roadmap

**Before submission (9:00 AM on Day 2):**

- [ ] Deploy to Cloud Run with `scripts/deploy-cloudrun.sh`. Confirm `gemini-3.8-flash` is available in asia-south1, or set `VERTEX_LOCATION`.
- [ ] Live Gemini test with role-played audio (`npm run eval -- --ai`) and a phone demo.
- [ ] Update the deck: simplified UX, safety design, Google stack, demo screenshots. PDF at most 5 MB.
- [ ] Add dated citations for the deck's statistics.

**After the buildathon:**

- Clinician sign-off on the rules and corpus; native-speaker review of Hindi and Tamil.
- Gemma on-device for offline transcription and field filling.
- Gemini Live for spoken follow-up questions.
- Pub/Sub push alerts for urgent cases.
- FHIR R4 through the Cloud Healthcare API for ABDM.
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
