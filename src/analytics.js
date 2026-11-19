import crypto from 'node:crypto';
import { levelRank, triageAssessment } from '../public/shared/triage.js';

// De-identified triage analytics for district health officers, streamed to BigQuery and explored with a
// BigQuery data agent (Conversational Analytics). Rows hold no names, notes, transcripts, photos or audio:
// IDs are keyed-HMAC pseudonyms, age is banded, danger signs are IDs only.

export function ageBand(days) {
  if (days === null || days === undefined) return 'unknown';
  if (days < 7) return '0-6d';
  if (days < 28) return '7-27d';
  if (days <= 59) return '28-59d';
  return '60d+';
}

function signsPresent(triage) {
  return [...new Set((triage?.reasons || []).filter((r) => r.signId).map((r) => r.signId))].sort();
}

export function createAnalytics({ table, salt, logger = console } = {}) {
  if (!table) {
    return { enabled: false, triaged: async () => {}, decided: async () => {} };
  }
  if (!salt) throw new Error('ANALYTICS_SALT is required when BigQuery analytics is enabled');
  const pseudonym = (id) => crypto.createHmac('sha256', salt).update(String(id)).digest('hex').slice(0, 20);

  function baseRow(record, event) {
    return {
      event,
      event_at: new Date().toISOString(),
      case_key: pseudonym(record.id),
      worker_key: pseudonym(record.worker.id),
      age_band: ageBand(record.patient?.ageDays),
      language: record.language,
      level: record.triage.level,
      signs_present: signsPresent(record.triage),
      ai_status: record.ai?.status || 'pending',
      ai_raised_level: levelRank(record.triage.level) > levelRank(triageAssessment(record).level),
      has_photo: Boolean(record.media?.photo),
      has_audio: Boolean(record.media?.audio),
      outcome: null,
      minutes_to_decision: null,
      rules_version: record.triage.rulesVersion
    };
  }

  // Analytics must never block or break a clinical workflow, so failures are logged and swallowed.
  async function insert(row) {
    try {
      await table.insert([row]);
    } catch (err) {
      logger.error(`analytics insert failed: ${err.message}`);
    }
  }

  return {
    enabled: true,
    triaged: (record) => insert(baseRow(record, 'triaged')),
    decided: (record) =>
      insert({
        ...baseRow(record, 'decided'),
        outcome: record.decision?.outcome || null,
        minutes_to_decision: record.decision ? Math.round(((Date.parse(record.decision.at) - Date.parse(record.receivedAt)) / 60000) * 10) / 10 : null
      })
  };
}

export async function createBigQueryTable({ projectId, dataset, table }) {
  const { BigQuery } = await import('@google-cloud/bigquery');
  return new BigQuery({ projectId }).dataset(dataset).table(table);
}
