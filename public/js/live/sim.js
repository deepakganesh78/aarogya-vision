// Synthetic block operations for the lead doctor live view (rural): PHCs, the upgraded block PHC (kind
// 'chc': 24x7, newborn care, 108 base) and HWC sub-centres
// (patients, doctors, beds, staff, stock), home-visit cases flagged by ASHA workers, medicine runs by
// courier, restocks by van from the block drug store, and urgent infant referrals by 108 ambulance.
// Everything is synthetic demo data. Pure logic (no DOM, no Three.js).
// Draft wording: case levels and alert text need clinician sign-off before any pilot. Levels mirror the
// app's rules-based triage (URGENT = refer now, PRIORITY = doctor review today); doctors decide.
import { METERS_PER_UNIT, ROAD } from './network.js';
import { clamp, mulberry32, pick, poisson, range, rangeInt } from './util.js';

/** Operations time runs faster than the animation: one real second is this many simulated minutes. */
export const SIM_MINUTES_PER_SECOND = 0.45;
const KM_PER_UNIT = METERS_PER_UNIT / 1000;
const SPEED_KMH = { scooter: 18, van: 15, ambulance: 28 };
const HOUR_S = 60 / SIM_MINUTES_PER_SECOND; // real seconds in one simulated hour
const MAX_MEDICINE_RUNS = 6;
const MAX_OPEN_CASES = 16;
const MAX_URGENT_OPEN = 3;
const SERVICE_RATE = 0.17; // patients per real second per doctor in OPD

export const RUN_STEPS = {
  medicine: ['Requested', 'Approved', 'Packed', 'Picked up', 'On the way', 'Delivered'],
  restock: ['Indent raised', 'Approved', 'Loaded', 'Dispatched', 'On the way', 'Received'],
  referral: ['Flagged urgent', '108 called', 'Ambulance out', 'Picked up', 'On the way', 'Reached block PHC'],
  prescription: ['Prescribed', 'Bike assigned', 'Collecting', 'Collected', 'On the way', 'Delivered']
};
export const RUN_TYPES = { medicine: 'Medicine run', restock: 'Store restock', referral: 'Urgent referral', prescription: 'Prescription delivery' };
export const CASE_LEVELS = {
  URGENT: { label: 'Urgent: refer now', short: 'Urgent' },
  PRIORITY: { label: 'Doctor review today', short: 'Review today' },
  ROUTINE: { label: 'Routine: doctor review', short: 'Routine' }
};

export const SEASONS = {
  summer: { id: 'summer', name: 'Summer', condition: 'Sunny', tempC: 36, icon: 'sunny', speed: 1, demand: 1.1 },
  monsoon: { id: 'monsoon', name: 'Monsoon', condition: 'Heavy rain', tempC: 27, icon: 'rainy', speed: 0.8, demand: 0.85 },
  festival: { id: 'festival', name: 'Festival night', condition: 'Clear night', tempC: 28, icon: 'celebration', speed: 0.9, demand: 1.2 }
};

export const DOCTOR_STATUS = { opd: 'In OPD', rounds: 'On rounds', nbsu: 'In NBSU', oncall: 'On call', break: 'On break', off: 'Off duty', leave: 'On leave' };
const ON_DUTY = new Set(['opd', 'rounds', 'nbsu', 'oncall', 'break']);
export const STAFF_STATUS = { present: 'Present', field: 'On field visit', leave: 'On leave' };

export const FLEET_STATUS = {
  idle: 'At base',
  assigned: 'Assigned',
  loading: 'Loading',
  en_route: 'Delivering',
  returning: 'Returning',
  responding: 'Responding',
  transporting: 'Transporting patient'
};

// Supply items (no doses: this is logistics, not prescribing). target = units a centre aims to hold.
export const CATALOGUE = {
  ors: { name: 'ORS sachets', unit: 'sachets', price: 2.6, packs: [100, 150, 200], target: 3000 },
  zinc: { name: 'Zinc dispersible tablets', unit: 'strips', price: 6, packs: [20, 30, 40], target: 600 },
  pcm: { name: 'Paracetamol syrup', unit: 'bottles', price: 14, packs: [20, 30, 40], target: 400 },
  ifa: { name: 'IFA tablets', unit: 'strips', price: 3.2, packs: [50, 80, 100], target: 1500 },
  amox: { name: 'Amoxicillin dispersible tablets', unit: 'strips', price: 18, packs: [20, 30], target: 500 },
  vitk: { name: 'Vitamin K injection', unit: 'ampoules', price: 12, packs: [20, 40], target: 200 },
  oxy: { name: 'Oxytocin injection', unit: 'ampoules', price: 9, packs: [30, 50], target: 300, cold: true },
  bcg: { name: 'BCG vaccine', unit: 'vials', price: 45, packs: [10, 20], target: 120, cold: true },
  penta: { name: 'Pentavalent vaccine', unit: 'vials', price: 120, packs: [10, 15], target: 150, cold: true },
  gloves: { name: 'Examination gloves', unit: 'pairs', price: 4, packs: [100, 200], target: 3000 },
  clamps: { name: 'Cord clamps', unit: 'pieces', price: 3, packs: [50, 100], target: 800 },
  thermo: { name: 'Digital thermometers', unit: 'pieces', price: 95, packs: [5, 10], target: 40 },
  asv: { name: 'Anti-snake venom', unit: 'vials', price: 480, packs: [5, 10], target: 30 }
};
const ASHA_KIT = ['ors', 'zinc', 'pcm', 'ifa', 'gloves', 'thermo'];

// Medicines a doctor may prescribe that are not in the supply catalogue above (simulated retail and
// essential-list items for the medicine finder). Names only: the doctor gives every dose.
const RETAIL = {
  cetirizine: { name: 'Cetirizine tablets', unit: 'strips' },
  calamine: { name: 'Calamine lotion', unit: 'bottles' },
  permethrin: { name: 'Permethrin cream', unit: 'tubes' },
  clotrimazole: { name: 'Clotrimazole cream', unit: 'tubes' },
  albendazole: { name: 'Albendazole tablets', unit: 'tablets' }
};
// Words a doctor may type for each medicine (matched case-insensitively at word starts).
const ALIASES = {
  ors: ['ors', 'oral rehydration'],
  zinc: ['zinc'],
  pcm: ['paracetamol', 'pcm', 'acetaminophen', 'crocin', 'dolo', 'calpol'],
  ifa: ['ifa', 'iron', 'folic'],
  amox: ['amoxicillin', 'amoxycillin', 'amox'],
  vitk: ['vitamin k'],
  oxy: ['oxytocin'],
  asv: ['anti-snake', 'anti snake', 'asv'],
  cetirizine: ['cetirizine', 'cetrizine', 'levocetirizine', 'antihistamine'],
  calamine: ['calamine'],
  permethrin: ['permethrin'],
  clotrimazole: ['clotrimazole', 'candid'],
  albendazole: ['albendazole', 'deworm']
};
/** Every medicine the finder knows: supply catalogue plus retail items. */
export const MEDICINES = Object.fromEntries(
  Object.keys(ALIASES).map((id) => {
    const m = CATALOGUE[id] || RETAIL[id];
    return [id, { id, name: m.name, unit: m.unit }];
  })
);

/** Map a medicine name typed by the doctor to a known medicine id, or null. */
export function matchMedicine(name) {
  const text = ` ${String(name || '').toLowerCase().replace(/[^a-z0-9 -]+/g, ' ')} `;
  for (const [id, words] of Object.entries(ALIASES)) {
    if (words.some((w) => text.includes(` ${w}`))) return id;
  }
  return null;
}
const HWC_KIT = ['ors', 'zinc', 'pcm', 'ifa', 'amox', 'bcg', 'penta', 'clamps', 'gloves'];
const USE_PER_PATIENT = { ors: 0.0012, pcm: 0.001, zinc: 0.0007, ifa: 0.0006, amox: 0.0009, gloves: 0.0008, clamps: 0.0004 };

const CENTRE_DATA = {
  'phc-nallur': {
    doctors: [['Dr. S. Anitha', 'Medical officer', 'opd'], ['Dr. R. Karthik', 'Medical officer', 'opd'], ['Dr. M. Suresh', 'Medical officer (night duty)', 'off']],
    beds: { label: 'Inpatient beds', total: 6, occupied: 3 },
    newborn: { label: 'Newborn care corner', total: 2, occupied: 0 },
    waiting: 14,
    seenToday: 132,
    lambda: 0.22,
    stock: { ors: 0.36 }
  },
  'phc-pudupakkam': {
    doctors: [['Dr. K. Revathi', 'Medical officer', 'opd'], ['Dr. A. Imran', 'Medical officer', 'leave']],
    beds: { label: 'Inpatient beds', total: 6, occupied: 2 },
    newborn: { label: 'Newborn care corner', total: 2, occupied: 1 },
    waiting: 11,
    seenToday: 98,
    lambda: 0.15,
    stock: { vitk: 0.23 }
  },
  'chc-arasur': {
    doctors: [['Dr. N. Prakash', 'Paediatrician', 'nbsu'], ['Dr. J. Sangeetha', 'Obstetrician', 'opd'], ['Dr. T. Ravi', 'Medical officer', 'opd'], ['Dr. H. Nisha', 'Medical officer', 'opd'], ['Dr. G. Balaji', 'Anaesthetist', 'oncall'], ['Dr. C. Priya', 'Medical officer', 'off']],
    beds: { label: 'Inpatient beds', total: 30, occupied: 22 },
    newborn: { label: 'NBSU cots', total: 4, occupied: 2 },
    waiting: 24,
    seenToday: 236,
    lambda: 0.34,
    stock: { amox: 0.33 }
  },
  store: { doctors: [], stock: {} }
};

const HWC_STAFF = [['CHO', 'Community health officer'], ['ANM', 'Auxiliary nurse midwife']];
const HWC_NAMES = { CHO: ['Ms. Priya D', 'Mr. Arul S', 'Ms. Kavitha R', 'Ms. Nirmala J'], ANM: ['Ms. Sumathi K', 'Ms. Geetha P', 'Ms. Uma M', 'Ms. Latha V'] };

const FLEET_NAMES = {
  scooter: ['Karthik S', 'Arun P', 'Vignesh R', 'Sathish K', 'Nandhini M', 'Divya S', 'Manoj T', 'Faizal A', 'Joseph D', 'Gowtham V'],
  ambulance: [['AMB-07', '108 Unit 7', 'EMT Ramesh K, pilot Babu S'], ['AMB-12', '108 Unit 12', 'EMT Jansi R, pilot Kumar A']],
  van: [['VAN-02', 'Supply van 2', 'Driver Murugan P'], ['VAN-05', 'Supply van 5', 'Driver Senthil K']]
};

const AMBIENT = [...Array(6).fill('car'), ...Array(5).fill('auto'), 'bus', 'bus', ...Array(9).fill('scooter'), 'tractor', 'tractor', 'tractor', 'cart'];

export function createSim({ layout, network, traffic, rng, now = () => Date.now() }) {
  const listeners = new Map();
  const on = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  };
  const emit = (type, payload) => {
    for (const fn of listeners.get(type) || []) fn(payload);
  };

  let t = 0;
  let simMin = 0;
  let season = SEASONS.summer;
  let second = 0;
  const timers = [];
  const after = (seconds, fn) => timers.push({ at: t + seconds, fn });

  const buildings = new Map(layout.buildings.map((b) => [b.id, b]));
  const landmarks = new Map(layout.landmarks.map((l) => [l.id, l]));
  const zones = new Map(layout.zones.map((z) => [z.id, z]));
  const villages = new Map(layout.villages.map((v) => [v.id, v]));
  const houses = layout.buildings.filter((b) => b.kind === 'house');

  // ---- Centres (PHC, CHC, drug store) ---------------------------------------------------------
  const centres = new Map();
  for (const c of layout.centres) {
    const data = CENTRE_DATA[c.id];
    const stock = {};
    if (c.kind !== 'warehouse') {
      for (const id of Object.keys(CATALOGUE)) {
        if (id === 'asv' && c.kind !== 'chc') continue;
        stock[id] = data.stock[id] ?? range(rng, 0.48, 0.95);
      }
    }
    centres.set(c.id, {
      ...c,
      doctors: data.doctors.map(([name, role, status]) => ({ name, role, status })),
      beds: data.beds ? { ...data.beds } : null,
      newborn: data.newborn ? { ...data.newborn } : null,
      waiting: data.waiting || 0,
      seenToday: data.seenToday || 0,
      lambda: data.lambda || 0,
      waitMinutes: 0,
      stock,
      glow: 0,
      yardBusy: null
    });
  }
  const clinical = [...centres.values()].filter((c) => c.kind !== 'warehouse');
  const chc = clinical.find((c) => c.kind === 'chc');
  const store = [...centres.values()].find((c) => c.kind === 'warehouse');

  // ---- HWC sub-centres ------------------------------------------------------------------------
  const hwcs = new Map();
  layout.buildings
    .filter((b) => b.kind === 'hwc')
    .forEach((b, i) => {
      hwcs.set(b.id, {
        building: b,
        staff: HWC_STAFF.map(([role, title]) => ({ role, title, name: HWC_NAMES[role][i % 4], status: rng() < 0.75 ? 'present' : 'field' })),
        stock: { ors: range(rng, 0.3, 0.95), ifa: range(rng, 0.3, 0.95), pcm: range(rng, 0.3, 0.95) },
        seenToday: rangeInt(rng, 9, 26)
      });
    });

  // ---- Medicine sources: PHC pharmacies, sub-centres and medical shops (simulated stock) ----------
  // Stock for the medicine finder is counted in units. PHC supply items come from the centre's stock
  // fraction times its target; everything else is a count. A separate generator keeps the rest of the
  // simulation identical.
  const stockRng = mulberry32(0x5eed);
  const count = (lo, hi, pOut = 0) => (stockRng() < pOut ? 0 : rangeInt(stockRng, lo, hi));
  const HWC_SHARE = 0.06; // a sub-centre holds about this share of a PHC's target
  for (const c of clinical) c.extra = { cetirizine: count(30, 160, 0.1), calamine: count(4, 30, 0.2), albendazole: count(60, 400), clotrimazole: count(2, 20, 0.45), permethrin: count(2, 12, 0.55) };
  for (const h of hwcs.values()) h.extra = { zinc: count(4, 40, 0.2), cetirizine: count(5, 30, 0.35), calamine: count(1, 8, 0.5), albendazole: count(20, 120, 0.2) };
  const shops = new Map();
  for (const b of layout.buildings.filter((x) => x.kind === 'shop' && x.medical)) {
    shops.set(b.id, {
      building: b,
      stock: {
        pcm: count(6, 60, 0.05), ors: count(10, 120, 0.1), zinc: count(4, 30, 0.3), ifa: count(5, 40, 0.3), amox: count(4, 30, 0.25),
        cetirizine: count(10, 80, 0.1), calamine: count(3, 25, 0.2), permethrin: count(2, 15, 0.3), clotrimazole: count(3, 20, 0.2), albendazole: count(10, 90, 0.2)
      }
    });
  }
  const sources = [
    ...clinical.map((c) => ({
      id: `centre:${c.id}`,
      kind: 'phc',
      kindLabel: c.kind === 'chc' ? 'Block PHC pharmacy (24x7)' : 'PHC pharmacy',
      name: c.name,
      x: c.gate.x,
      z: c.gate.z,
      point: c.arrive,
      centre: c,
      units: (id) => (CATALOGUE[id] && c.stock[id] !== undefined ? Math.round(c.stock[id] * CATALOGUE[id].target) : c.extra[id] || 0),
      take: (id) => {
        if (CATALOGUE[id] && c.stock[id] !== undefined) c.stock[id] = Math.max(0, c.stock[id] - 1 / CATALOGUE[id].target);
        else if (c.extra[id]) c.extra[id] -= 1;
      }
    })),
    ...[...hwcs.values()].map((h) => ({
      id: `hwc:${h.building.id}`,
      kind: 'hwc',
      kindLabel: 'Sub-centre (HWC)',
      name: h.building.name,
      x: h.building.x,
      z: h.building.z,
      point: h.building.frontage,
      hwc: h,
      units: (id) => (h.stock[id] !== undefined ? Math.round(h.stock[id] * CATALOGUE[id].target * HWC_SHARE) : h.extra[id] || 0),
      take: (id) => {
        if (h.stock[id] !== undefined) h.stock[id] = Math.max(0, h.stock[id] - 1 / (CATALOGUE[id].target * HWC_SHARE));
        else if (h.extra[id]) h.extra[id] -= 1;
      }
    })),
    ...[...shops.values()].map((s) => ({
      id: `shop:${s.building.id}`,
      kind: 'shop',
      kindLabel: 'Medical shop (private)',
      name: s.building.name,
      x: s.building.x,
      z: s.building.z,
      point: s.building.frontage,
      shop: s,
      units: (id) => s.stock[id] || 0,
      take: (id) => {
        if (s.stock[id]) s.stock[id] -= 1;
      }
    }))
  ].filter((s) => s.point);
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  // ---- Fleet ----------------------------------------------------------------------------------
  const fleet = new Map();
  let scooterNo = 0;
  let ambulanceNo = 0;
  let vanNo = 0;
  for (const c of layout.centres) {
    for (const bay of c.bays) {
      let id;
      let name;
      let crew = null;
      if (bay.kind === 'scooter') {
        scooterNo += 1;
        id = `MC-${String(scooterNo).padStart(2, '0')}`;
        name = FLEET_NAMES.scooter[(scooterNo - 1) % FLEET_NAMES.scooter.length];
      } else if (bay.kind === 'ambulance') {
        [id, name, crew] = FLEET_NAMES.ambulance[ambulanceNo++ % 2];
      } else {
        [id, name, crew] = FLEET_NAMES.van[vanNo++ % 2];
      }
      const vehicle = traffic.addParked(bay.kind, bay, { id });
      fleet.set(id, {
        id,
        kind: bay.kind,
        name,
        crew,
        base: c.id,
        bay,
        status: 'idle',
        runId: null,
        kmToday: range(rng, 6, 22),
        deliveriesToday: rangeInt(rng, 3, 11),
        battery: bay.kind === 'scooter' ? rangeInt(rng, 55, 96) : null,
        coldBoxC: null,
        departSpot: null,
        lastOdo: 0,
        vehicle
      });
    }
  }

  // Village and town traffic.
  const laneIds = [...network.lanes.keys()];
  for (const kind of AMBIENT) {
    for (let tries = 0; tries < 40; tries++) {
      if (traffic.spawnOnLane(kind, pick(rng, laneIds), range(rng, 2, 12))) break;
    }
  }

  // ---- Runs, cases, history, alerts, KPIs -----------------------------------------------------
  const runs = new Map();
  const history = [];
  const cases = new Map(); // building id -> open case
  const closedCases = [];
  const alerts = [];
  const alertCooldown = new Map();
  let alertSeq = 0;
  let unread = 0;
  let medicineSeq = 2401;
  let referralSeq = 118;
  let indentSeq = 310;
  let caseSeq = 4101;

  // KPI history before the page opened (synthetic): arrivals over the last two simulated hours, and
  // recent delivery times.
  const arrivalsLog = [];
  for (let k = 0; k < 74; k++) arrivalsLog.push(-2 * HOUR_S + (k / 74) * HOUR_S);
  for (let k = 0; k < 86; k++) arrivalsLog.push(-HOUR_S + (k / 86) * HOUR_S);
  const deliveries = Array.from({ length: 12 }, () => ({ minutes: rangeInt(rng, 26, 38) }));
  const BASELINE_DELIVERY = 36;

  const minutesAgo = (m) => new Date(now() - m * 60000);
  const kmBetween = (a, b) => roadDistance(a, b) * KM_PER_UNIT;

  function roadDistance(a, b) {
    if (a.laneId === b.laneId && b.s > a.s) return b.s - a.s;
    const path = network.route(a.laneId, b.laneId) || [];
    let d = network.lanes.get(a.laneId).length - a.s;
    path.forEach((id, k) => {
      d += ROAD + (k === path.length - 1 ? b.s : network.lanes.get(id).length);
    });
    return d;
  }

  function baseRun(type, id, extra) {
    return {
      id,
      type,
      typeLabel: RUN_TYPES[type],
      steps: RUN_STEPS[type].map((label) => ({ label, at: null })),
      status: 0,
      vehicleId: null,
      items: [],
      value: 0,
      priority: 'routine',
      coldChain: false,
      boxTempC: null,
      waiting: null,
      etaMin: null,
      remainingKm: null,
      createdT: t,
      ...extra
    };
  }

  const destRef = (b) => ({ kind: 'building', id: b.id, name: b.name, x: b.x, z: b.z, top: b.h });

  function setStep(run, index, at = new Date(now())) {
    for (let k = 0; k <= index; k++) if (!run.steps[k].at) run.steps[k].at = at;
    run.status = index;
    emit('run:step', { run, index });
  }

  function glow(centre) {
    centre.glow = 1;
    emit('centre:glow', centre);
  }

  function complete(run, at) {
    runs.delete(run.id);
    run.doneT = t;
    history.unshift(run);
    if (history.length > 40) history.pop();
    emit('run:done', run);
    emit('burst', { run, ...at });
  }

  function addAlert({ key, level, icon, text, entity = null }) {
    if (key) {
      const last = alertCooldown.get(key);
      if (last !== undefined && t - last < 150) return;
      alertCooldown.set(key, t);
    }
    const alert = { id: `al${++alertSeq}`, level, icon, text, entity, at: new Date(now()), read: false };
    alerts.unshift(alert);
    if (alerts.length > 40) alerts.pop();
    unread += 1;
    emit('alert', alert);
  }

  // ---- Yard and kerb helpers ------------------------------------------------------------------
  const acquireExit = (centre, f) => (v) => {
    if (centre.yardBusy && centre.yardBusy !== f.id) return false;
    const spot = traffic.reserveCurb(centre.depart.laneId, centre.depart.s, v, { exact: true });
    if (!spot) return false;
    centre.yardBusy = f.id;
    f.departSpot = spot;
    return true;
  };
  const acquireEntry = (centre, f) => () => {
    if (centre.yardBusy && centre.yardBusy !== f.id) return false;
    centre.yardBusy = f.id;
    return true;
  };
  const releaseYard = (centre, f) => {
    if (centre.yardBusy === f.id) centre.yardBusy = null;
  };
  const exitPathTask = (centre, f) => ({
    type: 'path',
    points: (v) => {
      const k = traffic.kerbApproach(f.departSpot, v);
      return [...centre.exitPath(f.bay), k.footpath, k.turn, { x: k.kerb.x, z: k.kerb.z, heading: k.heading }];
    },
    end: () => ({ spot: f.departSpot })
  });
  const entryPathTask = (centre, f) => ({
    type: 'path',
    points: (v) => {
      const k = traffic.kerbApproach(v.curbSpot, v, { leaving: true });
      return [{ x: k.kerb.x, z: k.kerb.z }, { ...k.turn, heading: k.heading }, k.footpath, ...centre.entryPath(f.bay)];
    },
    end: 'parked'
  });
  const gateKerb = (centre) => (v) => traffic.reserveCurb(centre.arrive.laneId, centre.arrive.s, v, { exact: true });
  /**
   * Drive to a centre's gate kerb. When another vehicle holds it, wait at the centre's staging kerb one
   * junction upstream instead, so nobody holds the gate kerb for a whole drive across the block.
   */
  const driveToGate = (centre, extra = {}) => [
    { type: 'drive', target: (v) => gateKerb(centre)(v) || traffic.reserveCurb(centre.stage.laneId, centre.stage.s, v), ...extra },
    { type: 'drive', target: gateKerb(centre), skip: (v) => v.curbSpot?.laneId === centre.arrive.laneId }
  ];
  const returnToBase = (centre, f) => [
    { type: 'call', fn: () => (f.status = 'returning') },
    ...driveToGate(centre),
    { type: 'until', test: acquireEntry(centre, f) },
    entryPathTask(centre, f),
    {
      type: 'call',
      fn: () => {
        releaseYard(centre, f);
        f.status = 'idle';
        f.runId = null;
        f.coldBoxC = null;
      }
    }
  ];

  function nearestClinical(b) {
    let best = null;
    for (const c of clinical) {
      const d = Math.hypot(c.gate.x - b.x, c.gate.z - b.z);
      if (!best || d < best.d) best = { c, d };
    }
    return best.c;
  }

  // ---- Medicine runs (PHC or CHC pharmacy -> ASHA household or HWC, by courier) ----------------
  function createMedicineRun() {
    const busy = new Set([...runs.values()].map((r) => r.to.id));
    const candidates = layout.buildings.filter((b) => (b.kind === 'house' || b.kind === 'hwc') && !busy.has(b.id) && !cases.has(b.id));
    if (!candidates.length) return null;
    const dest = rng() < 0.3 ? pick(rng, candidates.filter((b) => b.kind === 'hwc').concat(candidates[0])) : pick(rng, candidates);
    const from = nearestClinical(dest);
    const isHwc = dest.kind === 'hwc';
    const kit = [...(isHwc ? HWC_KIT : ASHA_KIT)].sort(() => rng() - 0.5);
    const ids = kit.slice(0, rangeInt(rng, 2, isHwc ? 4 : 3));
    if (season.id === 'summer' && !ids.includes('ors') && rng() < 0.6) ids[0] = 'ors';
    const items = ids.map((id) => {
      const c = CATALOGUE[id];
      return { id, name: c.name, unit: c.unit, qty: pick(rng, c.packs), price: c.price, cold: Boolean(c.cold) };
    });
    const backdate = range(rng, 3, 6);
    const run = baseRun('medicine', `MR-${medicineSeq++}`, {
      items,
      value: Math.round(items.reduce((s, i) => s + i.qty * i.price, 0)),
      from: from.id,
      to: destRef(dest),
      coldChain: items.some((i) => i.cold),
      requester: isHwc ? `${dest.name} (CHO)` : `${dest.asha.name}, ${dest.asha.id}`,
      requestedSim: simMin - backdate,
      distanceKm: kmBetween(from.depart, dest.frontage)
    });
    run.steps[0].at = minutesAgo(backdate);
    runs.set(run.id, run);
    emit('run:new', run);
    after(1.4, () => {
      if (!runs.has(run.id)) return;
      setStep(run, 1, new Date(run.steps[0].at.getTime() + range(rng, 1, 2.5) * 60000));
      glow(from);
    });
    after(3.8, () => {
      if (!runs.has(run.id)) return;
      setStep(run, 2);
      assignCourier(run);
    });
    return run;
  }

  function assignCourier(run) {
    const centre = centres.get(run.from);
    const dest = buildings.get(run.to.id);
    const courier = [...fleet.values()].find((f) => f.kind === 'scooter' && f.base === centre.id && f.status === 'idle');
    if (!courier) {
      run.waiting = 'courier';
      return;
    }
    const v = courier.vehicle;
    const spot = traffic.reserveCurb(dest.frontage.laneId, dest.frontage.s, v);
    if (!spot) {
      run.waiting = 'kerb';
      return;
    }
    run.waiting = null;
    run.vehicleId = courier.id;
    courier.status = 'assigned';
    courier.runId = run.id;
    if (run.coldChain) courier.coldBoxC = range(rng, 3.8, 5.2);
    run.excursionAt = run.coldChain && rng() < 0.2 ? range(rng, 3, 8) : null;
    traffic.assign(v, [
      { type: 'until', test: acquireExit(centre, courier) },
      {
        type: 'call',
        fn: () => {
          setStep(run, 3);
          courier.status = 'en_route';
          run.departT = t;
        }
      },
      exitPathTask(centre, courier),
      { type: 'call', fn: () => releaseYard(centre, courier) },
      { type: 'drive', target: spot, onMerged: () => setStep(run, 4) },
      { type: 'call', fn: () => deliverMedicine(run, courier, centre, dest) },
      { type: 'wait', seconds: 1.1 },
      ...returnToBase(centre, courier)
    ]);
  }

  function deliverMedicine(run, courier, centre, dest) {
    setStep(run, 5);
    run.durationMin = Math.max(6, Math.round(simMin - run.requestedSim));
    deliveries.push({ minutes: run.durationMin });
    if (deliveries.length > 40) deliveries.shift();
    courier.deliveriesToday += 1;
    for (const item of run.items) {
      if (centre.stock[item.id] !== undefined) centre.stock[item.id] = clamp(centre.stock[item.id] - item.qty / CATALOGUE[item.id].target, 0, 1);
    }
    const hwc = hwcs.get(dest.id);
    if (hwc) for (const item of run.items) if (hwc.stock[item.id] !== undefined) hwc.stock[item.id] = range(rng, 0.85, 1);
    complete(run, { x: dest.x, z: dest.z, y: dest.h });
  }

  // ---- Prescription deliveries: find medicines, plan the pickups, one bike collects and delivers -----
  // Only medicines the doctor prescribed are looked up; stock is simulated demo stock.
  const LOW_UNITS = 5;
  let rxSeq = 501;

  /** Every source with its stock of each prescribed medicine and its road distance to the patient. */
  function findMedicineSources(names, homeId) {
    const home = buildings.get(homeId);
    const wanted = names.map((name) => ({ name, id: matchMedicine(name) }));
    return sources
      .map((src) => {
        const rows = wanted.map((w) => {
          const units = w.id ? Math.max(0, src.units(w.id)) : 0;
          return { name: w.name, id: w.id, medicine: w.id ? MEDICINES[w.id].name : null, unit: w.id ? MEDICINES[w.id].unit : null, units, level: units <= 0 ? 'out' : units < LOW_UNITS ? 'low' : 'ok' };
        });
        const covered = rows.filter((r) => r.units > 0).length;
        return { id: src.id, kind: src.kind, kindLabel: src.kindLabel, name: src.name, x: src.x, z: src.z, km: home ? kmBetween(src.point, home.frontage) : null, rows, covered, total: wanted.length };
      })
      .sort((a, b) => b.covered - a.covered || a.km - b.km);
  }

  /** Road distance (units) for one leg; a stop at the courier's own base costs nothing. */
  function legUnits(from, src, base) {
    if (src.centre && src.centre === base) return 0;
    return roadDistance(from, src.point);
  }

  /**
   * Plan one bike's pickup round for a prescription. Without `stopIds` it suggests the fewest places
   * nearest the patient that together have every medicine. Each medicine comes from the chosen place
   * nearest the patient that has it. The nearest idle bike collects in nearest-next order.
   */
  function planPickup(names, homeId, stopIds = null, courierId = null) {
    const home = buildings.get(homeId);
    const found = findMedicineSources(names, homeId);
    const wanted = [...new Set(names.map(matchMedicine).filter(Boolean))];
    const has = (f, id) => f.rows.some((r) => r.id === id && r.units > 0);
    let chosen;
    if (stopIds) {
      chosen = stopIds.map((id) => found.find((f) => f.id === id)).filter(Boolean);
    } else {
      chosen = [];
      const need = new Set(wanted.filter((id) => found.some((f) => has(f, id))));
      while (need.size) {
        let best = null;
        let bestN = 0;
        for (const f of found) {
          if (chosen.includes(f)) continue;
          const n = [...need].filter((id) => has(f, id)).length;
          if (n > bestN || (n === bestN && n > 0 && f.km < best.km)) {
            best = f;
            bestN = n;
          }
        }
        if (!best) break;
        chosen.push(best);
        for (const id of wanted) if (has(best, id)) need.delete(id);
      }
    }
    const assigned = new Map();
    for (const id of wanted) {
      const f = chosen.filter((c) => has(c, id)).sort((a, b) => a.km - b.km)[0];
      if (!f) continue;
      if (!assigned.has(f.id)) assigned.set(f.id, []);
      assigned.get(f.id).push(id);
    }
    const covered = new Set([...assigned.values()].flat());
    const missing = names.filter((n) => {
      const id = matchMedicine(n);
      return !id || !covered.has(id);
    });
    const stops = chosen.filter((c) => assigned.has(c.id)).map((c) => sourceById.get(c.id));

    const idle = [...fleet.values()].filter((f) => f.kind === 'scooter' && f.status === 'idle');
    let courier = courierId && idle.find((f) => f.id === courierId);
    if (!courier && stops.length) {
      let best = Infinity;
      for (const f of idle) {
        const base = centres.get(f.base);
        for (const s of stops) {
          const d = legUnits(base.depart, s, base);
          if (d < best) {
            best = d;
            courier = f;
          }
        }
      }
    }
    const base = courier ? centres.get(courier.base) : null;
    const ordered = [];
    const legs = [];
    if (base) {
      const rest = [...stops];
      let at = base.depart;
      // Stops at the bike's own base are collected before it leaves.
      for (const s of rest.filter((x) => x.centre === base)) {
        ordered.push(s);
        legs.push(0);
      }
      const away = rest.filter((x) => x.centre !== base);
      while (away.length) {
        away.sort((a, b) => roadDistance(at, a.point) - roadDistance(at, b.point));
        const s = away.shift();
        legs.push(roadDistance(at, s.point));
        at = s.point;
        ordered.push(s);
      }
      legs.push(roadDistance(at, home.frontage));
    } else {
      ordered.push(...stops);
    }
    const distanceKm = legs.reduce((s, u) => s + u, 0) * KM_PER_UNIT;
    const kmh = SPEED_KMH.scooter * season.speed;
    return {
      homeId,
      names,
      stops: ordered.map((s) => {
        const f = found.find((x) => x.id === s.id);
        return { id: s.id, name: s.name, kind: s.kind, kindLabel: s.kindLabel, km: f.km, atBase: Boolean(base && s.centre === base), items: assigned.get(s.id).map((id) => ({ id, name: MEDICINES[id].name, unit: MEDICINES[id].unit })) };
      }),
      legs,
      courier: courier ? { id: courier.id, name: courier.name, base: base.name, baseId: base.id } : null,
      distanceKm,
      etaMin: base ? Math.max(3, Math.round((distanceKm / kmh) * 60 + ordered.length * 2 + 2)) : null,
      missing
    };
  }

  /** Lane points along the road from one kerb point to another (for drawing a planned route). */
  function routePoints(a, b) {
    const laneA = network.lanes.get(a.laneId);
    const pts = [network.pointOnLane(laneA, a.s, 0)];
    if (a.laneId === b.laneId && b.s > a.s) {
      pts.push(network.pointOnLane(laneA, b.s, 0));
      return pts;
    }
    pts.push(laneA.end);
    const path = network.route(a.laneId, b.laneId) || [];
    path.forEach((id, k) => {
      const lane = network.lanes.get(id);
      pts.push(lane.start);
      pts.push(k === path.length - 1 ? network.pointOnLane(lane, b.s, 0) : lane.end);
    });
    return pts.map((p) => ({ x: p.x, z: p.z }));
  }

  /** Points of a planned pickup round: bike base, each stop, the patient's home. */
  function planRoute(plan) {
    const home = buildings.get(plan.homeId);
    if (!plan.courier || !home) return [];
    let at = centres.get(plan.courier.baseId).depart;
    const pts = [];
    for (const s of plan.stops) {
      const src = sourceById.get(s.id);
      if (s.atBase) continue;
      pts.push(...routePoints(at, src.point));
      at = src.point;
    }
    pts.push(...routePoints(at, home.frontage));
    return pts;
  }

  /**
   * Start a prescription delivery: one bike collects from every stop, then rides to the patient.
   * `stopIds` and `courierId` come from the doctor's choice (or a saved dispatch after a reload).
   */
  function dispatchPrescription({ caseId, homeId, names, stopIds, courierId = null, patientName = null, doctorName = null }) {
    const home = buildings.get(homeId);
    if (!home) return null;
    const plan = planPickup(names, homeId, stopIds, courierId);
    if (!plan.stops.length) return null;
    const run = baseRun('prescription', `RX-${rxSeq++}`, {
      caseId,
      from: plan.courier?.baseId || nearestClinical(home).id,
      to: destRef(home),
      items: plan.stops.flatMap((s) => s.items.map((i) => ({ ...i, qty: 1, from: s.name }))),
      stops: plan.stops.map((s) => ({ ...s, collectedAt: null })),
      missing: plan.missing,
      legs: plan.legs,
      leg: -1,
      courierId: plan.courier?.id || null,
      patientName,
      requester: doctorName || 'Doctor',
      requestedSim: simMin,
      distanceKm: plan.distanceKm,
      etaMin: plan.etaMin
    });
    runs.set(run.id, run);
    emit('run:new', run);
    after(0.8, () => startRxRide(run));
    return run;
  }

  function startRxRide(run) {
    if (!runs.has(run.id) || run.vehicleId) return;
    const idle = [...fleet.values()].filter((f) => f.kind === 'scooter' && f.status === 'idle');
    let courier = idle.find((f) => f.id === run.courierId);
    if (!courier) {
      const plan = planPickup(run.stops.flatMap((s) => s.items.map((i) => i.name)), run.to.id, run.stops.map((s) => s.id));
      courier = plan.courier && fleet.get(plan.courier.id);
      if (courier) {
        run.stops = plan.stops.map((s) => ({ ...s, collectedAt: null }));
        run.legs = plan.legs;
        run.distanceKm = plan.distanceKm;
        run.from = courier.base;
      }
    }
    if (!courier) {
      run.waiting = 'courier';
      return;
    }
    run.waiting = null;
    run.vehicleId = courier.id;
    run.courierId = courier.id;
    courier.status = 'assigned';
    courier.runId = run.id;
    setStep(run, 1);
    const base = centres.get(courier.base);
    const home = buildings.get(run.to.id);
    const collect = (stop) => ({
      type: 'call',
      fn: () => {
        const src = sourceById.get(stop.id);
        for (const item of stop.items) src.take(item.id);
        stop.collectedAt = new Date(now());
        run.leg += 1;
        if (src.centre) glow(src.centre);
        emit('prescription:collect', { run, stop });
        if (run.stops.every((s) => s.collectedAt)) setStep(run, 3);
        else emit('run:step', { run, index: run.status });
      }
    });
    const tasks = [
      { type: 'until', test: acquireExit(base, courier) },
      ...run.stops.filter((s) => s.atBase).map(collect),
      {
        type: 'call',
        fn: () => {
          if (run.status < 2) setStep(run, run.stops.every((s) => s.collectedAt) ? 3 : 2);
          courier.status = 'en_route';
          run.departT = t;
        }
      },
      exitPathTask(base, courier),
      { type: 'call', fn: () => releaseYard(base, courier) }
    ];
    for (const stop of run.stops.filter((s) => !s.atBase)) {
      const src = sourceById.get(stop.id);
      tasks.push({ type: 'drive', target: (v) => traffic.reserveCurb(src.point.laneId, src.point.s, v) }, { type: 'wait', seconds: 1.4 }, collect(stop));
    }
    tasks.push(
      { type: 'drive', target: (v) => traffic.reserveCurb(home.frontage.laneId, home.frontage.s, v), onMerged: () => setStep(run, 4) },
      {
        type: 'call',
        fn: () => {
          setStep(run, 5);
          run.durationMin = Math.max(5, Math.round(simMin - run.requestedSim));
          courier.deliveriesToday += 1;
          complete(run, { x: home.x, z: home.z, y: home.h });
          emit('prescription:done', run);
        }
      },
      { type: 'wait', seconds: 1.1 },
      ...returnToBase(base, courier)
    );
    traffic.assign(courier.vehicle, tasks);
  }

  // ---- Home-visit cases -----------------------------------------------------------------------
  function openCase(level, home = null) {
    if (!home) {
      const busy = new Set([...runs.values()].map((r) => r.to.id));
      const free = houses.filter((b) => !cases.has(b.id) && !busy.has(b.id));
      if (!free.length) return null;
      home = pick(rng, free);
    }
    const flaggedAgo = range(rng, 2, level === 'URGENT' ? 6 : 50);
    const c = {
      id: `AV-${caseSeq++}`,
      buildingId: home.id,
      zone: home.zone,
      level,
      ageDays: rangeInt(rng, 1, 59),
      asha: home.asha,
      flaggedAt: minutesAgo(flaggedAgo),
      status: 'open',
      openedT: t,
      reviewAt: level === 'PRIORITY' ? t + range(rng, 45, 90) : null,
      runId: null
    };
    cases.set(home.id, c);
    emit('case:open', c);
    if (level === 'URGENT') {
      addAlert({
        key: `case:${c.id}`,
        level: 'error',
        icon: 'warning',
        text: `${c.id}: ${c.asha.name} flagged danger signs in a ${c.ageDays}-day-old at ${home.name}. Urgent: refer now.`,
        entity: { type: 'building', id: home.id }
      });
      startReferral(c);
    }
    return c;
  }

  function closeCase(c, outcome) {
    if (cases.get(c.buildingId) !== c) return;
    cases.delete(c.buildingId);
    c.status = outcome;
    c.closedT = t;
    c.closedAt = new Date(now());
    closedCases.unshift(c);
    if (closedCases.length > 30) closedCases.pop();
    emit('case:close', c);
  }

  function escalate(c) {
    c.level = 'URGENT';
    c.reviewAt = null;
    c.escalated = true;
    const home = buildings.get(c.buildingId);
    emit('case:open', c);
    addAlert({ key: `case:${c.id}`, level: 'error', icon: 'warning', text: `${c.id} escalated: a danger sign was reported on the follow-up visit at ${home.name}. Urgent: refer now.`, entity: { type: 'building', id: home.id } });
    startReferral(c);
  }

  function tickCases() {
    for (const c of [...cases.values()]) {
      if (c.external) continue; // real cases are closed by the doctor, never by the simulation
      if (c.level === 'PRIORITY') {
        if (t >= c.reviewAt) closeCase(c, rng() < 0.75 ? 'Home care with follow-up' : 'Asked to visit the PHC');
        else if (rng() < 0.0008 && urgentOpen() < MAX_URGENT_OPEN) escalate(c);
      } else if (c.level === 'URGENT' && !c.runId) {
        startReferral(c);
      }
    }
  }

  function urgentOpen() {
    let n = 0;
    for (const c of cases.values()) if (c.level === 'URGENT' && !c.external) n += 1;
    return n;
  }

  function simulatedOpen() {
    let n = 0;
    for (const c of cases.values()) if (!c.external) n += 1;
    return n;
  }

  // ---- Real cases from the ASHA app (doctor queue) ----------------------------------------------
  // Mirrored onto a home in the ASHA's village so the lead doctor sees them on the map. Their level comes
  // from the server's rules-based triage and is only displayed here: the simulation never sends an
  // ambulance for them, never escalates or lowers them, and they close only when the doctor has replied.
  const hashString = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  const norm = (s) => String(s || '').trim().toLowerCase();

  function villageFor(ext) {
    const byName = [...villages.values()].find((v) => norm(v.name) === norm(ext.village));
    if (byName) return byName;
    const byAsha = [...villages.values()].find((v) => v.asha.some((a) => a.id === ext.workerId));
    return byAsha || villages.get('arasur');
  }

  function homeFor(ext, village) {
    const busy = new Set([...runs.values()].map((r) => r.to.id));
    const free = (list) => list.filter((b) => !cases.has(b.id) && !busy.has(b.id));
    let options = free(village.houses.map((id) => buildings.get(id)));
    if (!options.length) options = free(houses);
    if (!options.length) return null;
    return options[hashString(ext.id) % options.length];
  }

  /** Home of a real case: where it is (or was) on the map, else a stable home in its village. */
  function homeOf(ext) {
    const known = [...cases.values(), ...closedCases].find((c) => c.external && c.id === ext.id);
    if (known) return buildings.get(known.buildingId) || null;
    const village = villageFor(ext);
    const list = village.houses.length ? village.houses : houses.map((b) => b.id);
    return buildings.get(list[hashString(ext.id) % list.length]) || null;
  }

  /** Make the map's real cases match `list` (open cases from GET /api/doctor/cases). */
  function syncExternalCases(list) {
    const seen = new Set();
    for (const ext of list) {
      seen.add(ext.id);
      const existing = [...cases.values()].find((c) => c.external && c.id === ext.id);
      if (existing) {
        Object.assign(existing, { patient: ext.patient, reasons: ext.reasons, caseStatus: ext.status, aiStatus: ext.aiStatus, hasPhoto: ext.hasPhoto, hasAudio: ext.hasAudio });
        if (existing.level !== ext.level) {
          existing.level = ext.level;
          emit('case:open', existing);
        }
        continue;
      }
      const village = villageFor(ext);
      const home = homeFor(ext, village);
      if (!home) continue;
      const c = {
        id: ext.id,
        label: `ASHA-${ext.id.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()}`,
        external: true,
        buildingId: home.id,
        zone: home.zone,
        level: ext.level,
        asha: { id: ext.workerId, name: ext.workerName || 'ASHA worker' },
        flaggedAt: new Date(ext.receivedAt || now()),
        status: 'open',
        openedT: t,
        reviewAt: null,
        runId: null,
        patient: ext.patient || null,
        reasons: ext.reasons || [],
        caseStatus: ext.status,
        aiStatus: ext.aiStatus,
        hasPhoto: Boolean(ext.hasPhoto),
        hasAudio: Boolean(ext.hasAudio)
      };
      cases.set(home.id, c);
      emit('case:open', c);
      if (c.level === 'URGENT') {
        addAlert({ key: `case:${c.id}`, level: 'error', icon: 'warning', text: `${c.label}: ${c.asha.name} sent an urgent case from ${village.name}. It is in the doctor queue.`, entity: { type: 'building', id: home.id } });
      }
    }
    for (const c of [...cases.values()]) {
      if (c.external && !seen.has(c.id)) closeCase(c, 'Doctor replied');
    }
  }

  // ---- Urgent infant referrals (home -> CHC, by 108 ambulance) --------------------------------
  function startReferral(c) {
    const amb = [...fleet.values()].find((f) => f.kind === 'ambulance' && f.status === 'idle');
    const home = buildings.get(c.buildingId);
    if (!chc || !amb) return null;
    const v = amb.vehicle;
    const spot = traffic.reserveCurb(home.frontage.laneId, home.frontage.s, v);
    if (!spot) return null;
    const flaggedAgo = Math.max(1, (now() - c.flaggedAt.getTime()) / 60000);
    const run = baseRun('referral', `RF-${referralSeq++}`, {
      priority: 'urgent',
      level: 'URGENT',
      caseId: c.id,
      from: chc.id,
      to: destRef(home),
      vehicleId: amb.id,
      patient: { label: `Young infant, ${c.ageDays} days`, ageDays: c.ageDays },
      requester: `${c.asha.name}, ${c.asha.id}`,
      requestedSim: simMin - flaggedAgo,
      distanceKm: kmBetween(chc.depart, home.frontage) + kmBetween(home.frontage, chc.arrive),
      legBUnits: roadDistance(home.frontage, chc.arrive)
    });
    run.steps[0].at = c.flaggedAt;
    c.runId = run.id;
    runs.set(run.id, run);
    amb.status = 'assigned';
    amb.runId = run.id;
    emit('run:new', run);
    after(1.5, () => setStep(run, 1, minutesAgo(Math.max(0.5, flaggedAgo - 1))));
    traffic.assign(v, [
      { type: 'until', test: acquireExit(chc, amb) },
      {
        type: 'call',
        fn: () => {
          setStep(run, 2);
          amb.status = 'responding';
          v.emergency = true;
        }
      },
      exitPathTask(chc, amb),
      { type: 'call', fn: () => releaseYard(chc, amb) },
      { type: 'drive', target: spot },
      { type: 'wait', seconds: 2.6 },
      {
        type: 'call',
        fn: () => {
          setStep(run, 3);
          amb.status = 'transporting';
          closeCase(c, 'Referred to PHC Jamunamarathur by 108');
          emit('pickup', run);
        }
      },
      ...driveToGate(chc, { onMerged: () => setStep(run, 4) }),
      {
        type: 'call',
        fn: () => {
          setStep(run, 5);
          v.emergency = false;
          run.durationMin = Math.max(8, Math.round(simMin - run.requestedSim));
          chc.newborn.occupied = Math.min(chc.newborn.total, chc.newborn.occupied + 1);
          amb.deliveriesToday += 1;
          complete(run, { x: chc.gate.x, z: chc.gate.z, y: 1 });
        }
      },
      // Already at the CHC kerb: skip the drive back and go straight into the bay.
      ...returnToBase(chc, amb).slice(3)
    ]);
    return run;
  }

  // ---- Restocks (block drug store -> PHC or CHC, by van) --------------------------------------
  function createRestock(centre, itemIds) {
    const van = [...fleet.values()].find((f) => f.kind === 'van' && f.status === 'idle');
    if (!store || !van) return null;
    const items = itemIds.map((id) => {
      const c = CATALOGUE[id];
      return { id, name: c.name, unit: c.unit, qty: Math.max(c.packs[0], Math.round((c.target * (1 - centre.stock[id])) / 10) * 10), price: c.price, cold: Boolean(c.cold) };
    });
    const indentAgo = range(rng, 12, 25);
    const run = baseRun('restock', `IN-${indentSeq++}`, {
      items,
      value: Math.round(items.reduce((s, i) => s + i.qty * i.price, 0)),
      from: store.id,
      to: { kind: 'centre', id: centre.id, name: centre.name, x: centre.gate.x, z: centre.gate.z, top: centre.main.h },
      vehicleId: van.id,
      coldChain: items.some((i) => i.cold),
      requester: `${centre.name} pharmacist`,
      requestedSim: simMin - indentAgo,
      distanceKm: kmBetween(store.depart, centre.dock)
    });
    run.steps[0].at = minutesAgo(indentAgo);
    runs.set(run.id, run);
    van.status = 'loading';
    van.runId = run.id;
    if (run.coldChain) van.coldBoxC = range(rng, 3.6, 5);
    emit('run:new', run);
    after(2, () => {
      setStep(run, 1, minutesAgo(range(rng, 3, 6)));
      glow(store);
    });
    after(4.5, () => {
      setStep(run, 2);
      traffic.assign(van.vehicle, [
        { type: 'until', test: acquireExit(store, van) },
        {
          type: 'call',
          fn: () => {
            setStep(run, 3);
            van.status = 'en_route';
            run.departT = t;
          }
        },
        exitPathTask(store, van),
        { type: 'call', fn: () => releaseYard(store, van) },
        { type: 'drive', target: (veh) => traffic.reserveCurb(centre.dock.laneId, centre.dock.s, veh, { exact: true }), onMerged: () => setStep(run, 4) },
        {
          type: 'call',
          fn: () => {
            setStep(run, 5);
            run.durationMin = Math.max(10, Math.round(simMin - run.requestedSim));
            for (const item of run.items) centre.stock[item.id] = range(rng, 0.9, 1);
            van.deliveriesToday += 1;
            glow(centre);
            complete(run, { x: centre.gate.x, z: centre.gate.z, y: 1 });
          }
        },
        { type: 'wait', seconds: 2 },
        ...returnToBase(store, van)
      ]);
    });
    return run;
  }

  function checkRestock() {
    for (const c of clinical) {
      if ([...runs.values()].some((r) => r.type === 'restock' && r.to.id === c.id)) continue;
      const low = Object.entries(c.stock)
        .filter(([, level]) => level < 0.3)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([id]) => id);
      if (low.length && createRestock(c, low)) return;
    }
  }

  // ---- Per-second updates ---------------------------------------------------------------------
  function tickCentres() {
    for (const c of clinical) {
      const opd = c.doctors.filter((d) => d.status === 'opd').length;
      let lambda = c.lambda * season.demand;
      if (season.id === 'festival' && c.id === 'phc-nallur') lambda *= 1.4;
      if (c.waiting > 30) lambda *= 0.75; // long queues send some people elsewhere
      const arrivals = poisson(rng, lambda);
      const served = Math.min(c.waiting + arrivals, poisson(rng, opd * SERVICE_RATE * (c.waiting > 28 ? 1.15 : 1)));
      c.waiting += arrivals - served;
      c.seenToday += served;
      for (let k = 0; k < arrivals; k++) arrivalsLog.push(t);
      for (const [id, use] of Object.entries(USE_PER_PATIENT)) {
        if (c.stock[id] !== undefined) c.stock[id] = Math.max(0, c.stock[id] - use * served * range(rng, 0.5, 1.5));
      }
      c.waitMinutes = opd ? Math.round(c.waiting / ((opd * SERVICE_RATE) / SIM_MINUTES_PER_SECOND)) : null;
      if (c.beds && rng() < 0.08) {
        const target = Math.round(c.beds.total * 0.7);
        const up = rng() < (c.beds.occupied < target ? 0.65 : 0.35);
        c.beds.occupied = clamp(c.beds.occupied + (up ? 1 : -1), 0, c.beds.total);
      }
      if (c.newborn && c.newborn.occupied > 0 && rng() < 0.012) c.newborn.occupied -= 1;
      c.glow = Math.max(0, c.glow - 0.25);

      for (const [id, level] of Object.entries(c.stock)) {
        if (level >= 0.25) continue;
        const critical = level < 0.12;
        addAlert({
          key: `low:${c.id}:${id}`,
          level: critical ? 'error' : 'warning',
          icon: 'medication',
          text: `${critical ? 'Stock-out risk' : 'Low stock'}: ${CATALOGUE[id].name} at ${c.name} (${Math.round(level * 100)}%).`,
          entity: { type: 'centre', id: c.id }
        });
      }
      if (c.waiting > 28) {
        addAlert({ key: `wait:${c.id}`, level: 'warning', icon: 'groups', text: `${c.waiting} patients waiting at ${c.name}, about ${c.waitMinutes ?? '?'} min.`, entity: { type: 'centre', id: c.id } });
      }
      if (opd === 0 && c.kind === 'phc') {
        addAlert({ key: `nodoc:${c.id}`, level: 'warning', icon: 'stethoscope', text: `No doctor in OPD at ${c.name} right now.`, entity: { type: 'centre', id: c.id } });
      }
      if (c.newborn && c.newborn.occupied >= c.newborn.total && c.kind === 'chc') {
        addAlert({ key: `nbsu:${c.id}`, level: 'error', icon: 'bed', text: `${c.newborn.label} at ${c.name} are full (${c.newborn.occupied} of ${c.newborn.total}).`, entity: { type: 'centre', id: c.id } });
      }
    }
    if (rng() < 0.1) {
      const c = pick(rng, clinical);
      const movable = c.doctors.filter((d) => ['opd', 'rounds', 'break'].includes(d.status));
      if (movable.length) {
        const d = pick(rng, movable);
        const inOpd = c.doctors.filter((x) => x.status === 'opd').length;
        // Doctors step away only when the queue is short, and come back to OPD when it grows.
        if (d.status === 'opd' && inOpd > 1 && c.waiting < 16) d.status = rng() < 0.6 ? 'rounds' : 'break';
        else if (d.status !== 'opd') d.status = 'opd';
      }
    }
    for (const c of clinical) {
      if (c.waiting <= 20) continue;
      const away = c.doctors.find((d) => d.status === 'break' || d.status === 'rounds');
      if (away && rng() < 0.2) away.status = 'opd';
    }
    // HWC staff go on field visits and come back; stock is used through the day.
    for (const h of hwcs.values()) {
      for (const s of h.staff) {
        if (s.status === 'present' && rng() < 0.012) s.status = 'field';
        else if (s.status === 'field' && rng() < 0.03) s.status = 'present';
      }
      if (rng() < 0.15) h.seenToday += 1;
      for (const id of Object.keys(h.stock)) h.stock[id] = Math.max(0.05, h.stock[id] - range(rng, 0, 0.002));
      if (h.staff.every((s) => s.status !== 'present')) {
        addAlert({ key: `hwc:${h.building.id}`, level: 'warning', icon: 'local_hospital', text: `${h.building.name}: both CHO and ANM are on field visits. Calls go to ${nearestClinical(h.building).name}.`, entity: { type: 'building', id: h.building.id } });
      }
    }
  }

  function tickRuns() {
    for (const run of runs.values()) {
      if (run.waiting === 'courier' || run.waiting === 'kerb') (run.type === 'prescription' ? startRxRide(run) : assignCourier(run));
      const f = run.vehicleId ? fleet.get(run.vehicleId) : null;
      if (f && run.coldChain && run.status >= 3 && run.status < 5 && f.coldBoxC !== null) {
        const since = run.departT !== undefined ? t - run.departT : 0;
        const excursion = run.excursionAt !== null && run.excursionAt !== undefined && since > run.excursionAt && since < run.excursionAt + 7;
        f.coldBoxC += ((excursion ? 8.7 : 4.6) - f.coldBoxC) * 0.35 + range(rng, -0.12, 0.12);
        run.boxTempC = f.coldBoxC;
        if (f.coldBoxC > 8) {
          addAlert({ key: `cold:${run.id}`, level: 'error', icon: 'device_thermostat', text: `Cold chain: ${run.id} box at ${f.coldBoxC.toFixed(1)} °C, above 8 °C. Ask ${f.name} to check the cold box.`, entity: { type: 'vehicle', id: f.id } });
        }
      }
      refreshEta(run, f);
    }
  }

  function refreshEta(run, f) {
    const kind = f?.kind || 'scooter';
    const kmh = SPEED_KMH[kind] * season.speed;
    let units = null;
    const v = f?.vehicle;
    if (v && (v.target || v.task?.spot)) units = traffic.remainingDistance(v);
    let prep = 0;
    if (run.type === 'prescription') {
      // Remaining legs after the one being driven now (each collection moves `leg` on by one).
      const legs = run.legs || [];
      const next = run.leg + 1;
      const rest = legs.slice(next + (units === null ? 0 : 1)).reduce((s, u) => s + u, 0);
      if (units === null) {
        units = rest;
        prep = run.status < 2 ? 2 : 0;
      } else {
        units += rest;
      }
      prep += run.stops.filter((s) => !s.collectedAt).length * 1.5;
    } else if (units === null) {
      units = run.distanceKm / KM_PER_UNIT;
      prep = run.type === 'medicine' ? Math.max(1, 6 - 2 * run.status) : run.type === 'restock' ? 6 : 2;
    } else if (run.type === 'referral' && run.status < 3) {
      units += run.legBUnits + 6;
    }
    run.remainingKm = units * KM_PER_UNIT;
    run.etaMin = run.status >= 5 ? 0 : Math.max(1, Math.round((run.remainingKm / kmh) * 60 + prep));
  }

  let nextMedicine = 6;
  let nextCase = 9;
  let nextRestock = 7;
  after(0.6, createMedicineRun);
  after(1.9, createMedicineRun);
  after(3.2, createMedicineRun);
  // Cases already open when the shift view starts.
  for (let k = 0; k < 7; k++) openCase('PRIORITY');
  after(0.8, () => openCase('URGENT'));

  function scheduleRequests() {
    if (t >= nextMedicine) {
      if ([...runs.values()].filter((r) => r.type === 'medicine').length < MAX_MEDICINE_RUNS) createMedicineRun();
      nextMedicine = t + range(rng, 7, 12) / season.demand;
    }
    if (t >= nextCase) {
      if (simulatedOpen() < MAX_OPEN_CASES) openCase(rng() < 0.15 && urgentOpen() < MAX_URGENT_OPEN ? 'URGENT' : 'PRIORITY');
      nextCase = t + range(rng, 6, 11) / season.demand;
    }
    if (t >= nextRestock) {
      checkRestock();
      nextRestock = t + 5;
    }
  }

  function step(dt) {
    t += dt;
    simMin += dt * SIM_MINUTES_PER_SECOND;
    traffic.step(dt);
    for (let i = 0; i < timers.length; i++) {
      if (timers[i].at <= t) {
        const [timer] = timers.splice(i, 1);
        i -= 1;
        timer.fn();
      }
    }
    for (const f of fleet.values()) {
      const moved = f.vehicle.odometer - f.lastOdo;
      f.lastOdo = f.vehicle.odometer;
      if (moved > 0) {
        f.kmToday += moved * KM_PER_UNIT;
        if (f.battery !== null) f.battery = Math.max(12, f.battery - moved * KM_PER_UNIT * 0.55);
      } else if (f.status === 'idle' && f.battery !== null) {
        f.battery = Math.min(100, f.battery + dt * 0.3);
      }
    }
    scheduleRequests();
    second += dt;
    if (second >= 1) {
      second -= 1;
      tickCentres();
      tickCases();
      tickRuns();
    }
  }

  function setSeason(id) {
    season = SEASONS[id] || SEASONS.summer;
    traffic.setSpeedFactor(season.speed);
    if (season.id === 'monsoon') {
      addAlert({ key: 'season:monsoon', level: 'warning', icon: 'rainy', text: 'Athipattu Road is waterlogged near Athipattu. Expect slower runs; couriers are in rain gear.', entity: { type: 'village', id: 'vallam' } });
    } else if (season.id === 'festival') {
      addAlert({ key: 'season:festival', level: 'info', icon: 'celebration', text: 'Temple festival in Pudurnadu tonight. Expect more patients at PHC Pudurnadu.', entity: { type: 'landmark', id: 'temple' } });
    } else {
      addAlert({ key: 'season:summer', level: 'info', icon: 'sunny', text: 'Heat advisory: expect more ORS requests from ASHA workers today.', entity: null });
    }
    emit('season', season);
  }

  function kpis() {
    const start = t - HOUR_S;
    while (arrivalsLog.length && arrivalsLog[0] < t - 2 * HOUR_S) arrivalsLog.shift();
    let current = 0;
    let previous = 0;
    const spark = new Array(12).fill(0);
    for (const a of arrivalsLog) {
      if (a >= start) {
        current += 1;
        spark[Math.min(11, Math.floor((a - start) / (HOUR_S / 12)))] += 1;
      } else {
        previous += 1;
      }
    }
    const recent = deliveries.slice(-12);
    const avg = recent.reduce((s, d) => s + d.minutes, 0) / recent.length;
    const doctors = clinical.flatMap((c) => c.doctors);
    const open = [...cases.values()];
    return {
      patients: { value: current, delta: previous ? (current - previous) / previous : 0, spark },
      delivery: { value: Math.round(avg), delta: (avg - BASELINE_DELIVERY) / BASELINE_DELIVERY, spark: recent.map((d) => d.minutes) },
      doctors: { onDuty: doctors.filter((d) => ON_DUTY.has(d.status)).length, inOpd: doctors.filter((d) => d.status === 'opd').length, total: doctors.length },
      cases: {
        urgent: open.filter((c) => c.level === 'URGENT').length,
        priority: open.filter((c) => c.level === 'PRIORITY').length,
        routine: open.filter((c) => c.level === 'ROUTINE').length,
        real: open.filter((c) => c.external).length
      }
    };
  }

  function villageStats(id) {
    const v = villages.get(id);
    let urgent = 0;
    let priority = 0;
    for (const hid of v?.houses || []) {
      const c = cases.get(hid);
      if (c?.level === 'URGENT') urgent += 1;
      if (c?.level === 'PRIORITY') priority += 1;
    }
    return { urgent, priority, houses: v?.houses.length || 0 };
  }

  function search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results = [];
    const add = (type, id, label, sub, icon) => {
      const l = label.toLowerCase();
      if (!`${l} ${sub || ''}`.toLowerCase().includes(q)) return;
      results.push({ type, id, label, sub, icon, rank: l === q ? 0 : l.startsWith(q) ? 1 : l.includes(q) ? 2 : 3 });
    };
    for (const c of centres.values()) add('centre', c.id, c.name, c.type, c.kind === 'warehouse' ? 'warehouse' : 'local_hospital');
    for (const h of hwcs.values()) add('building', h.building.id, h.building.name, 'Health and Wellness Centre', 'local_hospital');
    for (const v of villages.values()) add('village', v.id, v.name, v.id === 'arasur' ? 'Block headquarters town' : 'Village', 'cottage');
    for (const c of cases.values()) add('building', c.buildingId, `${c.label || c.id} · ${CASE_LEVELS[c.level].short}`, `${c.external ? 'From the ASHA app, ' : ''}${buildings.get(c.buildingId).name}`, 'warning');
    for (const f of fleet.values()) add('vehicle', f.id, `${f.id} · ${f.name}`, FLEET_STATUS[f.status], f.kind === 'scooter' ? 'electric_moped' : f.kind === 'ambulance' ? 'ambulance' : 'local_shipping');
    for (const r of [...runs.values(), ...history]) add('run', r.id, `${r.id} · ${r.typeLabel}`, r.to.name, r.type === 'referral' ? 'ambulance' : 'medication');
    for (const l of landmarks.values()) add('landmark', l.id, l.name, 'Landmark', l.kind === 'temple' ? 'temple_hindu' : l.kind === 'lake' ? 'water_drop' : l.kind === 'busstand' ? 'directions_bus' : 'school');
    for (const b of buildings.values()) if (b.kind !== 'hwc' && b.kind !== 'school') add('building', b.id, b.name, b.roadName || '', b.kind === 'shop' ? 'storefront' : 'home');
    // Exact and prefix name matches first; the sort is stable, so ties keep the order above.
    return results.sort((a, b) => a.rank - b.rank).slice(0, 8);
  }

  return {
    on,
    step,
    setSeason,
    kpis,
    search,
    villageStats,
    syncExternalCases,
    homeOf,
    findMedicineSources,
    planPickup,
    planRoute,
    dispatchPrescription,
    sources,
    shops,
    centres,
    clinical,
    hwcs,
    fleet,
    runs,
    history,
    cases,
    closedCases,
    alerts,
    buildings,
    landmarks,
    zones,
    villages,
    get season() {
      return season;
    },
    get unread() {
      return unread;
    },
    markAlertsRead() {
      unread = 0;
      for (const a of alerts) a.read = true;
    },
    get time() {
      return t;
    },
    // Test and debug hooks.
    createMedicineRun,
    openCase
  };
}
