import { PROMPT_VERSION, parseAiOutput } from './schema.js';

// Deterministic stand-in for local demos and tests. It makes no model call and labels its output
// as MOCK so it can never be mistaken for real AI analysis. Without typed notes it "hears" a fixed
// demo transcript when a voice note is attached.
export const MOCK_DEMO_TRANSCRIPT = 'Baby girl, 8 days old. Not feeding since morning and feels hot, temperature 38.3. Red skin around the navel. No fits.';

const PRESENT = [
  { signId: 'not_feeding_well', words: ['not feeding', 'not sucking', 'stopped feeding', 'not drinking'] },
  { signId: 'convulsions', words: ['having fits', 'had fits', 'convulsion', 'seizure'] },
  { signId: 'fever', words: ['feels hot', 'fever', 'very hot'] },
  { signId: 'low_temperature', words: ['feels cold', 'very cold'] },
  { signId: 'low_movement', words: ['not moving', 'very sleepy', 'floppy'] },
  { signId: 'jaundice', words: ['yellow'] }
];

const ABSENT = [
  { signId: 'not_feeding_well', words: ['feeding well'] },
  { signId: 'convulsions', words: ['no fits', 'no convulsion'] },
  { signId: 'fast_breathing', words: ['breathing normal', 'breathing is normal', 'breathing fine'] },
  { signId: 'low_movement', words: ['moving well', 'very active'] }
];

function extractReported(text) {
  const lower = text.toLowerCase();
  const days = lower.match(/(\d{1,3})\s*-?\s*days?\b/);
  const weeks = lower.match(/(\d{1,2})\s*-?\s*weeks?\b/);
  const temp = lower.match(/temperature\s*(?:is\s*)?(\d{2}(?:\.\d)?)/) || lower.match(/(\d{2}\.\d)\s*(?:°|degrees)/);
  const breaths = lower.match(/(\d{2,3})\s*breaths/);
  return {
    age_days: days ? Number(days[1]) : weeks ? Number(weeks[1]) * 7 : null,
    sex: /\b(girl|daughter|female)\b/.test(lower) ? 'female' : /\b(boy|son|male)\b/.test(lower) ? 'male' : 'unknown',
    temperature_c: temp ? Number(temp[1]) : null,
    breaths_per_min: breaths ? Number(breaths[1]) : null
  };
}

export function createMockProvider() {
  async function analyze({ caseRecord, photo, audio }) {
    const typed = caseRecord.assessment?.notes || '';
    const heard = typed || (audio ? MOCK_DEMO_TRANSCRIPT : '');
    const lower = heard.toLowerCase();
    // Typed notes and the voice note are both the worker's own report.
    const source = 'voice';

    const danger_signs = [];
    if (heard) {
      for (const { signId, words } of PRESENT) {
        const hit = words.find((w) => lower.includes(w));
        if (hit) danger_signs.push({ sign_id: signId, status: 'present', source, confidence: 'high', evidence: `"${hit}"` });
      }
      for (const { signId, words } of ABSENT) {
        const hit = words.find((w) => lower.includes(w));
        if (hit && !danger_signs.some((d) => d.sign_id === signId)) {
          danger_signs.push({ sign_id: signId, status: 'absent', source, confidence: 'high', evidence: `"${hit}"` });
        }
      }
    }
    if (photo && /(navel|umbilic)/.test(lower) && lower.includes('red')) {
      danger_signs.push({
        sign_id: 'umbilical_redness_spreading',
        status: 'present',
        source: 'photo',
        confidence: 'low',
        evidence: 'Reddened skin visible around the umbilicus (mock observation)'
      });
    }

    const reported = extractReported(heard);
    const output = {
      reported,
      language_detected: audio ? caseRecord.language : 'none',
      transcript_original: heard ? `[MOCK transcript] ${heard}` : '',
      transcript_english: heard ? `[MOCK translation] ${heard}` : '',
      danger_signs,
      photo_quality: photo ? 'good' : 'not_provided',
      photo_observations: photo ? ['[MOCK] Photo received; no real image analysis was performed.'] : [],
      summary_for_doctor: `[MOCK AI - no model was called] ${reported.age_days != null ? `${reported.age_days}-day-old infant` : 'Infant of unstated age'} seen at a home visit. Worker said: ${(heard || 'nothing').replace(/\.$/, '')}.`,
      missing_information: reported.temperature_c == null ? ['Measured axillary temperature'] : [],
      follow_up_questions: [{ english: 'Since when has this been happening?', worker_language: '[MOCK] Since when has this been happening?' }],
      uncertainty_notes: 'Mock provider output for demos and tests only.'
    };
    const raw = JSON.stringify(output);
    return { raw, output: parseAiOutput(raw) };
  }

  async function translate(text, lang) {
    return `[MOCK ${lang} translation] ${text}`;
  }

  return { name: 'mock', model: 'mock', promptVersion: PROMPT_VERSION, analyze, translate };
}
