// Seeds the demo cases from the first prototype (yesterday + today) for Parvati, ASHA in Nammiyampattu.
// Cases go through the real API and rules, with typed notes and no AI call, so seeding is instant and
// spends no Gemini quota. Murugan comes back the next day, so he shows as a returning patient.
//
//   npm run seed            add the demo cases (skips if they are already there)
//   npm run seed -- --force add them again anyway
//
// Safe to run while the dev server is running (same SQLite file); refresh the doctor console afterwards.
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createServices } from '../src/bootstrap.js';

const force = process.argv.includes('--force');
const config = loadConfig({ ...process.env, PORT: '0' });
const services = await createServices(config, { provider: null });
const { store, processor } = services;

const existing = await store.listAll();
if (!force && existing.some((r) => r.history?.some((h) => h.event === 'seeded'))) {
  console.log('Demo cases are already in the database. Use "npm run seed -- --force" to add them again.');
  store.close?.();
  process.exit(0);
}

const server = await new Promise((resolve) => {
  const s = services.app.listen(0, () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function login(code) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!res.ok) throw new Error(`login failed for ${code}`);
  return (await res.json()).token;
}

const at = (daysAgo, hh, mm) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
};

const CASES = [
  {
    when: at(1, 9, 40),
    language: 'ta',
    patient: { name: 'Baby of Kaveri', ageValue: 8, ageUnit: 'days', sex: 'female' },
    note: '8 days old, not feeding, feels hot. Red skin around the navel.',
    decision: { outcome: 'refer_now', instructions: 'Take the baby to PHC Jamunamarathur now. I have called the medical officer.', after: 15 }
  },
  {
    when: at(1, 11, 15),
    language: 'en',
    patient: { name: 'Murugan', ageValue: 34, ageUnit: 'years', sex: 'male' },
    note: 'Cut on the leg from farm work three days ago, now pus around it. No fever.',
    decision: { outcome: 'need_more_info', instructions: 'I will call you at 4 pm. Keep the wound clean and covered.', after: 50 }
  },
  {
    when: at(1, 15, 30),
    language: 'en',
    patient: { name: 'Selvi', ageValue: 6, ageUnit: 'years', sex: 'female' },
    note: 'Small rash on the arm, itching. No fever, eating well.',
    decision: { outcome: 'home_care_follow_up', instructions: 'Looks mild. Keep the area clean; send again if fever starts.', after: 40 }
  },
  {
    when: at(0, 8, 20),
    language: 'ta',
    patient: { name: 'Anjali', ageValue: 24, ageUnit: 'years', sex: 'female', pregnant: true, pregnancyMonths: 7 },
    note: 'Seven months pregnant. Severe headache since morning and blurred vision. Swelling in the feet.'
  },
  {
    when: at(0, 9, 5),
    language: 'en',
    patient: { name: 'Murugan', ageValue: 34, ageUnit: 'years', sex: 'male' },
    note: 'Same leg wound as yesterday. Spreading red around it and pus, and now he has fever.'
  },
  {
    when: at(0, 10, 30),
    language: 'en',
    patient: { name: 'Ravi', ageValue: 2, ageUnit: 'years', sex: 'male' },
    note: 'Loose motions since yesterday, still drinking well, playing.'
  }
];

try {
  const ashaToken = await login('asha-demo');
  const doctor = { id: 'dr-001', name: 'Dr. R. Senthil (demo)' };
  for (const c of CASES) {
    const id = crypto.randomUUID();
    const body = {
      id,
      capturedAt: c.when,
      language: c.language,
      consent: { given: true, givenBy: 'family', method: 'verbal', at: c.when },
      patient: c.patient,
      assessment: { notes: c.note }
    };
    const form = new FormData();
    form.append('case', JSON.stringify(body));
    const res = await fetch(`${base}/api/cases`, { method: 'POST', headers: { Authorization: `Bearer ${ashaToken}` }, body: form });
    if (!res.ok) throw new Error(`seeding ${c.patient.name} failed: ${res.status} ${await res.text()}`);
    await processor.drain();

    // Backdate to when the visit happened and label the missing AI summary honestly.
    const record = await store.update(id, (r) => {
      r.receivedAt = c.when;
      r.ai = { status: 'skipped', reason: 'Seeded demo case from a typed note: no AI summary was made. The urgency comes from the danger-sign rules.' };
      r.history = [
        { at: c.when, event: 'received', by: r.worker.id },
        { at: c.when, event: 'seeded', by: 'system' }
      ];
      if (c.decision) {
        const decidedAt = new Date(Date.parse(c.when) + c.decision.after * 60_000).toISOString();
        r.decision = { outcome: c.decision.outcome, instructions: c.decision.instructions, followUpDate: null, by: doctor, at: decidedAt, translated: null };
        r.status = 'responded';
        r.history.push({ at: decidedAt, event: `decision_${c.decision.outcome}`, by: doctor.id });
      }
    });
    const p = record.patient;
    console.log(
      `${c.when.slice(0, 16).replace('T', ' ')}  ${record.triage.level.padEnd(8)} ${p.name.padEnd(15)} ${p.returning ? `returning, visit ${p.visit}` : 'first visit'.padEnd(18)}  ${c.decision ? `doctor: ${c.decision.outcome}` : 'waiting for doctor'}`
    );
  }
} finally {
  await services.audit.flush();
  await new Promise((resolve) => server.close(resolve));
  store.close?.();
}
