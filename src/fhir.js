import fs from 'node:fs/promises';
import path from 'node:path';
import { signLabel } from '../public/shared/dangerSigns.js';
import { describeReason } from '../public/shared/triage.js';

// Each case as a FHIR R4 transaction Bundle (Patient, Consent, Encounter, Practitioner, Flag,
// Observations, Media) for ABDM readiness. Saved locally under DATA_DIR/fhir; the Cloud Healthcare API
// FHIR store is the production target.
const PRIORITY = { URGENT: 'stat', PRIORITY: 'asap', ROUTINE: 'routine' };
const BASE = 'https://aarogya-vision.example';

export function buildFhirBundle(record, { asha } = {}) {
  const u = (r) => `urn:uuid:${record.id}-${r}`;
  const p = record.patient || {};
  const triage = record.triage || { level: 'PRIORITY', reasons: [], signs: {} };
  const ctx = { subject: { reference: u('patient') }, encounter: { reference: u('encounter') } };
  const present = Object.entries(triage.signs || {}).filter(([, s]) => s.state === 'yes');

  const entries = [
    {
      fullUrl: u('patient'),
      resource: {
        resourceType: 'Patient',
        identifier: [{ system: `${BASE}/patient`, value: p.id || record.id }],
        name: p.name ? [{ text: p.name }] : undefined,
        gender: { male: 'male', female: 'female' }[p.sex] || 'unknown',
        address: asha ? [{ text: [asha.village, asha.block, asha.district, asha.state].filter(Boolean).join(', '), country: 'IN' }] : undefined,
        extension: p.ageValue != null ? [{ url: `${BASE}/fhir/age-at-encounter`, valueQuantity: { value: Number(p.ageValue), unit: p.ageUnit } }] : undefined
      }
    },
    {
      fullUrl: u('consent'),
      resource: {
        resourceType: 'Consent',
        status: record.consent?.given ? 'active' : 'rejected',
        scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }] },
        category: [{ text: 'DPDP Act 2023: verbal consent to share photo and voice note with the doctor' }],
        policyRule: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'OPTIN' }], text: 'Digital Personal Data Protection Act 2023 (India)' },
        patient: { reference: u('patient') },
        dateTime: record.consent?.at
      }
    },
    {
      fullUrl: u('encounter'),
      resource: {
        resourceType: 'Encounter',
        status: record.decision ? 'finished' : 'triaged',
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'FLD', display: 'field' },
        priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActPriority', code: PRIORITY[triage.level] }], text: triage.level },
        subject: { reference: u('patient') },
        period: { start: record.capturedAt },
        participant: [{ type: [{ text: 'ASHA worker (intake)' }], individual: { reference: u('asha') } }]
      }
    },
    {
      fullUrl: u('asha'),
      resource: {
        resourceType: 'Practitioner',
        identifier: [{ system: `${BASE}/asha`, value: record.worker.id }],
        name: [{ text: asha?.name || record.worker.name }],
        qualification: [{ code: { text: 'Accredited Social Health Activist (ASHA)' } }]
      }
    },
    {
      fullUrl: u('flag'),
      resource: {
        resourceType: 'Flag',
        status: 'active',
        code: { text: `Triage ${triage.level}: ${triage.reasons.map((r) => describeReason(r)).join('; ')}` },
        ...ctx
      }
    },
    ...(p.pregnant
      ? [
          {
            fullUrl: u('pregnancy'),
            resource: {
              resourceType: 'Observation',
              status: 'final',
              code: { coding: [{ system: 'http://loinc.org', code: '82810-3', display: 'Pregnancy status' }] },
              valueCodeableConcept: { text: p.pregnancyMonths ? `Pregnant, ${p.pregnancyMonths} months` : 'Pregnant' },
              ...ctx
            }
          }
        ]
      : []),
    ...present.map(([id, s], i) => ({
      fullUrl: u(`sign-${i}`),
      resource: {
        resourceType: 'Observation',
        status: s.source === 'ai_voice' || s.source === 'ai_photo' ? 'preliminary' : 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey' }] }],
        code: { text: signLabel(id) },
        valueBoolean: true,
        note: [{ text: `Source: ${s.source}` }],
        ...ctx
      }
    })),
    ...(record.ai?.output?.summaryForDoctor
      ? [
          {
            fullUrl: u('summary'),
            resource: {
              resourceType: 'Observation',
              status: 'preliminary',
              code: { text: 'AI-assisted intake summary (not a diagnosis)' },
              valueString: record.ai.output.summaryForDoctor,
              note: (record.guidelines || []).map((g) => ({ text: `Cited: ${g.title} (${g.source.publisher})` })),
              ...ctx
            }
          }
        ]
      : []),
    ...['photo', 'audio']
      .filter((k) => record.media?.[k])
      .map((k) => ({
        fullUrl: u(`media-${k}`),
        resource: {
          resourceType: 'Media',
          status: 'completed',
          type: { text: k },
          content: { contentType: record.media[k].mimeType, url: `/api/doctor/cases/${record.id}/media/${k}` },
          ...ctx
        }
      }))
  ];

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: entries.map((e) => ({ ...e, request: { method: 'POST', url: e.resource.resourceType } }))
  };
}

/** Save the bundle as DATA_DIR/fhir/<case id>.json (local stand-in for the Cloud Healthcare API). */
export async function saveFhirBundle(dataDir, record, asha) {
  const dir = path.join(dataDir, 'fhir');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  await fs.writeFile(file, JSON.stringify(buildFhirBundle(record, { asha }), null, 2), 'utf8');
  return file;
}
