import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyAutofill } from '../src/autofill.js';

describe('applyAutofill', () => {
  const reported = { ageDays: 8, sex: 'female', temperatureC: 38.3, breathsPerMin: 52 };

  it('fills empty fields from what Gemini heard and marks their source', () => {
    const { patient, assessment, autofill } = applyAutofill({}, { reported });
    assert.deepEqual(patient, { ageDays: 8, sex: 'female' });
    assert.equal(assessment.temperatureC, 38.3);
    assert.equal(assessment.breathsPerMin, 52);
    assert.deepEqual(autofill, { ageDays: 'ai_voice', sex: 'ai_voice', temperatureC: 'ai_voice', breathsPerMin: 'ai_voice' });
  });

  it('never overrides what the worker entered', () => {
    const { patient, assessment, autofill } = applyAutofill({ patient: { ageDays: 12, sex: 'male' }, assessment: { temperatureC: 36.9 } }, { reported });
    assert.equal(patient.ageDays, 12);
    assert.equal(patient.sex, 'male');
    assert.equal(assessment.temperatureC, 36.9);
    assert.deepEqual(autofill, { breathsPerMin: 'ai_voice' });
  });

  it('ignores implausible extracted values', () => {
    const { patient, assessment, autofill } = applyAutofill({}, { reported: { ageDays: 8.5, sex: 'unknown', temperatureC: 98.6, breathsPerMin: -1 } });
    assert.equal(patient.ageDays, null);
    assert.equal(assessment.temperatureC, null);
    assert.equal(assessment.breathsPerMin, null);
    assert.deepEqual(autofill, {});
  });
});
