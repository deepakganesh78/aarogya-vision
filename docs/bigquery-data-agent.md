# District analytics with a BigQuery data agent

This follows the session's codelab ("Chat With Your Data using BigQuery Agents & Antigravity IDE"). It gives a district health officer a conversational view of **de-identified** triage data.

## What is exported

When `BIGQUERY_DATASET` is set, the server streams one row per triage result and one per doctor decision into `triage_events` (schema: `deploy/bigquery-schema.json`). Rows contain:

- keyed-HMAC pseudonyms for the case and the ASHA (no names or raw IDs)
- age band (`0-6d`, `7-27d`, `28-59d`, `60d+`), worker language
- urgency level, danger-sign IDs, whether AI raised the level, photo and voice flags
- doctor outcome and minutes from receipt to decision

They never contain notes, transcripts, photos, audio, initials or the doctor's instructions. `test/analytics.test.js` checks this.

## Create the data agent

1. In the Google Cloud console, open **BigQuery** and then **Agents** (Conversational Analytics). Grant yourself the *Gemini Data Analytics Data Agent Owner* role if asked.
2. Create an agent:
   - **Name:** District newborn triage agent
   - **Description:** Answers questions about de-identified home-visit triage events for young infants.
   - **Data:** `aarogya_analytics.triage_events`
   - Accept the suggested table and column descriptions, then edit them to match the schema descriptions.
3. Paste these **instructions**:
   ```text
   You answer questions about de-identified triage events from ASHA home visits for infants aged 0-59 days.
   Report counts, rates and trends only. Never try to identify a patient or a worker.
   Do not report any group with fewer than 5 cases; say "fewer than 5" instead.
   "Urgent" means level = 'URGENT'. Time to decision is minutes_to_decision on rows where event = 'decided'.
   This is prototype data from synthetic cases. Say so when presenting results.
   ```
4. Try:
   - "How many urgent cases were there this week, by age band?"
   - "What is the median time from receipt to doctor decision for urgent cases?"
   - "Which danger signs appear most often?"
   - "How often did the AI raise the urgency above the checklist?"
5. Publish the agent and share it from BigQuery or Data Studio with the district team. Access follows the project's IAM permissions.

From the Antigravity IDE, the Google Cloud **Data Agent Kit** extension can query the same dataset directly while you build.
