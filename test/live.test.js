import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLayout, GRID } from '../public/js/live/layout.js';
import { createNetwork } from '../public/js/live/network.js';
import { createSim, matchMedicine } from '../public/js/live/sim.js';
import { createTraffic, findOverlaps } from '../public/js/live/traffic.js';
import { mulberry32 } from '../public/js/live/util.js';

const DT = 1 / 30;

function createBlock(seed) {
  const network = createNetwork(GRID);
  const layout = buildLayout({ seed: 7 }, network);
  const rng = mulberry32(seed);
  const traffic = createTraffic(network, { rng, signalNodes: layout.signalNodes });
  const sim = createSim({ layout, network, traffic, rng, now: () => Date.UTC(2026, 10, 20, 5, 30) });
  return { layout, traffic, sim };
}

describe('lead doctor live view simulation (rural block)', () => {
  it('lets a car follow a slow bullock cart round a corner only once the cart has cleared it', () => {
    for (const [cartS, carS] of [[10, 5], [9, 4.5]]) {
      const traffic = createTraffic(createNetwork(GRID), { rng: mulberry32(1), signalNodes: [] });
      const cart = traffic.spawnOnLane('cart', '1,0>0,0', cartS);
      const car = traffic.spawnOnLane('car', '1,0>0,0', carS);
      for (let frame = 0; frame < 20 / DT; frame++) {
        traffic.step(DT);
        assert.equal(findOverlaps(traffic.vehicles).length, 0, `vehicles overlap at frame ${frame}`);
      }
      for (const v of [cart, car]) assert.ok(v.lane && v.lane.id !== '1,0>0,0', `${v.kind} never turned the corner`);
    }
  });

  it('keeps every vehicle moving without overlaps, caps urgent cases and completes referrals', () => {
    for (const seed of [23, 5]) {
      const { traffic, sim } = createBlock(seed);
      const referrals = [];
      sim.on('run:done', (run) => run.type === 'referral' && referrals.push(run));
      let maxUrgent = 0;
      for (let frame = 0; frame < 300 / DT; frame++) {
        sim.step(DT);
        if (frame === 100 / DT) sim.setSeason('monsoon');
        if (frame % 3 === 0) assert.equal(findOverlaps(traffic.vehicles).length, 0, `seed ${seed}: vehicles overlap at frame ${frame}`);
        if (frame % 30 === 0) maxUrgent = Math.max(maxUrgent, sim.kpis().cases.urgent);
      }
      const ambient = traffic.vehicles.filter((v) => !v.fleet);
      assert.ok(Math.min(...ambient.map((v) => v.odometer)) > 150, `seed ${seed}: a vehicle got stuck`);
      assert.ok(maxUrgent <= 3, `seed ${seed}: ${maxUrgent} urgent cases open at once`);
      assert.ok(referrals.length >= 2, `seed ${seed}: only ${referrals.length} referrals completed`);
      assert.ok(referrals.every((r) => r.steps[5].label === 'Reached block PHC' && r.status === 5));
    }
  });

  it('keeps an urgent home marked until the ambulance picks the infant up, then closes the case', () => {
    const { layout, sim } = createBlock(11);
    const home = layout.buildings.find((b) => b.kind === 'house' && !sim.cases.has(b.id));
    const closed = [];
    sim.on('case:close', (c) => closed.push(c));
    const c = sim.openCase('URGENT', home);
    assert.equal(sim.cases.get(home.id), c);
    assert.ok(c.runId, 'an idle ambulance is dispatched at once');
    const run = sim.runs.get(c.runId);
    assert.equal(run.to.id, home.id);

    for (let frame = 0; frame < 240 / DT && sim.cases.has(home.id); frame++) sim.step(DT);
    assert.equal(sim.cases.has(home.id), false);
    assert.equal(closed.find((x) => x.id === c.id)?.status, 'Referred to PHC Jamunamarathur by 108');
    assert.ok(run.status >= 3, 'the case closes at pickup');
    for (let frame = 0; frame < 120 / DT && run.status < 5; frame++) sim.step(DT);
    assert.equal(run.steps[run.status].label, 'Reached block PHC');
  });

  it('mirrors real cases from the ASHA app into the ASHA village and only closes them after the doctor replies', () => {
    const { sim } = createBlock(3);
    const real = { id: 'c0ffee12-3456', level: 'URGENT', status: 'awaiting_review', receivedAt: new Date().toISOString(), workerId: 'asha-001', workerName: 'Parvati', village: 'Nammiyampattu', patient: { name: 'Lakshmi', ageValue: 8, ageUnit: 'days', sex: 'female' }, reasons: [] };
    const routine = { ...real, id: 'beef-0002', level: 'ROUTINE', workerId: 'asha-002', workerName: 'Meena', village: null };
    const runsBefore = sim.runs.size;
    sim.syncExternalCases([real, routine]);
    const c = [...sim.cases.values()].find((x) => x.id === real.id);
    assert.ok(c?.external);
    assert.equal(sim.villages.get(c.zone).name, 'Nammiyampattu');
    assert.equal(sim.villages.get([...sim.cases.values()].find((x) => x.id === routine.id).zone).name, 'Kovilur', 'mapped by ASHA id');
    assert.equal(sim.runs.size, runsBefore, 'no simulated ambulance for a real case');

    for (let frame = 0; frame < 200 / DT; frame++) sim.step(DT);
    assert.equal(sim.cases.get(c.buildingId), c, 'still open: only the doctor closes it');
    assert.equal(c.level, 'URGENT', 'level is never changed by the simulation');
    assert.equal(c.runId, null);
    assert.ok(sim.kpis().cases.real === 2);

    sim.syncExternalCases([routine]);
    assert.equal(sim.cases.has(c.buildingId), false);
    assert.equal(sim.closedCases[0].status, 'Doctor replied');
  });

  it('closes review-today cases at their review and reports open cases by level', () => {
    const { sim } = createBlock(7);
    const initial = [...sim.cases.values()].filter((c) => c.level === 'PRIORITY');
    assert.ok(initial.length >= 5);
    for (let frame = 0; frame < 95 / DT; frame++) sim.step(DT);
    for (const c of initial) {
      const open = sim.cases.get(c.buildingId) === c;
      assert.ok(!open || c.level === 'URGENT', `${c.id} is still waiting for review`);
    }
    const k = sim.kpis().cases;
    const open = [...sim.cases.values()];
    assert.equal(k.urgent, open.filter((c) => c.level === 'URGENT').length);
    assert.equal(k.priority, open.filter((c) => c.level === 'PRIORITY').length);
  });

  it('matches typed medicine names to the stock list', () => {
    assert.equal(matchMedicine('Cetirizine 10 mg'), 'cetirizine');
    assert.equal(matchMedicine('Tab. Paracetamol'), 'pcm');
    assert.equal(matchMedicine('ORS sachets'), 'ors');
    assert.equal(matchMedicine('Calamine lotion'), 'calamine');
    assert.equal(matchMedicine('Unknownazole'), null);
  });

  it('finds the medicines, suggests a round that covers them and delivers by one bike, stop by stop', () => {
    const { layout, traffic, sim } = createBlock(9);
    const home = layout.buildings.find((b) => b.kind === 'house' && !sim.cases.has(b.id));
    const names = ['Cetirizine 10 mg', 'Calamine lotion', 'Paracetamol 500 mg', 'Mystery syrup'];

    const found = sim.findMedicineSources(names, home.id);
    assert.ok(found.length >= 6, 'PHC pharmacies, sub-centres and medical shops are all scanned');
    assert.ok(found.every((f, i) => i === 0 || f.covered <= found[i - 1].covered), 'places with more of the medicines come first');
    assert.ok(found.some((f) => f.kind === 'shop' && f.covered > 0), 'a private medical shop stocks a retail medicine');

    const plan = sim.planPickup(names, home.id);
    assert.deepEqual(plan.missing, ['Mystery syrup'], 'only the unknown medicine is missing');
    const covered = plan.stops.flatMap((s) => s.items.map((i) => i.id)).sort();
    assert.deepEqual(covered, ['calamine', 'cetirizine', 'pcm']);
    assert.ok(plan.courier && plan.distanceKm > 0 && plan.etaMin >= 3);

    // The doctor chooses two places that are both needed (each has a medicine the other lacks or is nearer).
    let pair = null;
    for (const a of found) {
      for (const b of found) {
        if (pair || a === b || !a.covered || !b.covered) continue;
        const p = sim.planPickup(names, home.id, [a.id, b.id]);
        if (p.stops.length === 2 && p.missing.length === 1) pair = [a, b];
      }
    }
    assert.ok(pair, 'some two places together cover the prescription');
    const shop = found.find((f) => f.kind === 'shop' && f.rows.some((r) => r.id === 'cetirizine' && r.units > 0));
    const before = shop.rows.find((r) => r.id === 'cetirizine').units;
    const collected = [];
    const done = [];
    sim.on('prescription:collect', ({ stop }) => collected.push(stop.id));
    sim.on('prescription:done', (r) => done.push(r));
    const run = sim.dispatchPrescription({ caseId: 'case-1', homeId: home.id, names, stopIds: pair.map((f) => f.id), patientName: 'Kavya' });
    assert.equal(run.type, 'prescription');
    assert.deepEqual(new Set(run.stops.map((s) => s.id)), new Set(pair.map((f) => f.id)));

    for (let frame = 0; frame < 240 / DT && !done.length; frame++) {
      sim.step(DT);
      if (frame % 3 === 0) assert.equal(findOverlaps(traffic.vehicles).length, 0, `vehicles overlap at frame ${frame}`);
    }
    assert.equal(done.length, 1, 'the bike reached the patient');
    assert.deepEqual(collected, run.stops.map((s) => s.id), 'every stop is collected, in the planned order, before delivery');
    assert.equal(run.status, 5);
    assert.equal(run.steps[5].label, 'Delivered');
    const took = run.stops.some((s) => s.id === shop.id && s.items.some((i) => i.id === 'cetirizine'));
    const after = sim.findMedicineSources(names, home.id).find((f) => f.id === shop.id).rows.find((r) => r.id === 'cetirizine').units;
    assert.equal(after, took ? before - 1 : before, 'stock goes down only where the bike collected');
  });
});
