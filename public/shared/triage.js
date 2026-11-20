// Deterministic triage shared by the phone (works offline) and the server (recomputed on receipt).
// Safety design: the checklist, measured vitals and the worker's own typed note set a floor;
// AI findings can only raise the level.

import {
  DANGER_SIGNS,
  LEVELS,
  RULES_VERSION,
  THRESHOLDS,
  detectSignsInText,
  getSign,
  isRequired,
  patientContext,
  signApplies,
  signLabel,
  signLevel
} from './dangerSigns.js';

export function levelRank(level) {
  return LEVELS.indexOf(level);
}

export function maxLevel(a, b) {
  if (!a) return b;
  if (!b) return a;
  return levelRank(a) >= levelRank(b) ? a : b;
}

function minLevel(a, b) {
  return levelRank(a) <= levelRank(b) ? a : b;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeState(value) {
  return value === 'yes' || value === 'no' ? value : 'unknown';
}

function levelFromReasons(reasons) {
  return reasons.reduce((acc, r) => maxLevel(acc, r.level), 'ROUTINE');
}

const SIGN_CODES = new Set(['sign', 'ai_sign']);
const isAiSource = (source) => source === 'ai_voice' || source === 'ai_photo';

/** Rule reasons for every present, non-AI sign. Levels depend on the patient and other signs (wound + fever). */
function signReasons(signs, ctx) {
  const isYes = (id) => signs[id]?.state === 'yes';
  const reasons = [];
  for (const sign of DANGER_SIGNS) {
    const s = signs[sign.id];
    if (!s || s.state !== 'yes' || isAiSource(s.source) || !signApplies(sign, ctx)) continue;
    reasons.push({ code: 'sign', signId: sign.id, level: signLevel(sign, ctx, isYes), source: s.source, value: s.value ?? null, verify: false });
  }
  return reasons;
}

/**
 * @param {{patient?: {ageDays?: number|null, sex?: string, pregnant?: boolean}, assessment?: {signs?: Record<string,string>, temperatureC?: number|null, breathsPerMin?: number|null, notes?: string, workerFlag?: boolean}, autofill?: Record<string,string>}} input
 *   autofill marks values Gemini extracted from the voice note (e.g. {temperatureC: 'ai_voice'}).
 */
export function triageAssessment({ patient, assessment, autofill = {} } = {}) {
  const ctx = patientContext(patient);
  const submitted = assessment?.signs || {};
  const signs = {};
  for (const sign of DANGER_SIGNS) {
    signs[sign.id] = { state: normalizeState(submitted[sign.id]), source: 'checklist' };
  }

  // The worker's own typed note counts like the checklist (negation-aware keyword match).
  for (const id of detectSignsInText(assessment?.notes, patient)) {
    if (signs[id].state === 'unknown') signs[id] = { state: 'yes', source: 'notes' };
  }
  // So do her own spoken words, as written down live while she spoke (in her language and in English).
  const live = assessment?.liveTranscript;
  if (live) {
    for (const id of detectSignsInText(`${live.original || ''} . ${live.english || ''}`, patient)) {
      if (signs[id].state === 'unknown') signs[id] = { state: 'yes', source: 'live_voice' };
    }
  }

  const temp = toNumber(assessment?.temperatureC);
  if (temp !== null) {
    const source = autofill.temperatureC ? 'voice_vitals' : 'vitals';
    if (temp >= THRESHOLDS.feverC) signs.fever = { state: 'yes', source, value: temp };
    else if (signs.fever.state === 'unknown') signs.fever = { state: 'no', source, value: temp };
    if (ctx.youngInfant) {
      if (temp < THRESHOLDS.lowTempC) signs.low_temperature = { state: 'yes', source, value: temp };
      else if (signs.low_temperature.state === 'unknown') signs.low_temperature = { state: 'no', source, value: temp };
    }
  }

  const breaths = toNumber(assessment?.breathsPerMin);
  if (breaths !== null && ctx.youngInfant) {
    const source = autofill.breathsPerMin ? 'voice_vitals' : 'vitals';
    if (breaths >= THRESHOLDS.fastBreathingPerMin) signs.fast_breathing = { state: 'yes', source, value: breaths };
    else if (signs.fast_breathing.state === 'unknown') signs.fast_breathing = { state: 'no', source, value: breaths };
  }

  // Any visible jaundice on the first day of life is treated as severe.
  if (ctx.ageDays === 0 && signs.jaundice.state === 'yes' && signs.severe_jaundice.state !== 'yes') {
    signs.severe_jaundice = { state: 'yes', source: 'age_rule' };
  }

  const reasons = [];
  // One-tap override from the ASHA: she saw a danger sign, so refer without waiting for anything else.
  if (assessment?.workerFlag === true) reasons.push({ code: 'worker_flag', level: 'URGENT', source: 'checklist' });
  reasons.push(...signReasons(signs, ctx));
  const incomplete = DANGER_SIGNS.filter((s) => isRequired(s, ctx) && signs[s.id].state === 'unknown').map((s) => s.id);

  if (ctx.ageDays === null) reasons.push({ code: 'age_missing', level: 'PRIORITY', source: 'checklist' });
  if (incomplete.length > 0) {
    reasons.push({ code: 'incomplete_assessment', level: 'PRIORITY', source: 'checklist', value: incomplete.length });
  }
  // Older patients have no full checklist: never auto-clear a case where no sign was recognised.
  if (!ctx.youngInfant && !reasons.some((r) => SIGN_CODES.has(r.code) || r.code === 'worker_flag')) {
    reasons.push({ code: 'no_sign_recognised', level: 'PRIORITY', source: 'system' });
  }

  return {
    level: levelFromReasons(reasons),
    reasons,
    incomplete,
    signs,
    context: { youngInfant: ctx.youngInfant, under5: ctx.under5, pregnant: ctx.pregnant, ageDays: ctx.ageDays },
    rulesVersion: RULES_VERSION
  };
}

/**
 * Merge AI findings into a rules-based triage result. The result is never lower than `base.level`.
 * Findings also fill the sign table for display: "present" marks a sign yes, a confident explicit
 * "absent" from the worker's own voice marks it no. Neither can bring the level below the base.
 * @param {ReturnType<typeof triageAssessment>} base
 * @param {{status: string, findings?: Array<{signId: string, status: string, source: string, confidence: string, evidence?: string}>} | null} ai
 * @param {{hasMedia?: boolean}} [options]
 */
export function mergeAiFindings(base, ai, { hasMedia = false } = {}) {
  const ctx = { youngInfant: true, under5: false, pregnant: false, ageDays: null, ...(base.context || {}) };
  const AI_CODES = new Set(['ai_sign', 'ai_unavailable', 'incomplete_assessment', 'ai_completed_assessment', 'no_sign_recognised']);
  const reasons = base.reasons.filter((r) => !AI_CODES.has(r.code)).map((r) => ({ ...r }));
  // Start from the rules-only sign table so merging is idempotent.
  const signs = {};
  for (const [id, s] of Object.entries(base.signs)) {
    signs[id] = isAiSource(s.source) ? { state: 'unknown', source: 'checklist' } : { ...s };
  }

  if (!ai || ai.status !== 'done') {
    // Unreviewed photo/voice might hold danger signs the checklist missed, so a human must look soon.
    if (hasMedia) reasons.push({ code: 'ai_unavailable', level: 'PRIORITY', source: 'system' });
  } else {
    const isYes = (id) => signs[id]?.state === 'yes';
    for (const finding of ai.findings || []) {
      const sign = getSign(finding.signId);
      if (!sign || !signApplies(sign, ctx)) continue;
      const fromVoice = finding.source === 'voice';
      const current = signs[sign.id];
      if (finding.status === 'absent') {
        if (current.state === 'unknown' && fromVoice && finding.confidence === 'high') {
          signs[sign.id] = { state: 'no', source: 'ai_voice', evidence: finding.evidence || '' };
        }
        continue;
      }
      if (finding.status !== 'present' || current.state === 'yes') continue;
      const confident = finding.confidence === 'high' || finding.confidence === 'medium';
      // The worker's own spoken report is trusted like the checklist; AI image interpretation is capped.
      const full = signLevel(sign, ctx, isYes);
      const level = fromVoice && confident ? full : minLevel(full, 'PRIORITY');
      reasons.push({
        code: 'ai_sign',
        signId: sign.id,
        level,
        source: fromVoice ? 'ai_voice' : 'ai_photo',
        confidence: finding.confidence,
        evidence: finding.evidence || '',
        conflict: current.state === 'no',
        verify: true
      });
      if (current.state === 'unknown') signs[sign.id] = { state: 'yes', source: fromVoice ? 'ai_voice' : 'ai_photo', evidence: finding.evidence || '' };
    }
    // A sign the AI heard can make a rule sign more serious (wound + fever): raise, never lower.
    const fresh = new Map(signReasons(signs, ctx).map((r) => [r.signId, r.level]));
    for (const r of reasons) if (r.code === 'sign' && fresh.has(r.signId)) r.level = maxLevel(r.level, fresh.get(r.signId));
  }

  const incomplete = DANGER_SIGNS.filter((s) => isRequired(s, ctx) && signs[s.id].state === 'unknown').map((s) => s.id);
  if (incomplete.length > 0) {
    reasons.push({ code: 'incomplete_assessment', level: 'PRIORITY', source: 'checklist', value: incomplete.length });
  } else if (base.incomplete.length > 0) {
    // Every sign is now answered, partly from AI reading the voice note: a doctor still confirms.
    reasons.push({ code: 'ai_completed_assessment', level: 'PRIORITY', source: 'ai_voice', verify: true });
  }
  if (!ctx.youngInfant && !reasons.some((r) => SIGN_CODES.has(r.code) || r.code === 'worker_flag')) {
    reasons.push({ code: 'no_sign_recognised', level: 'PRIORITY', source: 'system' });
  }

  return { ...base, signs, incomplete, level: maxLevel(base.level, levelFromReasons(reasons)), reasons };
}

const TEXT = {
  en: {
    measured: 'measured',
    age_missing: 'Age not recorded',
    out_of_scope_age: 'Patient is {n} days old.',
    incomplete_assessment: '{n} danger sign(s) not mentioned or checked',
    no_sign_recognised: 'No specific danger sign recognised: doctor to review',
    ai_unavailable: 'AI summary not available: the doctor must review the photo and voice note directly',
    ai_voice: 'AI heard a possible sign in the voice note',
    ai_photo: 'AI noticed a possible sign in the photo',
    confirm: 'please confirm',
    conflict: 'checklist said no',
    stated: 'said in voice note',
    from_note: 'from your note',
    from_live: 'from your voice, live text',
    worker_flag: 'ASHA saw a danger sign',
    ai_completed_assessment: 'All danger signs answered from the voice note by AI: doctor to confirm'
  },
  hi: {
    measured: 'मापा गया',
    age_missing: 'उम्र दर्ज नहीं है',
    out_of_scope_age: 'मरीज़ {n} दिन का है।',
    incomplete_assessment: '{n} खतरे के लक्षणों के बारे में बताया या जाँचा नहीं गया',
    no_sign_recognised: 'कोई खास खतरे का लक्षण नहीं पहचाना गया: डॉक्टर देखेंगे',
    ai_unavailable: 'AI सारांश उपलब्ध नहीं है: डॉक्टर को फ़ोटो और आवाज़ संदेश स्वयं देखना होगा',
    ai_voice: 'AI ने आवाज़ संदेश में संभावित लक्षण सुना',
    ai_photo: 'AI ने फ़ोटो में संभावित लक्षण देखा',
    confirm: 'कृपया पुष्टि करें',
    conflict: 'सूची में "नहीं" चुना था',
    stated: 'आवाज़ संदेश में बताया',
    from_note: 'आपकी टिप्पणी से',
    from_live: 'आपकी आवाज़ से, लाइव लिखावट',
    worker_flag: 'आशा ने खतरे का लक्षण देखा',
    ai_completed_assessment: 'AI ने आवाज़ संदेश से सभी खतरे के लक्षणों के जवाब भरे: डॉक्टर पुष्टि करेंगे'
  },
  ta: {
    measured: 'அளவிடப்பட்டது',
    age_missing: 'வயது பதிவு செய்யப்படவில்லை',
    out_of_scope_age: 'நோயாளிக்கு {n} நாட்கள்.',
    incomplete_assessment: '{n} அபாய அறிகுறி(கள்) பற்றிச் சொல்லப்படவில்லை அல்லது சரிபார்க்கப்படவில்லை',
    no_sign_recognised: 'குறிப்பிட்ட அபாய அறிகுறி எதுவும் கண்டறியப்படவில்லை: மருத்துவர் பார்ப்பார்',
    ai_unavailable: 'AI சுருக்கம் கிடைக்கவில்லை: மருத்துவர் புகைப்படத்தையும் குரல் பதிவையும் நேரடியாகப் பார்க்க வேண்டும்',
    ai_voice: 'குரல் பதிவில் சாத்தியமான அறிகுறியை AI கேட்டது',
    ai_photo: 'புகைப்படத்தில் சாத்தியமான அறிகுறியை AI கண்டது',
    confirm: 'உறுதிப்படுத்தவும்',
    conflict: 'பட்டியலில் "இல்லை" எனக் குறிக்கப்பட்டது',
    stated: 'குரல் பதிவில் சொன்னது',
    from_note: 'உங்கள் குறிப்பிலிருந்து',
    from_live: 'உங்கள் குரலிலிருந்து, நேரடி எழுத்து',
    worker_flag: 'ஆஷா அபாய அறிகுறியைக் கண்டார்',
    ai_completed_assessment: 'எல்லா அபாய அறிகுறிகளுக்கும் குரல் பதிவிலிருந்து AI பதில் நிரப்பியது: மருத்துவர் உறுதிப்படுத்துவார்'
  }
};

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

/** @param {{forDoctor?: boolean}} [options] the doctor console shows the source separately */
export function describeReason(reason, lang = 'en', { forDoctor = false } = {}) {
  const t = TEXT[lang] || TEXT.en;
  switch (reason.code) {
    case 'sign': {
      const label = signLabel(reason.signId, lang);
      if ((reason.source === 'vitals' || reason.source === 'voice_vitals') && reason.value !== null) {
        const unit = reason.signId === 'fast_breathing' ? '/min' : ' °C';
        return `${label} (${reason.source === 'vitals' ? t.measured : t.stated}: ${reason.value}${unit})`;
      }
      if (reason.source === 'notes' && !forDoctor) return `${label} (${t.from_note})`;
      if (reason.source === 'live_voice' && !forDoctor) return `${label} (${t.from_live})`;
      return label;
    }
    case 'ai_sign': {
      const prefix = reason.source === 'ai_voice' ? t.ai_voice : t.ai_photo;
      const extra = reason.conflict ? `; ${t.conflict}` : '';
      return `${prefix}: ${signLabel(reason.signId, lang)} (${t.confirm}${extra})`;
    }
    case 'out_of_scope_age':
    case 'incomplete_assessment':
      return fill(t[reason.code], { n: reason.value });
    default:
      return t[reason.code] || reason.code;
  }
}
