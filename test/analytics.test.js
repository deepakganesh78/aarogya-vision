import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ageBand, createAnalytics } from '../src/analytics.js';
import { authed, buildCase, startTestServer, submitCase } from './helpers.js';

function fakeTable({ fail = false } = {}) {
  const rows = [];
  return {
    rows,
    async insert(batch) {
      if (fail) throw new Error('bigquery unavailable');
      rows.push(...batch);
    }
  };
}

describe('BigQuery analytics export', () => {
  it('streams de-identified triage and decision events', async () => {
    const table = fakeTable();
    const analytics = createAnalytics({ table, salt: 'test-salt' });
    const ctx = await startTestServer({ overrides: { analytics } });
    try {
      const worker = await ctx.login('asha-demo');
      const doctor = await ctx.login('doctor-demo');
      const record = buildCase({ patient: { name: 'Baby of L.K.', ageValue: 8, ageUnit: 'days', ageDays: 8, sex: 'female', reference: 'L.K.' } });
      await submitCase(ctx.baseUrl, worker, record);
      await ctx.services.processor.drain();
      await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}/decision`, {
        method: 'POST',
        headers: { ...authed(doctor), 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'refer_now', instructions: 'Go to the PHC now.' })
      });
      await new Promise((r) => setTimeout(r, 20));

      assert.deepEqual(table.rows.map((r) => r.event), ['triaged', 'decided']);
      const [triaged, decided] = table.rows;
      assert.equal(triaged.level, 'URGENT');
      assert.equal(triaged.age_band, '7-27d');
      assert.equal(triaged.ai_raised_level, true, 'mock AI heard "not feeding" that the checklist marked no');
      assert.ok(triaged.signs_present.includes('not_feeding_well'));
      assert.equal(decided.outcome, 'refer_now');
      assert.equal(typeof decided.minutes_to_decision, 'number');

      const serialized = JSON.stringify(table.rows);
      for (const secret of [record.id, 'asha-001', 'Lakshmi', 'L.K.', 'not feeding', 'Go to the PHC']) {
        assert.equal(serialized.includes(secret), false, `analytics leaked "${secret}"`);
      }
      assert.equal(triaged.case_key, decided.case_key, 'pseudonyms are stable for joins');
    } finally {
      await ctx.close();
    }
  });

  it('never blocks the clinical workflow when BigQuery fails', async () => {
    const analytics = createAnalytics({ table: fakeTable({ fail: true }), salt: 's', logger: { error() {} } });
    const ctx = await startTestServer({ overrides: { analytics } });
    try {
      const worker = await ctx.login('asha-demo');
      const res = await submitCase(ctx.baseUrl, worker, buildCase());
      assert.equal(res.status, 201);
      await ctx.services.processor.drain();
    } finally {
      await ctx.close();
    }
  });

  it('requires a pseudonymisation salt and bands ages', () => {
    assert.throws(() => createAnalytics({ table: fakeTable() }), /ANALYTICS_SALT/);
    assert.equal(createAnalytics({}).enabled, false);
    assert.deepEqual([0, 6, 7, 27, 28, 59, 60, null].map(ageBand), ['0-6d', '0-6d', '7-27d', '7-27d', '28-59d', '28-59d', '60d+', 'unknown']);
  });
});
