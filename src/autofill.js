// Fill case fields from what Gemini heard in the voice note. Anything the worker entered herself wins;
// AI only fills gaps, with range checks, and every filled field is marked so both UIs can show its source.

function inRange(value, min, max, integer = false) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}

/**
 * @param {{patient?: object, assessment?: object}} submitted  what the worker sent
 * @param {{reported?: {ageDays?: number|null, sex?: string, temperatureC?: number|null, breathsPerMin?: number|null}} | null} aiOutput
 */
export function applyAutofill(submitted = {}, aiOutput = null) {
  const sp = submitted.patient || {};
  const sa = submitted.assessment || {};
  // Keep everything the worker entered about the patient (name, age, pregnancy) as it is.
  const patient = { ...sp, ageDays: sp.ageDays ?? null, sex: sp.sex || 'unknown' };
  const assessment = {
    signs: { ...(sa.signs || {}) },
    temperatureC: sa.temperatureC ?? null,
    breathsPerMin: sa.breathsPerMin ?? null,
    ...(sa.notes ? { notes: sa.notes } : {}),
    ...(sa.liveTranscript ? { liveTranscript: sa.liveTranscript } : {}),
    ...(sa.workerFlag ? { workerFlag: true } : {})
  };
  const autofill = {};
  const r = aiOutput?.reported;
  if (r) {
    if (patient.ageDays === null && inRange(r.ageDays, 0, 43800, true)) {
      patient.ageDays = r.ageDays;
      autofill.ageDays = 'ai_voice';
    }
    if (patient.sex === 'unknown' && (r.sex === 'female' || r.sex === 'male')) {
      patient.sex = r.sex;
      autofill.sex = 'ai_voice';
    }
    if (assessment.temperatureC === null && inRange(r.temperatureC, 25, 45)) {
      assessment.temperatureC = r.temperatureC;
      autofill.temperatureC = 'ai_voice';
    }
    if (assessment.breathsPerMin === null && inRange(r.breathsPerMin, 0, 200, true)) {
      assessment.breathsPerMin = r.breathsPerMin;
      autofill.breathsPerMin = 'ai_voice';
    }
  }
  return { patient, assessment, autofill };
}
