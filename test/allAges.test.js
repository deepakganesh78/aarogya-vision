import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { SIGN_IDS, ageToDays, applicableSigns, detectSignsInText } from '../public/shared/dangerSigns.js';
import { levelRank, mergeAiFindings, triageAssessment } from '../public/shared/triage.js';
import { createGeminiProvider } from '../src/ai/gemini.js';
import { buildUserPrompt } from '../src/ai/prompt.js';
import { cleanAiOutput, noMedicine } from '../src/safety.js';

const CASES = JSON.parse(fs.readFileSync(new URL('../public/offline-test/cases.json', import.meta.url), 'utf8')).cases;

describe('all-ages rules', () => {
  for (const c of CASES) {
    it(`never under-triages: ${c.label}`, () => {
      const patient = { ...c.patient, ageDays: ageToDays(c.patient.ageValue, c.patient.ageUnit) };
      const signs = c.checklistAllNo ? Object.fromEntries(SIGN_IDS.map((id) => [id, 'no'])) : undefined;
      const r = triageAssessment({ patient, assessment: { notes: c.note, ...(signs ? { signs } : {}) } });
      assert.ok(levelRank(r.level) >= levelRank(c.expect), `${r.level} < ${c.expect}`);
    });
  }

  it('shows pregnancy signs only for pregnant women and infant signs only for young infants', () => {
    const ids = (p) => applicableSigns(p).map((s) => s.id);
    assert.ok(ids({ ageDays: 24 * 365, sex: 'female', pregnant: true }).includes('preg_bleeding'));
    assert.ok(!ids({ ageDays: 24 * 365, sex: 'female' }).includes('preg_bleeding'));
    assert.ok(!ids({ ageDays: 30 * 365, sex: 'male', pregnant: true }).includes('preg_bleeding'), 'a man is never pregnant');
    assert.ok(ids({ ageDays: 10 }).includes('not_feeding_well'));
    assert.ok(!ids({ ageDays: 10 * 365 }).includes('not_feeding_well'));
    assert.ok(ids({ ageDays: 2 * 365 }).includes('unable_to_drink'));
  });

  it('reads negation in English, Hindi and Tamil notes', () => {
    const adult = { ageDays: 30 * 365, sex: 'male' };
    assert.deepEqual(detectSignsInText('No fever.', adult), []);
    assert.deepEqual(detectSignsInText('बुखार नहीं है', adult), []);
    assert.deepEqual(detectSignsInText('காய்ச்சல் இல்லை', adult), []);
    assert.deepEqual(detectSignsInText('He has fever', adult), ['fever']);
  });

  it('lets an AI-heard sign raise a rule sign (wound + fever) but never lower the level', () => {
    const patient = { ageDays: 34 * 365, sex: 'male' };
    const base = triageAssessment({ patient, assessment: { notes: 'Wound with pus.' } });
    assert.equal(base.level, 'PRIORITY');
    const merged = mergeAiFindings(base, { status: 'done', findings: [{ signId: 'fever', status: 'present', source: 'voice', confidence: 'high', evidence: 'he is hot' }] });
    assert.equal(merged.level, 'URGENT');
    assert.equal(merged.reasons.find((r) => r.signId === 'wound_infected').level, 'URGENT');
  });
});

describe('safety filters', () => {
  it('drops AI sentences that name a condition and keeps the rest', () => {
    const { output, removed } = cleanAiOutput({
      summaryForDoctor: 'Adult with a leg wound draining pus. This is consistent with cellulitis. No fever reported.',
      photoObservations: ['Red area around the wound', 'Likely to be an abscess'],
      followUpQuestions: [{ english: 'Since when?', workerLanguage: 'x' }],
      uncertaintyNotes: ''
    });
    assert.equal(removed, 2);
    assert.equal(output.summaryForDoctor, 'Adult with a leg wound draining pus. No fever reported.');
    assert.deepEqual(output.photoObservations, ['Red area around the wound']);
  });

  it('never lets a medicine or dose reach the worker', () => {
    assert.deepEqual(noMedicine(['Go to the PHC now.', 'Give paracetamol 250 mg.', 'பாராசிட்டமால் மாத்திரை கொடுங்கள்']).kept, ['Go to the PHC now.']);
  });
});

describe('Gemini prompt and fallback', () => {
  it('never sends the patient name, but sends age, sex and pregnancy', () => {
    const prompt = buildUserPrompt(
      { language: 'ta', patient: { name: 'Anjali Devi', ageValue: 24, ageUnit: 'years', ageDays: 8760, sex: 'female', pregnant: true, pregnancyMonths: 7 }, assessment: {} },
      { hasPhoto: false, hasAudio: true }
    );
    assert.ok(!prompt.includes('Anjali'));
    assert.match(prompt, /24 years/);
    assert.match(prompt, /Pregnant: yes, 7 months/);
    assert.match(prompt, /preg_headache_vision/);
    assert.ok(!prompt.includes('not_feeding_well'), 'no young-infant signs for an adult');
  });

  it('falls back to the next model when one is overloaded', async () => {
    const calls = [];
    const client = {
      models: {
        async generateContent(req) {
          calls.push(req.model);
          if (req.model === 'busy-model') throw Object.assign(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'), { status: 503 });
          return { text: 'Translated', candidates: [{ finishReason: 'STOP' }] };
        }
      }
    };
    const provider = createGeminiProvider({ config: { model: 'busy-model, backup-model', timeoutMs: 1000 }, client });
    assert.equal(await provider.translate('Go now', 'ta'), 'Translated');
    assert.deepEqual(calls, ['busy-model', 'backup-model']);
  });

  it('moves on to the next model when one times out', async () => {
    const calls = [];
    const client = {
      models: {
        generateContent(req) {
          calls.push(req.model);
          if (req.model === 'slow-model') {
            return new Promise((resolve, reject) => req.config.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
          }
          return Promise.resolve({ text: 'Translated', candidates: [{ finishReason: 'STOP' }] });
        }
      }
    };
    const provider = createGeminiProvider({ config: { model: 'slow-model,fast-model', timeoutMs: 50 }, client });
    assert.equal(await provider.translate('Go now', 'ta'), 'Translated');
    assert.deepEqual(calls, ['slow-model', 'fast-model']);
  });

  it('does not retry on a non-temporary error', async () => {
    const client = {
      models: {
        async generateContent() {
          throw Object.assign(new Error('API key not valid'), { status: 400 });
        }
      }
    };
    const provider = createGeminiProvider({ config: { model: 'a,b', timeoutMs: 1000 }, client });
    await assert.rejects(provider.translate('x', 'ta'), /API key not valid/);
  });
});
