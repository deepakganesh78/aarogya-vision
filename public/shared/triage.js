// Deterministic triage shared by the phone (works offline) and the server (recomputed on receipt).
// Safety design: the checklist and measured vitals set a floor; AI findings can only raise the level.

import {
  DANGER_SIGNS,
  LEVELS,
  MAX_AGE_DAYS,
  RULES_VERSION,
  THRESHOLDS,
  getSign,
  signLabel
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

/**
 * @param {{patient?: {ageDays?: number|null}, assessment?: {signs?: Record<string,string>, temperatureC?: number|null, breathsPerMin?: number|null, workerFlag?: boolean}, autofill?: Record<string,string>}} input
 *   autofill marks values Gemini extracted from the voice note (e.g. {temperatureC: 'ai_voice'}).
 */
export function triageAssessment({ patient, assessment, autofill = {} } = {}) {
  const submitted = assessment?.signs || {};
  const signs = {};
  for (const sign of DANGER_SIGNS) {
    signs[sign.id] = { state: normalizeState(submitted[sign.id]), source: 'checklist' };
  }

  const temp = toNumber(assessment?.temperatureC);
  if (temp !== null) {
    const source = autofill.temperatureC ? 'voice_vitals' : 'vitals';
    if (temp >= THRESHOLDS.feverC) signs.fever = { state: 'yes', source, value: temp };
    else if (signs.fever.state === 'unknown') signs.fever = { state: 'no', source, value: temp };
    if (temp < THRESHOLDS.lowTempC) signs.low_temperature = { state: 'yes', source, value: temp };
    else if (signs.low_temperature.state === 'unknown') signs.low_temperature = { state: 'no', source, value: temp };
  }

  const breaths = toNumber(assessment?.breathsPerMin);
  if (breaths !== null) {
    const source = autofill.breathsPerMin ? 'voice_vitals' : 'vitals';
    if (breaths >= THRESHOLDS.fastBreathingPerMin) signs.fast_breathing = { state: 'yes', source, value: breaths };
    else if (signs.fast_breathing.state === 'unknown') signs.fast_breathing = { state: 'no', source, value: breaths };
  }

  const ageDays = toNumber(patient?.ageDays);
  // Any visible jaundice on the first day of life is treated as severe.
  if (ageDays === 0 && signs.jaundice.state === 'yes' && signs.severe_jaundice.state !== 'yes') {
    signs.severe_jaundice = { state: 'yes', source: 'age_rule' };
  }

  const reasons = [];
  const incomplete = [];
  // One-tap override from the ASHA: she saw a danger sign, so refer without waiting for anything else.
  if (assessment?.workerFlag === true) reasons.push({ code: 'worker_flag', level: 'URGENT', source: 'checklist' });
  for (const sign of DANGER_SIGNS) {
    const s = signs[sign.id];
    if (s.state === 'yes') {
      reasons.push({ code: 'sign', signId: sign.id, level: sign.level, source: s.source, value: s.value ?? null, verify: false });
    } else if (s.state === 'unknown' && sign.required) {
      incomplete.push(sign.id);
    }
  }

  if (ageDays === null) {
    reasons.push({ code: 'age_missing', level: 'PRIORITY', source: 'checklist' });
  } else if (ageDays > MAX_AGE_DAYS) {
    reasons.push({ code: 'out_of_scope_age', level: 'PRIORITY', source: 'checklist', value: ageDays });
  }

  if (incomplete.length > 0) {
    reasons.push({ code: 'incomplete_assessment', level: 'PRIORITY', source: 'checklist', value: incomplete.length });
  }

  return {
    level: levelFromReasons(reasons),
    reasons,
    incomplete,
    signs,
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
  const AI_CODES = new Set(['ai_sign', 'ai_unavailable', 'incomplete_assessment', 'ai_completed_assessment']);
  const reasons = base.reasons.filter((r) => !AI_CODES.has(r.code));
  // Start from the rules-only sign table so merging is idempotent.
  const signs = {};
  for (const [id, s] of Object.entries(base.signs)) {
    signs[id] = s.source === 'ai_voice' || s.source === 'ai_photo' ? { state: 'unknown', source: 'checklist' } : { ...s };
  }

  if (!ai || ai.status !== 'done') {
    // Unreviewed photo/voice might hold danger signs the checklist missed, so a human must look soon.
    if (hasMedia) reasons.push({ code: 'ai_unavailable', level: 'PRIORITY', source: 'system' });
  } else {
    for (const finding of ai.findings || []) {
      const sign = getSign(finding.signId);
      if (!sign) continue;
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
      const level = fromVoice && confident ? sign.level : minLevel(sign.level, 'PRIORITY');
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
  }

  const incomplete = DANGER_SIGNS.filter((s) => s.required && signs[s.id].state === 'unknown').map((s) => s.id);
  if (incomplete.length > 0) {
    reasons.push({ code: 'incomplete_assessment', level: 'PRIORITY', source: 'checklist', value: incomplete.length });
  } else if (base.incomplete.length > 0) {
    // Every sign is now answered, partly from AI reading the voice note: a doctor still confirms.
    reasons.push({ code: 'ai_completed_assessment', level: 'PRIORITY', source: 'ai_voice', verify: true });
  }

  return { ...base, signs, incomplete, level: maxLevel(base.level, levelFromReasons(reasons)), reasons };
}

const TEXT = {
  en: {
    measured: 'measured',
    age_missing: 'Age not recorded',
    out_of_scope_age: 'Baby is {n} days old. This checklist covers young infants up to 59 days only; follow your usual protocol.',
    incomplete_assessment: '{n} danger sign(s) not mentioned or checked',
    ai_unavailable: 'AI summary not available: the doctor must review the photo and voice note directly',
    ai_voice: 'AI heard a possible sign in the voice note',
    ai_photo: 'AI noticed a possible sign in the photo',
    confirm: 'please confirm',
    conflict: 'checklist said no',
    stated: 'said in voice note',
    worker_flag: 'ASHA saw a danger sign',
    ai_completed_assessment: 'All danger signs answered from the voice note by AI: doctor to confirm'
  },
  hi: {
    measured: 'मापा गया',
    age_missing: 'उम्र दर्ज नहीं है',
    out_of_scope_age: 'शिशु {n} दिन का है। यह सूची केवल 59 दिन तक के शिशुओं के लिए है; अपने सामान्य प्रोटोकॉल का पालन करें।',
    incomplete_assessment: '{n} खतरे के लक्षणों के बारे में बताया या जाँचा नहीं गया',
    ai_unavailable: 'AI सारांश उपलब्ध नहीं है: डॉक्टर को फ़ोटो और आवाज़ संदेश स्वयं देखना होगा',
    ai_voice: 'AI ने आवाज़ संदेश में संभावित लक्षण सुना',
    ai_photo: 'AI ने फ़ोटो में संभावित लक्षण देखा',
    confirm: 'कृपया पुष्टि करें',
    conflict: 'सूची में "नहीं" चुना था',
    stated: 'आवाज़ संदेश में बताया',
    worker_flag: 'आशा ने खतरे का लक्षण देखा',
    ai_completed_assessment: 'AI ने आवाज़ संदेश से सभी खतरे के लक्षणों के जवाब भरे: डॉक्टर पुष्टि करेंगे'
  },
  ta: {
    measured: 'அளவிடப்பட்டது',
    age_missing: 'வயது பதிவு செய்யப்படவில்லை',
    out_of_scope_age: 'குழந்தைக்கு {n} நாட்கள். இந்தப் பட்டியல் 59 நாட்கள் வரையிலான குழந்தைகளுக்கு மட்டுமே; உங்கள் வழக்கமான நடைமுறையைப் பின்பற்றவும்.',
    incomplete_assessment: '{n} அபாய அறிகுறி(கள்) பற்றிச் சொல்லப்படவில்லை அல்லது சரிபார்க்கப்படவில்லை',
    ai_unavailable: 'AI சுருக்கம் கிடைக்கவில்லை: மருத்துவர் புகைப்படத்தையும் குரல் பதிவையும் நேரடியாகப் பார்க்க வேண்டும்',
    ai_voice: 'குரல் பதிவில் சாத்தியமான அறிகுறியை AI கேட்டது',
    ai_photo: 'புகைப்படத்தில் சாத்தியமான அறிகுறியை AI கண்டது',
    confirm: 'உறுதிப்படுத்தவும்',
    conflict: 'பட்டியலில் "இல்லை" எனக் குறிக்கப்பட்டது',
    stated: 'குரல் பதிவில் சொன்னது',
    worker_flag: 'ஆஷா அபாய அறிகுறியைக் கண்டார்',
    ai_completed_assessment: 'எல்லா அபாய அறிகுறிகளுக்கும் குரல் பதிவிலிருந்து AI பதில் நிரப்பியது: மருத்துவர் உறுதிப்படுத்துவார்'
  }
};

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

export function describeReason(reason, lang = 'en') {
  const t = TEXT[lang] || TEXT.en;
  switch (reason.code) {
    case 'sign': {
      const label = signLabel(reason.signId, lang);
      if ((reason.source === 'vitals' || reason.source === 'voice_vitals') && reason.value !== null) {
        const unit = reason.signId === 'fast_breathing' ? '/min' : ' °C';
        return `${label} (${reason.source === 'vitals' ? t.measured : t.stated}: ${reason.value}${unit})`;
      }
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
