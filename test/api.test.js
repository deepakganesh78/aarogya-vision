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

  it('behind Firebase Hosting, streams live events straight from Cloud Run to the project sites only', async () => {
    const own = await startTestServer({ env: { LIVE_WS_URL: 'wss://run.example.app', GOOGLE_CLOUD_PROJECT: 'demo-proj' } });
    try {
      assert.equal((await (await fetch(`${own.baseUrl}/api/config`)).json()).eventsUrl, 'https://run.example.app');
      const token = await own.login('doctor-demo');
      const open = async (origin) => {
        const ctrl = new AbortController();
        const res = await fetch(`${own.baseUrl}/api/doctor/events?token=${encodeURIComponent(token)}`, { headers: { Origin: origin }, signal: ctrl.signal });
        ctrl.abort();
        return res.headers.get('access-control-allow-origin');
      };
      assert.equal(await open('https://demo-proj.web.app'), 'https://demo-proj.web.app');
      assert.equal(await open('https://evil.example'), null);
    } finally {
      own.close();
    }
  });

  it('limits failed sign-ins only, so many real sign-ins never lock anyone out', async () => {
    const own = await startTestServer();
    try {
      const login = (code) => fetch(`${own.baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      for (let i = 0; i < 12; i++) assert.equal((await login('asha-demo')).status, 200);
      for (let i = 0; i < 10; i++) assert.equal((await login('wrong')).status, 401);
      assert.equal((await login('wrong')).status, 429);
      assert.equal((await login('asha-demo')).status, 429, 'locked after repeated failures');
    } finally {
      own.close();
    }
  });

  it('signs the ASHA and the doctor in without a code in demo mode, and only then', async () => {
    const auto = (base, role) => fetch(`${base}/api/login/auto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
    assert.equal((await (await fetch(`${ctx.baseUrl}/api/config`)).json()).autoLogin, true);
    for (const [role, id] of [['worker', 'asha-001'], ['doctor', 'dr-001']]) {
      const res = await auto(ctx.baseUrl, role);
      assert.equal(res.status, 200);
      const { token, user } = await res.json();
      assert.equal(user.id, id);
      assert.equal((await fetch(`${ctx.baseUrl}/api/${role}/cases`, { headers: authed(token) })).status, 200);
    }
    assert.equal((await auto(ctx.baseUrl, 'admin')).status, 400);

    const off = await startTestServer({ env: { AUTO_LOGIN: 'false' } });
    try {
      assert.equal((await (await fetch(`${off.baseUrl}/api/config`)).json()).autoLogin, false);
      assert.equal((await auto(off.baseUrl, 'doctor')).status, 404);
    } finally {
      off.close();
    }
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

  it('opens on the live 3D view; the ASHA app is at /asha', async () => {
    const home = await (await fetch(`${ctx.baseUrl}/`)).text();
    const live = await (await fetch(`${ctx.baseUrl}/live`)).text();
    assert.equal(home, live);
    const asha = await fetch(`${ctx.baseUrl}/asha`);
    assert.equal(asha.status, 200);
    assert.match(await asha.text(), /manifest\.webmanifest/);
  });

  it('serves the block live view and its self-hosted 3D engine under the same strict CSP', async () => {
    const page = await fetch(`${ctx.baseUrl}/live`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    const html = await page.text();
    assert.match(html, /Not for clinical use/);
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'no inline scripts');
    assert.equal(/<style\b/.test(html), false, 'no inline style blocks');
    assert.equal((await fetch(`${ctx.baseUrl}/vendor/three.js`)).status, 200);
  });

  it('tells the ASHA how many doctors are online, and lists ASHA profiles for the dashboard', async () => {
    const watchingNow = async () => (await (await fetch(`${ctx.baseUrl}/api/profile`, { headers: authed(workerToken) })).json()).doctorsOnline;
    assert.equal(await watchingNow(), 0);

    const abort = new AbortController();
    const stream = await fetch(`${ctx.baseUrl}/api/doctor/events?token=${encodeURIComponent(doctorToken)}`, { signal: abort.signal });
    assert.equal(stream.status, 200);
    assert.equal(await watchingNow(), 1);
    abort.abort();
    await stream.body?.cancel().catch(() => {});
    for (let i = 0; i < 20 && (await watchingNow()); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(await watchingNow(), 0);

    assert.equal((await fetch(`${ctx.baseUrl}/api/doctor/ashas`, { headers: authed(workerToken) })).status, 403);
    const { ashas } = await (await fetch(`${ctx.baseUrl}/api/doctor/ashas`, { headers: authed(doctorToken) })).json();
    const parvati = ashas.find((a) => a.id === 'asha-001');
    assert.equal(parvati.village, 'Nammiyampattu');
    assert.ok(parvati.casesToday >= 1, 'counts the cases sent earlier in this suite');
    assert.equal(typeof parvati.openCases, 'number');
  });

  it("records the doctor's medicines or referral, keeps the doctor's assessment from the worker", async () => {
    const record = buildCase({ patient: { name: 'Meds Test', ageValue: 6, ageUnit: 'years', sex: 'male' }, assessment: { ...buildCase().assessment, notes: 'Itchy rash on both arms for three days.' } });
    assert.equal((await submitCase(ctx.baseUrl, workerToken, record)).status, 201);
    const decide = (body) => fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}/decision`, { method: 'POST', headers: { ...authed(doctorToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    assert.equal((await decide({ outcome: 'home_care_follow_up', instructions: 'x', referTo: 'Government Hospital, Polur' })).status, 400, 'a referral destination needs an escalation');
    const ok = await decide({
      outcome: 'home_care_follow_up',
      instructions: 'Medicines:\n- Calamine lotion, thin layer, twice a day, for 5 days',
      medicines: [{ name: 'Calamine lotion', dose: 'thin layer', how: 'twice a day', days: 5 }],
      assessment: 'Provisional: contact rash'
    });
    assert.equal(ok.status, 200);
    const mine = (await (await fetch(`${ctx.baseUrl}/api/worker/cases/${record.id}`, { headers: authed(workerToken) })).json()).case;
    assert.equal(mine.decision.medicines[0].name, 'Calamine lotion');
    assert.equal(mine.decision.assessment, undefined, "the doctor's assessment stays in the record");
    const full = (await (await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}`, { headers: authed(doctorToken) })).json()).case;
    assert.equal(full.decision.assessment, 'Provisional: contact rash');
  });

  it('checks a rash photo for the ASHA only: a visual pattern with danger signs to check, nothing stored', async () => {
    const check = (token, photo = FAKE_JPEG) => {
      const form = new FormData();
      if (photo) form.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
      return fetch(`${ctx.baseUrl}/api/worker/photo-check`, { method: 'POST', headers: authed(token), body: form });
    };
    const before = (await (await fetch(`${ctx.baseUrl}/api/doctor/cases?view=all`, { headers: authed(doctorToken) })).json()).cases.length;
    assert.equal((await check(doctorToken)).status, 403);
    assert.equal((await check(workerToken, null)).status, 400);
    assert.equal((await check(workerToken, Buffer.from('not an image'))).status, 400);
    const res = await check(workerToken);
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.pattern, 'blisters_pustules');
    assert.ok(out.checks.includes('many_skin_pustules'), 'it points the worker to the matching danger signs');
    assert.equal(out.provider, 'mock');
    assert.equal(Object.hasOwn(out, 'level'), false, 'it never sets an urgency level');
    const after = (await (await fetch(`${ctx.baseUrl}/api/doctor/cases?view=all`, { headers: authed(doctorToken) })).json()).cases.length;
    assert.equal(after, before, 'no case is created or changed');
  });

  it('sends the prescribed medicines by bike once, shows them to the ASHA, and records the delivery', async () => {
    const record = buildCase({ patient: { name: 'Bike Test', ageValue: 9, ageUnit: 'years', sex: 'female' } });
    assert.equal((await submitCase(ctx.baseUrl, workerToken, record)).status, 201);
    const post = (path, body, token = doctorToken) => fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}${path}`, { method: 'POST', headers: { ...authed(token), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const dispatch = {
      stops: [
        { id: 'shop:b26', name: 'Lakshmi Pharmacy', kind: 'shop', items: ['Cetirizine tablets'], km: 2.4 },
        { id: 'centre:phc-nallur', name: 'PHC Pudurnadu', kind: 'phc', items: ['Paracetamol tablets'], km: 5.1 }
      ],
      courier: { id: 'MC-02', name: 'Selvam' },
      distanceKm: 6.2,
      etaMin: 25,
      missing: []
    };

    assert.equal((await post('/dispatch', dispatch)).status, 409, 'nothing to send before a prescription');
    assert.equal((await post('/dispatch', dispatch, workerToken)).status, 403);
    assert.equal((await post('/decision', { outcome: 'home_care_follow_up', instructions: 'Medicines below', medicines: [{ name: 'Cetirizine', dose: '5 mg' }, { name: 'Paracetamol', dose: '250 mg' }] })).status, 200);
    assert.equal((await post('/dispatch', { ...dispatch, stops: [{ ...dispatch.stops[0], kind: 'warehouse' }] })).status, 400);

    const sent = await post('/dispatch', dispatch);
    assert.equal(sent.status, 201);
    assert.equal((await sent.json()).case.dispatch.status, 'on_the_way');
    assert.equal((await post('/dispatch', dispatch)).status, 409, 'medicines go out once per case');
    const list = (await (await fetch(`${ctx.baseUrl}/api/doctor/cases?view=responded`, { headers: authed(doctorToken) })).json()).cases;
    assert.equal(list.find((c) => c.id === record.id).dispatchStatus, 'on_the_way');

    const mine = async () => (await (await fetch(`${ctx.baseUrl}/api/worker/cases/${record.id}`, { headers: authed(workerToken) })).json()).case;
    const onTheWay = (await mine()).dispatch;
    assert.equal(onTheWay.status, 'on_the_way');
    assert.deepEqual(onTheWay.stops.map((s) => s.name), ['Lakshmi Pharmacy', 'PHC Pudurnadu']);
    assert.equal(onTheWay.courier.name, 'Selvam');
    assert.equal(onTheWay.courier.id, undefined, 'the worker sees names, not internal ids');

    assert.equal((await post('/dispatch/delivered')).status, 200);
    const again = await post('/dispatch/delivered');
    assert.equal(again.status, 200, 'several dashboards may report the same delivery');
    const delivered = (await mine()).dispatch;
    assert.equal(delivered.status, 'delivered');
    assert.ok(delivered.deliveredAt);
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
    // Patient details are required; everything else (vitals, signs) comes from the photo and voice note.
    return { id: crypto.randomUUID(), capturedAt: now, language: 'ta', consent: { given: true, givenBy: 'mother', method: 'verbal', at: now }, patient: { name: 'Baby of Kaveri', ageValue: 8, ageUnit: 'days', ageDays: 8, sex: 'female' }, ...overrides };
  }

  it('rejects a visit without the patient name, age and sex', async () => {
    for (const patient of [undefined, { ageValue: 8, ageUnit: 'days', sex: 'female' }, { name: 'X', sex: 'female' }, { name: 'X', ageValue: 8, ageUnit: 'days' }]) {
      const record = minimal();
      if (patient) record.patient = patient;
      else delete record.patient;
      const res = await submitCase(ctx.baseUrl, worker, record);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid_case');
    }
  });

  it('accepts the patient details with a voice note and photo only, then auto-fills the rest', async () => {
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
    // Autofill only fills gaps: the worker's age and sex stand; the temperature comes from the voice note.
    assert.deepEqual(c.autofill, { temperatureC: 'ai_voice' });
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
    assert.equal(ok.autoLogin, false, 'no code-free sign-in in production unless AUTO_LOGIN=true');
    assert.equal(loadConfig({ NODE_ENV: 'production', ACCESS_CODES: codes, SESSION_SECRET: 's', GEMINI_API_KEY: 'k', AUTO_LOGIN: 'true' }).autoLogin, true);
  });
});
