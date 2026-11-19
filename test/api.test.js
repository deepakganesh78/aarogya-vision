import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { FAKE_JPEG, authed, buildCase, startTestServer, submitCase } from './helpers.js';

describe('case intake and review API', () => {
  let ctx;
  let workerToken;
  let otherWorkerToken;
  let doctorToken;

  before(async () => {
    ctx = await startTestServer();
    workerToken = await ctx.login('asha-demo');
    otherWorkerToken = await ctx.login('asha-demo-2');
    doctorToken = await ctx.login('doctor-demo');
  });

  after(() => ctx.close());

  it('rejects unknown access codes', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'nope' }) });
    assert.equal(res.status, 401);
  });

  it('requires authentication and the right role', async () => {
    assert.equal((await fetch(`${ctx.baseUrl}/api/worker/cases`)).status, 401);
    assert.equal((await fetch(`${ctx.baseUrl}/api/doctor/cases`, { headers: authed(workerToken) })).status, 403);
    assert.equal((await submitCase(ctx.baseUrl, doctorToken, buildCase())).status, 403);
    assert.equal((await fetch(`${ctx.baseUrl}/api/worker/cases`, { headers: authed('forged.token') })).status, 401);
  });

  it('accepts a case, computes triage on the server and is idempotent on retry', async () => {
    const record = buildCase({ assessment: { ...buildCase().assessment, temperatureC: 38.4 } });
    const first = await submitCase(ctx.baseUrl, workerToken, record);
    assert.equal(first.status, 201);
    const created = (await first.json()).case;
    assert.equal(created.triage.level, 'URGENT');

    const retry = await submitCase(ctx.baseUrl, workerToken, record);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).duplicate, true);

    const conflict = await submitCase(ctx.baseUrl, otherWorkerToken, record);
    assert.equal(conflict.status, 409);
  });

  it('rejects cases without consent, with unknown fields, or with mislabelled files', async () => {
    const noConsent = buildCase({ consent: { given: false, givenBy: 'mother', method: 'verbal', at: new Date().toISOString() } });
    assert.equal((await submitCase(ctx.baseUrl, workerToken, noConsent)).status, 400);

    const extra = { ...buildCase(), patientName: 'should not be accepted' };
    assert.equal((await submitCase(ctx.baseUrl, workerToken, extra)).status, 400);

    const fakeAudio = await submitCase(ctx.baseUrl, workerToken, buildCase(), { audio: Buffer.from('not really audio data at all') });
    assert.equal(fakeAudio.status, 400);
    assert.equal((await fakeAudio.json()).error, 'audio_unsupported_type');
  });

  it('runs the AI pipeline, cites guidelines and orders the doctor queue by urgency', async () => {
    const routine = buildCase({ assessment: { ...buildCase().assessment, notes: 'Routine day 14 visit, feeding well.' } });
    const urgent = buildCase();
    await submitCase(ctx.baseUrl, workerToken, routine, { photo: null, audio: null });
    await submitCase(ctx.baseUrl, workerToken, urgent);
    await ctx.services.processor.drain();

    const queue = (await (await fetch(`${ctx.baseUrl}/api/doctor/cases`, { headers: authed(doctorToken) })).json()).cases;
    const levels = queue.map((c) => c.triage.level);
    assert.deepEqual(levels, [...levels].sort((a, b) => ['ROUTINE', 'PRIORITY', 'URGENT'].indexOf(b) - ['ROUTINE', 'PRIORITY', 'URGENT'].indexOf(a)));

    const detail = (await (await fetch(`${ctx.baseUrl}/api/doctor/cases/${urgent.id}`, { headers: authed(doctorToken) })).json()).case;
    assert.equal(detail.status, 'awaiting_review');
    assert.equal(detail.ai.status, 'done');
    assert.match(detail.ai.output.summaryForDoctor, /MOCK AI/);
    assert.equal(detail.triage.level, 'URGENT');
    assert.ok(detail.guidelines.some((g) => g.id === 'who-very-severe-disease'));
    assert.ok(detail.triage.reasons.some((r) => r.code === 'ai_sign' && r.signId === 'not_feeding_well'));
  });

  it('serves media only to doctors', async () => {
    const record = buildCase();
    await submitCase(ctx.baseUrl, workerToken, record);
    const photo = await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}/media/photo`, { headers: authed(doctorToken) });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), FAKE_JPEG);
    assert.equal((await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}/media/photo`, { headers: authed(workerToken) })).status, 403);
  });

  it('returns the doctor decision, machine-translated, to the submitting worker only', async () => {
    const record = buildCase();
    await submitCase(ctx.baseUrl, workerToken, record);
    await ctx.services.processor.drain();

    const bad = await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}/decision`, {
      method: 'POST',
      headers: { ...authed(doctorToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'prescribe', instructions: 'x' })
    });
    assert.equal(bad.status, 400);

    const res = await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}/decision`, {
      method: 'POST',
      headers: { ...authed(doctorToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'refer_now', instructions: 'Take the baby to the PHC now. Keep her warm.' })
    });
    assert.equal(res.status, 200);

    const mine = (await (await fetch(`${ctx.baseUrl}/api/worker/cases`, { headers: authed(workerToken) })).json()).cases;
    const mineCase = mine.find((c) => c.id === record.id);
    assert.equal(mineCase.status, 'responded');
    assert.equal(mineCase.decision.outcome, 'refer_now');
    assert.equal(mineCase.decision.translated.lang, 'ta');
    assert.equal(mineCase.decision.translated.machine, true);
    assert.equal(mineCase.decision.instructions, 'Take the baby to the PHC now. Keep her warm.');

    const others = (await (await fetch(`${ctx.baseUrl}/api/worker/cases`, { headers: authed(otherWorkerToken) })).json()).cases;
    assert.equal(others.some((c) => c.id === record.id), false);
  });

  it('records an audit trail without health content', async () => {
    await ctx.services.audit.flush();
    const events = await ctx.services.audit.read();
    const types = new Set(events.map((e) => e.type));
    for (const type of ['auth.login', 'auth.failed', 'case.created', 'ai.output', 'case.triaged', 'case.viewed', 'media.viewed', 'decision.recorded']) {
      assert.ok(types.has(type), `missing audit event ${type}`);
    }
    const text = JSON.stringify(events);
    assert.equal(text.includes('not feeding'), false);
    assert.equal(text.includes('Keep her warm'), false);
  });

  it('sends security headers', async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /script-src-attr 'none'/);
    assert.match(res.headers.get('content-security-policy'), /style-src-elem 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('permissions-policy'), /microphone=\(self\)/);
  });
});

describe('simple capture: photo and voice only, fields filled by AI', () => {
  let ctx;
  let worker;
  let otherWorker;

  before(async () => {
    ctx = await startTestServer();
    worker = await ctx.login('asha-demo');
    otherWorker = await ctx.login('asha-demo-2');
  });

  after(() => ctx.close());

  function minimal(overrides = {}) {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), capturedAt: now, language: 'ta', consent: { given: true, givenBy: 'mother', method: 'verbal', at: now }, ...overrides };
  }

  it('accepts a voice note and photo with no form fields, then auto-fills them', async () => {
    const record = minimal();
    const res = await submitCase(ctx.baseUrl, worker, record);
    assert.equal(res.status, 201);
    await ctx.services.processor.drain();

    const mine = await (await fetch(`${ctx.baseUrl}/api/worker/cases/${record.id}`, { headers: authed(worker) })).json();
    const c = mine.case;
    assert.equal(c.aiStatus, 'done');
    assert.equal(c.patient.ageDays, 8);
    assert.equal(c.patient.sex, 'female');
    assert.equal(c.vitals.temperatureC, 38.3);
    assert.deepEqual(c.autofill, { ageDays: 'ai_voice', sex: 'ai_voice', temperatureC: 'ai_voice' });
    assert.equal(c.triage.level, 'URGENT');
    assert.equal(c.triage.signs.not_feeding_well.state, 'yes');
    assert.equal(c.triage.signs.convulsions.state, 'no', '"No fits" in the voice note is recorded');
    assert.ok(!c.triage.incomplete.includes('convulsions'));
    assert.equal(c.followUpQuestions.length, 1);

    assert.equal((await fetch(`${ctx.baseUrl}/api/worker/cases/${record.id}`, { headers: authed(otherWorker) })).status, 404);
  });

  it('marks a case urgent from the one-tap danger switch alone', async () => {
    const record = minimal({ assessment: { workerFlag: true } });
    const res = await submitCase(ctx.baseUrl, worker, record, { photo: null });
    assert.equal((await res.json()).case.triage.level, 'URGENT');
  });

  it('rejects a capture with no photo, voice or note', async () => {
    const res = await submitCase(ctx.baseUrl, worker, minimal(), { photo: null, audio: null });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'empty_case');
  });
});

describe('AI failure handling', () => {
  it('falls back to human review when the model fails', async () => {
    const failing = { name: 'gemini', model: 'test', promptVersion: 'x', analyze: async () => { throw new Error('blocked by Gemini safety filters (SAFETY)'); }, translate: async () => { throw new Error('down'); } };
    const ctx = await startTestServer({ overrides: { provider: failing } });
    try {
      const worker = await ctx.login('asha-demo');
      const doctor = await ctx.login('doctor-demo');
      const signs = Object.fromEntries(Object.keys(buildCase().assessment.signs).map((k) => [k, 'no']));
      const record = buildCase({ assessment: { signs, temperatureC: null, breathsPerMin: null } });
      await submitCase(ctx.baseUrl, worker, record);
      await ctx.services.processor.drain();
      const detail = (await (await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}`, { headers: authed(doctor) })).json()).case;
      assert.equal(detail.ai.status, 'failed');
      assert.match(detail.ai.error, /safety filters/);
      assert.equal(detail.status, 'awaiting_review');
      assert.equal(detail.triage.level, 'PRIORITY');
      assert.ok(detail.triage.reasons.some((r) => r.code === 'ai_unavailable'));

      const decision = await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}/decision`, {
        method: 'POST',
        headers: { ...authed(doctor), 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'home_care_follow_up', instructions: 'Visit again tomorrow.' })
      });
      const saved = (await decision.json()).case.decision;
      assert.equal(saved.translated, null);
      assert.match(saved.translationError, /down/);
    } finally {
      await ctx.close();
    }
  });
});

describe('configuration safety', () => {
  it('refuses insecure production configuration', async () => {
    const { loadConfig } = await import('../src/config.js');
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SESSION_SECRET/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 's' }), /ACCESS_CODES/);
    const codes = JSON.stringify([{ code: 'long-enough-code-1', role: 'worker', id: 'w1', name: 'W' }]);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', ACCESS_CODES: codes }), /SESSION_SECRET/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', ACCESS_CODES: codes, SESSION_SECRET: 's', AI_PROVIDER: 'mock' }), /mock/);
    const short = JSON.stringify([{ code: 'short', role: 'worker', id: 'w1', name: 'W' }]);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', ACCESS_CODES: short, SESSION_SECRET: 's' }), /12 characters/);
    const ok = loadConfig({ NODE_ENV: 'production', ACCESS_CODES: codes, SESSION_SECRET: 's', GEMINI_API_KEY: 'k' });
    assert.equal(ok.store, 'gcp');
    assert.equal(ok.auditSink, 'cloud-logging');
    assert.equal(ok.ai.provider, 'gemini');
  });
});
