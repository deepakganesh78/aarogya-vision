import { z } from 'zod';
import { SIGN_IDS } from '../../public/shared/dangerSigns.js';
import { SKIN_PATTERN_IDS } from '../../public/shared/skinPatterns.js';

export const PROMPT_VERSION = 'intake-v4-skin-pattern';

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

// JSON Schema sent to Gemini as responseJsonSchema.
export const AI_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reported: {
      type: 'object',
      description: 'Values the worker explicitly states in the voice note or notes. Use null when not stated. Never estimate.',
      properties: {
        age_days: nullable({ type: 'integer', minimum: 0, maximum: 43800, description: 'Age in days (convert: 1 week = 7 days, 1 month = 30 days, 1 year = 365 days).' }),
        sex: { type: 'string', enum: ['female', 'male', 'unknown'] },
        temperature_c: nullable({ type: 'number', minimum: 25, maximum: 45, description: 'Measured temperature in °C (convert °F).' }),
        breaths_per_min: nullable({ type: 'integer', minimum: 0, maximum: 200 })
      },
      required: ['age_days', 'sex', 'temperature_c', 'breaths_per_min']
    },
    language_detected: { type: 'string', description: 'ISO 639-1 code of the spoken language, or "none" if there is no voice note.' },
    transcript_original: { type: 'string', description: 'Verbatim transcript in the original language and script. Empty string if no voice note.' },
    transcript_english: { type: 'string', description: 'Faithful English translation of the transcript. Empty string if no voice note.' },
    danger_signs: {
      type: 'array',
      description: 'Only signs with explicit evidence in the voice note or photo.',
      items: {
        type: 'object',
        properties: {
          sign_id: { type: 'string', enum: SIGN_IDS },
          status: { type: 'string', enum: ['present', 'absent'] },
          source: { type: 'string', enum: ['voice', 'photo'] },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          evidence: { type: 'string', description: 'Short quote (translated to English) or neutral visual description supporting the status.' }
        },
        required: ['sign_id', 'status', 'source', 'confidence', 'evidence']
      }
    },
    photo_quality: { type: 'string', enum: ['good', 'poor', 'unusable', 'not_provided'] },
    photo_observations: { type: 'array', items: { type: 'string' }, description: 'Neutral descriptions of what is visible. No diagnoses.' },
    summary_for_doctor: { type: 'string', description: '3 to 5 factual, non-diagnostic sentences in English.' },
    missing_information: { type: 'array', items: { type: 'string' } },
    follow_up_questions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          english: { type: 'string' },
          worker_language: { type: 'string' }
        },
        required: ['english', 'worker_language']
      }
    },
    uncertainty_notes: { type: 'string' }
  },
  required: [
    'reported',
    'language_detected',
    'transcript_original',
    'transcript_english',
    'danger_signs',
    'photo_quality',
    'photo_observations',
    'summary_for_doctor',
    'missing_information',
    'follow_up_questions',
    'uncertainty_notes'
  ]
};

const Finding = z.object({
  sign_id: z.string(),
  status: z.enum(['present', 'absent']),
  source: z.enum(['voice', 'photo']),
  confidence: z.enum(['low', 'medium', 'high']),
  evidence: z.string().max(500).default('')
});

const Reported = z
  .object({
    age_days: z.number().int().min(0).max(43800).nullable().catch(null).default(null),
    sex: z.enum(['female', 'male', 'unknown']).catch('unknown').default('unknown'),
    temperature_c: z.number().min(25).max(45).nullable().catch(null).default(null),
    breaths_per_min: z.number().int().min(0).max(200).nullable().catch(null).default(null)
  })
  .default({ age_days: null, sex: 'unknown', temperature_c: null, breaths_per_min: null });

const AiOutput = z.object({
  reported: Reported,
  language_detected: z.string().max(20).default('none'),
  transcript_original: z.string().max(10_000).default(''),
  transcript_english: z.string().max(10_000).default(''),
  danger_signs: z.array(Finding).max(40).default([]),
  photo_quality: z.enum(['good', 'poor', 'unusable', 'not_provided']).default('not_provided'),
  photo_observations: z.array(z.string().max(500)).max(10).default([]),
  summary_for_doctor: z.string().min(1).max(3000),
  missing_information: z.array(z.string().max(300)).max(10).default([]),
  follow_up_questions: z
    .array(z.object({ english: z.string().max(300), worker_language: z.string().max(600) }))
    .max(3)
    .default([]),
  uncertainty_notes: z.string().max(2000).default('')
});

/** Validate model JSON and convert to the internal shape. Unknown sign IDs are dropped. */
export function parseAiOutput(text) {
  let json;
  try {
    json = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('model returned invalid JSON');
  }
  const result = AiOutput.safeParse(json);
  if (!result.success) {
    throw new Error(`model output failed validation: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const out = result.data;
  const known = new Set(SIGN_IDS);
  return {
    reported: {
      ageDays: out.reported.age_days,
      sex: out.reported.sex,
      temperatureC: out.reported.temperature_c,
      breathsPerMin: out.reported.breaths_per_min
    },
    languageDetected: out.language_detected,
    transcriptOriginal: out.transcript_original,
    transcriptEnglish: out.transcript_english,
    findings: out.danger_signs
      .filter((f) => known.has(f.sign_id))
      .map((f) => ({ signId: f.sign_id, status: f.status, source: f.source, confidence: f.confidence, evidence: f.evidence })),
    photoQuality: out.photo_quality,
    photoObservations: out.photo_observations,
    summaryForDoctor: out.summary_for_doctor,
    missingInformation: out.missing_information,
    followUpQuestions: out.follow_up_questions.map((q) => ({ english: q.english, workerLanguage: q.worker_language })),
    uncertaintyNotes: out.uncertainty_notes
  };
}

// Rash photo check: one visual pattern, never a disease.
export const SKIN_PATTERN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', enum: SKIN_PATTERN_IDS },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    visible_features: { type: 'array', maxItems: 4, items: { type: 'string' }, description: 'Neutral visual descriptions. No disease names.' }
  },
  required: ['pattern', 'confidence', 'visible_features']
};

const SkinPatternOutput = z.object({
  pattern: z.enum(SKIN_PATTERN_IDS),
  confidence: z.enum(['low', 'medium', 'high']),
  visible_features: z.array(z.string().max(160)).max(4)
});

// Words that would turn a visual description into a diagnosis; such features are dropped.
const DISEASE_WORDS = /\b(scabies|ringworm|tinea|eczema|dermatitis|psoriasis|measles|chicken ?pox|varicella|impetigo|cellulitis|leprosy|fungal|bacterial|viral|infection|allerg|herpes|shingles|urticaria|hives|acne|diagnos)/i;

/** Parse and sanitise Gemini's rash-pattern answer. Throws on anything outside the schema. */
export function parseSkinPattern(text) {
  const out = SkinPatternOutput.parse(JSON.parse(text));
  return {
    pattern: out.pattern,
    // A guess is never shown as certain: "high" needs a clear, classifiable photo.
    confidence: ['unclear', 'not_skin'].includes(out.pattern) ? 'low' : out.confidence,
    features: out.visible_features.map((f) => f.trim()).filter((f) => f && !DISEASE_WORDS.test(f))
  };
}