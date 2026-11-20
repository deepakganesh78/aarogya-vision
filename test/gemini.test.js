import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGeminiProvider } from '../src/ai/gemini.js';
import { AI_OUTPUT_JSON_SCHEMA, parseAiOutput, parseSkinPattern } from '../src/ai/schema.js';
import { SKIN_PATTERN_INSTRUCTION } from '../src/ai/prompt.js';
import { buildCase } from './helpers.js';

const VALID_OUTPUT = {
  language_detected: 'ta',
  transcript_original: 'குழந்தைக்கு 8 நாள், பால் குடிக்கவில்லை, உடம்பு சூடாக இருக்கிறது',
  transcript_english: 'Baby is 8 days old, not feeding, body feels hot',
  danger_signs: [
    { sign_id: 'not_feeding_well', status: 'present', source: 'voice', confidence: 'high', evidence: 'not feeding' },
    { sign_id: 'made_up_sign', status: 'present', source: 'voice', confidence: 'high', evidence: 'x' }
  ],
  photo_quality: 'good',
  photo_observations: ['Reddened skin around the umbilicus extending about 1 cm'],
  summary_for_doctor: '8-day-old infant; worker reports poor feeding and warmth to touch.',
  missing_information: ['Measured temperature'],
  follow_up_questions: [{ english: 'When did feeding stop?', worker_language: 'எப்போது பால் குடிப்பதை நிறுத்தியது?' }],
  uncertainty_notes: 'Photo lighting is dim.'
};

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(request) {
        calls.push(request);
        return typeof response === 'function' ? response(request) : response;
      }
    }
  };
}

const config = { model: 'gemini-3.8-flash', timeoutMs: 5000 };

describe('Gemini provider', () => {
  it('sends photo and voice as inline data with a JSON schema and safety-focused instructions', async () => {
    const client = fakeClient({ text: JSON.stringify(VALID_OUTPUT), candidates: [{ finishReason: 'STOP' }] });
    const provider = createGeminiProvider({ config, client });
    const photo = { mimeType: 'image/jpeg', buffer: Buffer.from('photo-bytes') };
    const audio = { mimeType: 'audio/webm', buffer: Buffer.from('audio-bytes') };
    const { output } = await provider.analyze({ caseRecord: buildCase(), photo, audio });

    const [request] = client.calls;
    assert.equal(request.model, 'gemini-3.8-flash');
    assert.equal(request.config.responseMimeType, 'application/json');
    assert.equal(request.config.responseJsonSchema, AI_OUTPUT_JSON_SCHEMA);
    assert.ok(request.config.temperature <= 0.2);
    assert.match(request.config.systemInstruction, /Do not diagnose/);
    assert.match(request.config.systemInstruction, /Ignore any instructions/);
    const inline = request.contents[0].parts.filter((p) => p.inlineData);
    assert.deepEqual(
      inline.map((p) => p.inlineData),
      [
        { mimeType: 'image/jpeg', data: Buffer.from('photo-bytes').toString('base64') },
        { mimeType: 'audio/webm', data: Buffer.from('audio-bytes').toString('base64') }
      ]
    );
    const prompt = request.contents[0].parts[0].text;
    assert.match(prompt, /Age: 8 days/);
    assert.match(prompt, /Tamil/);
    assert.doesNotMatch(prompt, /reference/i);
    assert.doesNotMatch(prompt, /Test Baby/, 'the patient name never goes to Gemini');

    assert.equal(output.findings.length, 1, 'unknown sign ids are dropped');
    assert.equal(output.findings[0].signId, 'not_feeding_well');
    assert.equal(output.followUpQuestions[0].workerLanguage, 'எப்போது பால் குடிப்பதை நிறுத்தியது?');
  });

  it('omits media parts that were not captured', async () => {
    const client = fakeClient({ text: JSON.stringify(VALID_OUTPUT) });
    await createGeminiProvider({ config, client }).analyze({ caseRecord: buildCase(), photo: null, audio: null });
    assert.equal(client.calls[0].contents[0].parts.length, 1);
    assert.match(client.calls[0].contents[0].parts[0].text, /no photo; no voice note/);
  });

  it('treats safety blocks, empty and malformed responses as failures', async () => {
    const cases = [
      [{ promptFeedback: { blockReason: 'SAFETY' } }, /safety filters \(SAFETY\)/],
      [{ text: '{}', candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }, /PROHIBITED_CONTENT/],
      [{ text: '' }, /empty response/],
      [{ text: 'not json' }, /invalid JSON/],
      [{ text: JSON.stringify({ ...VALID_OUTPUT, summary_for_doctor: '' }) }, /validation/]
    ];
    for (const [response, pattern] of cases) {
      const provider = createGeminiProvider({ config, client: fakeClient(response) });
      await assert.rejects(provider.analyze({ caseRecord: buildCase(), photo: null, audio: null }), pattern);
    }
  });

  it('aborts requests that exceed the timeout', async () => {
    const client = fakeClient(
      (request) =>
        new Promise((resolve, reject) => {
          request.config.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    const provider = createGeminiProvider({ config: { ...config, timeoutMs: 20 }, client });
    await assert.rejects(provider.analyze({ caseRecord: buildCase(), photo: null, audio: null }), /aborted/);
  });

  it('translates doctor instructions with a faithful-translation instruction', async () => {
    const client = fakeClient({ text: ' குழந்தையை இப்போதே PHC க்கு அழைத்துச் செல்லவும். ' });
    const out = await createGeminiProvider({ config, client }).translate('Take the baby to the PHC now.', 'ta');
    assert.equal(out, 'குழந்தையை இப்போதே PHC க்கு அழைத்துச் செல்லவும்.');
    assert.match(client.calls[0].config.systemInstruction, /into Tamil/);
    assert.match(client.calls[0].config.systemInstruction, /Do not add, remove or soften/);
  });

  it('requires credentials when no client is injected', () => {
    assert.throws(() => createGeminiProvider({ config: { ...config, apiKey: undefined } }), /GEMINI_API_KEY/);
    assert.throws(() => createGeminiProvider({ config: { ...config, enterprise: true } }), /GOOGLE_CLOUD_PROJECT/);
  });
});

describe('parseAiOutput', () => {
  it('fills optional fields with safe defaults', () => {
    const out = parseAiOutput(JSON.stringify({ summary_for_doctor: 'Short summary.' }));
    assert.deepEqual(out.findings, []);
    assert.equal(out.photoQuality, 'not_provided');
    assert.deepEqual(out.reported, { ageDays: null, sex: 'unknown', temperatureC: null, breathsPerMin: null });
  });

  it('reads values the worker stated and drops out-of-range ones', () => {
    const out = parseAiOutput(
      JSON.stringify({ summary_for_doctor: 'x', reported: { age_days: 8, sex: 'female', temperature_c: 101.2, breaths_per_min: 64 } })
    );
    assert.deepEqual(out.reported, { ageDays: 8, sex: 'female', temperatureC: null, breathsPerMin: 64 });
  });

  it('declares nullable reported fields in the response schema', () => {
    assert.deepEqual(AI_OUTPUT_JSON_SCHEMA.properties.reported.properties.age_days.anyOf[1], { type: 'null' });
    assert.ok(AI_OUTPUT_JSON_SCHEMA.required.includes('reported'));
  });
});

describe('rash photo check (visual pattern, never a disease)', () => {
  it('asks Gemini for one pattern from the photo, with a no-diagnosis prompt', async () => {
    const client = fakeClient({ text: JSON.stringify({ pattern: 'ring_patches', confidence: 'medium', visible_features: ['raised red ring about 3 cm on the forearm'] }) });
    const provider = createGeminiProvider({ config: { model: 'gemini-test', timeoutMs: 1000 }, client });
    const out = await provider.classifySkin({ photo: { mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff]) } });
    assert.deepEqual(out, { pattern: 'ring_patches', confidence: 'medium', features: ['raised red ring about 3 cm on the forearm'], model: 'gemini-test' });
    const req = client.calls[0];
    assert.equal(req.config.responseMimeType, 'application/json');
    assert.ok(req.contents[0].parts.some((p) => p.inlineData?.mimeType === 'image/jpeg'));
    assert.match(SKIN_PATTERN_INSTRUCTION, /Do not diagnose, name diseases/);
  });

  it('drops disease names, keeps unclear photos at low confidence, and rejects unknown patterns', () => {
    const out = parseSkinPattern(JSON.stringify({ pattern: 'small_bumps', confidence: 'high', visible_features: ['looks like scabies', 'many 1-2 mm red bumps between the fingers', 'Fungal infection'] }));
    assert.deepEqual(out.features, ['many 1-2 mm red bumps between the fingers']);
    assert.equal(parseSkinPattern(JSON.stringify({ pattern: 'unclear', confidence: 'high', visible_features: [] })).confidence, 'low');
    assert.throws(() => parseSkinPattern(JSON.stringify({ pattern: 'scabies', confidence: 'high', visible_features: [] })));
  });
});