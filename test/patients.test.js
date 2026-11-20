import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, buildCase, startTestServer, submitCase } from './helpers.js';

// Patient register, profiles, history, KPIs, FHIR and live events, against the SQLite store.
describe('patients, profiles and history (SQLite)', () => {
  let ctx;
  let asha;
  let asha2;
  let doctor;
  const events = [];

  before(async () => {
    ctx = await startTestServer();
    ctx.services.events.subscribe((e) => events.push(e));
    asha = await ctx.login('asha-demo');
    asha2 = await ctx.login('asha-demo-2');
    doctor = await ctx.login('doctor-demo');
  });
  after(() => ctx.close());

  const visit = (patient, notes, token = asha) =>
    submitCase(ctx.baseUrl, token, buildCase({ language: 'en', patient, assessment: { notes } }), { photo: null, audio: null });

  it('uses the SQLite database by default', () => {
    assert.equal(ctx.config.store, 'sqlite');
    assert.equal(ctx.services.store.name, 'sqlite');
  });

  it('returns the ASHA profile with her village and PHC, and how many doctors are online (no assigned doctor)', async () => {
    const body = await (await fetch(`${ctx.baseUrl}/api/profile`, { headers: authed(asha) })).json();
    assert.equal(body.asha.name, 'Parvati');
    assert.equal(body.asha.village, 'Nammiyampattu');
    assert.equal(body.asha.phc, 'PHC Jamunamarathur');
    assert.equal(body.doctorsOnline, 0);
    assert.equal(body.doctor, undefined);
  });

  it('registers a new patient on the first visit and recognises her on the next one', async () => {
    const patient = { name: 'Anjali', ageValue: 24, ageUnit: 'years', sex: 'female', pregnant: true, pregnancyMonths: 7 };
    const first = await (await visit(patient, 'Seven months pregnant. Severe headache and blurred vision.')).json();
    assert.match(first.case.patient.id, /^PT-[0-9A-F]{8}$/);
    assert.equal(first.case.patient.returning, false);
    assert.equal(first.case.patient.ageDays, 24 * 365);
    assert.equal(first.case.patient.pregnant, true);
    assert.equal(first.case.patient.pregnancyMonths, 7);
    assert.equal(first.case.triage.level, 'URGENT');

    // Same name (different case and spacing) and sex, no id: the same patient.
    const second = await (await visit({ ...patient, name: '  anjali ' }, 'Headache better today.')).json();
    assert.equal(second.case.patient.id, first.case.patient.id);
    assert.equal(second.case.patient.returning, true);
    assert.equal(second.case.patient.visit, 2);

    const { patients } = await (await fetch(`${ctx.baseUrl}/api/worker/patients`, { headers: authed(asha) })).json();
    const anjali = patients.find((p) => p.id === first.case.patient.id);
    assert.equal(anjali.visits, 2);
    assert.equal(anjali.pregnant, true);
  });

  it("keeps each worker's patients separate", async () => {
    const res = await visit({ name: 'Anjali', ageValue: 30, ageUnit: 'years', sex: 'female' }, 'Mild fever.', asha2);
    const body = await res.json();
    assert.equal(body.case.patient.returning, false);
    const { patients } = await (await fetch(`${ctx.baseUrl}/api/worker/patients`, { headers: authed(asha2) })).json();
    assert.equal(patients.length, 1);
  });

  it('rejects pregnancy for a male patient', async () => {
    const res = await visit({ name: 'Ravi', ageValue: 30, ageUnit: 'years', sex: 'male', pregnant: true, pregnancyMonths: 3 }, 'x');
    assert.equal(res.status, 400);
  });

  it('applies adult rules: wound with pus is review today, with fever it becomes urgent', async () => {
    const p = { name: 'Murugan', ageValue: 34, ageUnit: 'years', sex: 'male' };
    const day1 = await (await visit(p, 'Cut on the leg, now pus around it. No fever.')).json();
    assert.equal(day1.case.triage.level, 'PRIORITY');
    const day2 = await (await visit(p, 'Spreading red around the wound and pus, and now he has fever.')).json();
    assert.equal(day2.case.triage.level, 'URGENT');
    assert.equal(day2.case.patient.visit, 2);
  });

  it('gives the doctor the patient history, newest first', async () => {
    await ctx.services.processor.drain();
    const { cases } = await (await fetch(`${ctx.baseUrl}/api/doctor/cases?view=all`, { headers: authed(doctor) })).json();
    const latest = cases.find((c) => c.patient.name === 'Murugan' && c.patient.visit === 2);
    const body = await (await fetch(`${ctx.baseUrl}/api/doctor/patients/${latest.patient.id}/cases`, { headers: authed(doctor) })).json();
    assert.equal(body.patient.visits, 2);
    assert.equal(body.history.length, 2);
    assert.ok(body.history[0].receivedAt >= body.history[1].receivedAt);
    assert.ok(body.history[0].signs.includes('wound_infected'));
  });

  it('stores curated worker steps in every language, with no medicines', async () => {
    await ctx.services.processor.drain();
    const { cases } = await (await fetch(`${ctx.baseUrl}/api/worker/cases`, { headers: authed(asha) })).json();
    const preg = cases.find((c) => c.patient.pregnant);
    assert.equal(preg.workerSteps.guidelineId, 'mohfw-anc-danger');
    for (const lang of ['en', 'hi', 'ta']) assert.ok(preg.workerSteps[lang].length > 0, lang);
    assert.ok(!/tablet|syrup|injection|\d+\s?mg/i.test(JSON.stringify(preg.workerSteps)));
  });

  it('reports KPIs and exports a FHIR bundle with the patient and pregnancy', async () => {
    const stats = await (await fetch(`${ctx.baseUrl}/api/doctor/stats`, { headers: authed(doctor) })).json();
    assert.ok(stats.waiting >= 4);
    assert.ok(stats.urgentWaiting >= 1);
    assert.ok(stats.oldestWaiting.minutes >= 0);

    const { cases } = await (await fetch(`${ctx.baseUrl}/api/doctor/cases?view=all`, { headers: authed(doctor) })).json();
    const preg = cases.find((c) => c.patient.pregnant);
    const res = await fetch(`${ctx.baseUrl}/api/doctor/cases/${preg.id}/fhir`, { headers: authed(doctor) });
    assert.equal(res.status, 200);
    const bundle = await res.json();
    const types = bundle.entry.map((e) => e.resource.resourceType);
    assert.ok(types.includes('Patient') && types.includes('Encounter') && types.includes('Flag'));
    assert.equal(bundle.entry.find((e) => e.resource.resourceType === 'Patient').resource.name[0].text, 'Anjali');
    assert.ok(bundle.entry.some((e) => e.resource.valueCodeableConcept?.text === 'Pregnant, 7 months'));
  });

  it('publishes live events for new, triaged and decided cases', async () => {
    const created = events.filter((e) => e.type === 'case.created');
    const triaged = events.filter((e) => e.type === 'case.triaged');
    assert.ok(created.length >= 5);
    assert.ok(triaged.length >= 5);
    assert.ok(events.every((e) => !('patient' in e) && !('notes' in e)), 'events carry ids only');

    const res = await fetch(`${ctx.baseUrl}/api/doctor/events`);
    assert.equal(res.status, 401, 'the event stream needs a doctor token');
  });

  it('records the audit trail in the database', async () => {
    const entries = await ctx.services.audit.read((e) => e.type === 'case.created');
    assert.ok(entries.length >= 5);
    assert.ok(entries.every((e) => e.patientId === null || /^PT-/.test(e.patientId)));
  });
});
