import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SIGN_IDS } from '../public/shared/dangerSigns.js';
import { describeReason, mergeAiFindings, triageAssessment } from '../public/shared/triage.js';

function allNo(overrides = {}) {
  return Object.fromEntries(SIGN_IDS.map((id) => [id, overrides[id] ?? 'no']));
}

function triage({ ageDays = 10, signs = allNo(), temperatureC = null, breathsPerMin = null } = {}) {
  return triageAssessment({ patient: { ageDays }, assessment: { signs, temperatureC, breathsPerMin } });
}

describe('triageAssessment', () => {
  it('is ROUTINE when every sign was checked and is absent', () => {
    const result = triage();
    assert.equal(result.level, 'ROUTINE');
    assert.deepEqual(result.reasons, []);
  });

  it('is URGENT for any very-severe-disease sign on the checklist', () => {
    for (const id of ['not_feeding_well', 'convulsions', 'severe_chest_indrawing', 'low_movement', 'umbilical_redness_spreading', 'many_skin_pustules', 'severe_jaundice']) {
      assert.equal(triage({ signs: allNo({ [id]: 'yes' }) }).level, 'URGENT', id);
    }
  });

  it('applies temperature thresholds at 37.5 °C and 35.5 °C', () => {
    assert.equal(triage({ temperatureC: 37.5 }).level, 'URGENT');
    assert.equal(triage({ temperatureC: 37.4 }).level, 'ROUTINE');
    assert.equal(triage({ temperatureC: 35.4 }).level, 'URGENT');
    assert.equal(triage({ temperatureC: 35.5 }).level, 'ROUTINE');
  });

  it('lets a measured fever override a checklist "no"', () => {
    const result = triage({ signs: allNo({ fever: 'no' }), temperatureC: 38.2 });
    assert.equal(result.level, 'URGENT');
    assert.deepEqual(result.reasons[0], { code: 'sign', signId: 'fever', level: 'URGENT', source: 'vitals', value: 38.2, verify: false });
  });

  it('keeps a checklist "feels hot" even when the measured temperature is normal', () => {
    assert.equal(triage({ signs: allNo({ fever: 'yes' }), temperatureC: 36.8 }).level, 'URGENT');
  });

  it('flags fast breathing at 60 breaths per minute', () => {
    assert.equal(triage({ breathsPerMin: 60 }).level, 'URGENT');
    assert.equal(triage({ breathsPerMin: 59 }).level, 'ROUTINE');
  });

  it('treats unchecked required signs as an incomplete assessment needing review', () => {
    const signs = allNo({ convulsions: 'unknown', fever: 'unknown' });
    const result = triage({ signs });
    assert.equal(result.level, 'PRIORITY');
    assert.deepEqual(result.incomplete, ['convulsions', 'fever']);
  });

  it('uses measured vitals to complete unchecked temperature and breathing items', () => {
    const signs = allNo({ fever: 'unknown', low_temperature: 'unknown', fast_breathing: 'unknown' });
    assert.equal(triage({ signs, temperatureC: 36.9, breathsPerMin: 44 }).level, 'ROUTINE');
  });

  it('treats any jaundice on day 0 as severe', () => {
    assert.equal(triage({ ageDays: 0, signs: allNo({ jaundice: 'yes' }) }).level, 'URGENT');
    assert.equal(triage({ ageDays: 5, signs: allNo({ jaundice: 'yes' }) }).level, 'PRIORITY');
  });

  it('marks infants older than 59 days as out of scope', () => {
    const result = triage({ ageDays: 75 });
    assert.equal(result.level, 'PRIORITY');
    assert.equal(result.reasons[0].code, 'out_of_scope_age');
  });

  it('treats local infection signs as same-day review', () => {
    assert.equal(triage({ signs: allNo({ umbilicus_red_or_pus: 'yes' }) }).level, 'PRIORITY');
  });
});

describe('mergeAiFindings', () => {
  const done = (findings) => ({ status: 'done', findings });

  it('never lowers the rules-based level', () => {
    const base = triage({ signs: allNo({ convulsions: 'yes' }) });
    const merged = mergeAiFindings(base, done([{ signId: 'convulsions', status: 'absent', source: 'voice', confidence: 'high' }]));
    assert.equal(merged.level, 'URGENT');
  });

  it('raises to URGENT for a confident danger sign heard in the voice note', () => {
    const merged = mergeAiFindings(triage(), done([{ signId: 'not_feeding_well', status: 'present', source: 'voice', confidence: 'high', evidence: 'not feeding' }]));
    assert.equal(merged.level, 'URGENT');
    const reason = merged.reasons.find((r) => r.code === 'ai_sign');
    assert.equal(reason.verify, true);
    assert.equal(reason.conflict, true);
  });

  it('caps photo-only and low-confidence AI findings at PRIORITY', () => {
    const photo = mergeAiFindings(triage(), done([{ signId: 'umbilical_redness_spreading', status: 'present', source: 'photo', confidence: 'high' }]));
    assert.equal(photo.level, 'PRIORITY');
    const low = mergeAiFindings(triage(), done([{ signId: 'convulsions', status: 'present', source: 'voice', confidence: 'low' }]));
    assert.equal(low.level, 'PRIORITY');
  });

  it('asks for human review of unanalysed media when AI is unavailable', () => {
    assert.equal(mergeAiFindings(triage(), { status: 'failed' }, { hasMedia: true }).level, 'PRIORITY');
    assert.equal(mergeAiFindings(triage(), { status: 'disabled' }, { hasMedia: false }).level, 'ROUTINE');
  });

  it('is idempotent when re-merged', () => {
    const once = mergeAiFindings(triage(), done([{ signId: 'fever', status: 'present', source: 'voice', confidence: 'medium' }]));
    const twice = mergeAiFindings(once, done([{ signId: 'fever', status: 'present', source: 'voice', confidence: 'medium' }]));
    assert.equal(twice.reasons.filter((r) => r.code === 'ai_sign').length, 1);
  });

  it('fills the sign table from the voice note without ever going below the rules level', () => {
    const unknownAll = triageAssessment({ patient: { ageDays: 10 }, assessment: {} });
    assert.equal(unknownAll.level, 'PRIORITY');
    const absences = SIGN_IDS.map((id) => ({ signId: id, status: 'absent', source: 'voice', confidence: 'high', evidence: 'stated' }));
    const merged = mergeAiFindings(unknownAll, done(absences));
    assert.equal(merged.level, 'PRIORITY', 'AI-stated absences cannot make a case routine');
    assert.deepEqual(merged.incomplete, []);
    assert.equal(merged.signs.convulsions.state, 'no');
    assert.equal(merged.signs.convulsions.source, 'ai_voice');
    assert.ok(merged.reasons.some((r) => r.code === 'ai_completed_assessment'));

    const lowConfidence = mergeAiFindings(unknownAll, done([{ signId: 'convulsions', status: 'absent', source: 'voice', confidence: 'medium' }]));
    assert.equal(lowConfidence.signs.convulsions.state, 'unknown', 'only high-confidence absences count');
  });
});

describe('worker flag and voice-stated vitals', () => {
  it('treats the one-tap "I see a danger sign" switch as urgent', () => {
    const result = triageAssessment({ patient: {}, assessment: { workerFlag: true } });
    assert.equal(result.level, 'URGENT');
    assert.equal(result.reasons[0].code, 'worker_flag');
  });

  it('labels vitals that Gemini extracted from the voice note', () => {
    const result = triageAssessment({ patient: { ageDays: 8 }, assessment: { temperatureC: 38.3 }, autofill: { temperatureC: 'ai_voice' } });
    const reason = result.reasons.find((r) => r.signId === 'fever');
    assert.equal(reason.source, 'voice_vitals');
    assert.match(describeReason(reason, 'en'), /said in voice note: 38.3 °C/);
  });
});

describe('describeReason', () => {
  it('renders reasons in each supported language', () => {
    const reason = { code: 'sign', signId: 'fever', level: 'URGENT', source: 'vitals', value: 38.1 };
    assert.match(describeReason(reason, 'en'), /measured: 38.1 °C/);
    assert.match(describeReason(reason, 'hi'), /बुखार/);
    assert.match(describeReason(reason, 'ta'), /காய்ச்சல்/);
  });
});
