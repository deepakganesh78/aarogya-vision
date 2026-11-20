// Lead doctor block live view (rural): wires the synthetic operations simulation, the 3D map and the
// Material 3 panels. Everything shown is synthetic demo data (see the prototype notice on the page).
// Houses take the colour of an open home-visit case (red: urgent, refer now; yellow: doctor review today).
// Draft wording: case labels need clinician sign-off before any pilot.
import '/vendor/material.js';
import { signLabel } from '/shared/dangerSigns.js';
import { describeReason } from '/shared/triage.js';
import { appendChildren, el, setChildren } from './dom.js';
import { hydrateIcons, icon, setIcon } from './icons.js';
import { connectDoctorQueue } from './live-queue.js';
import { BLOCK_NAME, DISTRICT_NAME, buildLayout, GRID } from './live/layout.js';
import { METERS_PER_UNIT, createNetwork } from './live/network.js';
import { createScene } from './live/scene.js';
import { CASE_LEVELS, CATALOGUE, DOCTOR_STATUS, FLEET_STATUS, SEASONS, SIM_MINUTES_PER_SECOND, STAFF_STATUS, createSim, matchMedicine } from './live/sim.js';
import { createTraffic } from './live/traffic.js';
import { mulberry32 } from './live/util.js';
import { PALETTE, SEVERITY_COLORS } from './live/world.js';

const $ = (s) => document.querySelector(s);
const KM_PER_UNIT = METERS_PER_UNIT / 1000;
const KMH_PER_UNIT_S = (KM_PER_UNIT * 3600) / (SIM_MINUTES_PER_SECOND * 60);
const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const fmtTime = (d) => (d ? timeFmt.format(d) : '');
const fmtKm = (km) => (km < 0.1 ? 'under 100 m' : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`);

const STEP_ICONS = {
  medicine: ['inventory_2', 'check_circle', 'medication', 'electric_moped', 'route', 'home'],
  restock: ['inventory_2', 'check_circle', 'warehouse', 'local_shipping', 'route', 'local_hospital'],
  referral: ['warning', 'ambulance', 'ambulance', 'groups', 'route', 'local_hospital'],
  prescription: ['medication', 'electric_moped', 'local_pharmacy', 'inventory_2', 'route', 'home']
};
const RUN_ICON = { referral: 'ambulance', restock: 'local_shipping', medicine: 'medication', prescription: 'local_pharmacy' };
const SOURCE_ICON = { phc: 'local_hospital', hwc: 'local_hospital', shop: 'local_pharmacy' };
const KIND_ICON = { scooter: 'electric_moped', ambulance: 'ambulance', van: 'local_shipping' };
const KIND_LABEL = { scooter: 'Medicine courier (e-scooter)', ambulance: '108 ambulance', van: 'Supply van' };
const BUILDING_KIND = { house: 'Home', shop: 'Shop', school: 'School', hwc: 'Health and Wellness Centre (sub-centre)' };
const BUILDING_ICON = { house: 'home', shop: 'storefront', school: 'school', hwc: 'local_hospital' };
const LANDMARK_ICON = { temple: 'temple_hindu', lake: 'water_drop', busstand: 'directions_bus', school: 'school' };
const DOCTOR_PILL = { opd: 'success', rounds: 'info', nbsu: 'info', oncall: 'info', break: 'warning', off: '', leave: '' };
const FLEET_PILL = { idle: '', assigned: 'info', loading: 'info', en_route: 'info', returning: '', responding: 'urgent', transporting: 'urgent' };
const STAFF_PILL = { present: 'success', field: 'info', leave: '' };
const CASE_PILL = { URGENT: 'urgent', PRIORITY: 'warning', ROUTINE: 'success' };
const QUEUE_STATUS = {
  demo: ['lock', 'Doctor sign in'],
  connecting: ['sync', 'Connecting to the queue'],
  live: ['cloud_done', 'Live queue'],
  offline: ['cloud_off', 'Queue offline'],
  expired: ['lock', 'Sign in again']
};
// Real doctor queue (filled when a doctor is signed in to the console in this tab, or here).
const queue = { status: 'demo', stats: null, doctor: null, ashas: null };
let queueClient = null;

const caseLabel = (c) => c.label || c.id;
function patientMeta(p) {
  if (!p) return 'Patient details not given';
  const age = p.ageValue != null && p.ageUnit ? `${p.ageValue} ${p.ageValue === 1 ? p.ageUnit.replace(/s$/, '') : p.ageUnit}` : p.ageDays != null ? `${p.ageDays} days` : 'age not given';
  const parts = [age];
  if (p.sex === 'female' || p.sex === 'male') parts.push(p.sex);
  if (p.pregnant) parts.push(p.pregnancyMonths ? `pregnant ${p.pregnancyMonths} months` : 'pregnant');
  return parts.join(', ');
}
const casePatient = (c) => (c.external ? patientMeta(c.patient) : `Young infant, ${c.ageDays} ${c.ageDays === 1 ? 'day' : 'days'}`);

const params = new URLSearchParams(location.search);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  selected: null,
  trackedRunId: null,
  trackedPinned: false,
  zone: 'all',
  night: false,
  paused: false,
  tab: 'centres',
  following: false
};

function announce(text) {
  const node = $('#announcer');
  node.textContent = '';
  requestAnimationFrame(() => (node.textContent = text));
}

/** Light-scheme accent tokens for the 3D world, so map colours stay the same by day and night. */
function readAccents() {
  const root = document.documentElement;
  const previous = root.dataset.theme;
  root.dataset.theme = 'light';
  const cs = getComputedStyle(root);
  const read = (name) => cs.getPropertyValue(name).trim();
  const accents = { primary: read('--md-sys-color-primary'), error: read('--md-sys-color-error'), warning: read('--app-color-warning'), success: read('--app-color-success') };
  if (previous) root.dataset.theme = previous;
  else delete root.dataset.theme;
  return accents;
}

async function waitForTokens() {
  for (let i = 0; i < 50; i++) {
    if (getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-primary').trim()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---- Small binding helper: panels are built once per selection and refreshed in place -------------
function binder() {
  let list = [];
  return {
    text(node, fn) {
      list.push(() => {
        const v = String(fn() ?? '');
        if (node.textContent !== v) node.textContent = v;
      });
      return node;
    },
    prop(node, key, fn) {
      list.push(() => {
        const v = fn();
        if (node[key] !== v) node[key] = v;
      });
      return node;
    },
    attr(node, key, fn) {
      list.push(() => {
        const v = fn();
        if (v === null || v === undefined || v === false) node.removeAttribute(key);
        else if (node.getAttribute(key) !== String(v)) node.setAttribute(key, v);
      });
      return node;
    },
    run(fn) {
      list.push(fn);
    },
    refresh() {
      for (const fn of list) fn();
    },
    reset() {
      list = [];
    }
  };
}

function pill(text, kind = '', iconName = null) {
  return el('span', { className: `pill ${kind}`.trim() }, iconName ? icon(iconName) : null, text);
}

// ---- Boot -------------------------------------------------------------------------------------------
await waitForTokens();
hydrateIcons();
const accents = readAccents();
const seed = Number(params.get('seed')) || (Date.now() % 100000);
const rng = mulberry32(seed);
const network = createNetwork(GRID);
const layout = buildLayout({ seed: 7 }, network);
const traffic = createTraffic(network, { rng, signalNodes: layout.signalNodes });
const sim = createSim({ layout, network, traffic, rng });
const fleetIds = new Set(sim.fleet.keys());
const centreList = [...sim.centres.values()];
const hwcList = [...sim.hwcs.values()];
const villageList = [...sim.villages.values()];
const temple = layout.landmarks.find((l) => l.kind === 'temple');
const onDuty = (c) => c.doctors.filter((d) => !['off', 'leave'].includes(d.status)).length;

const canvas = $('#scene');
const view = createScene({
  canvas,
  layout,
  network,
  accents,
  reducedMotion,
  onPick: (ref) => (ref ? select(ref) : clearSelection()),
  onInteract: (what) => {
    if (what === 'unfollow') {
      state.following = false;
      detailBinds.refresh();
    }
  }
});
document.body.dataset.webgl = view ? 'true' : 'false';
if (!view) {
  $('#webgl-fallback').hidden = false;
  canvas.hidden = true;
} else {
  view.setFleetIds(fleetIds);
}

// ---- Entities -----------------------------------------------------------------------------------
const zoneName = (id) => sim.zones.get(id)?.name || '';
function runOf(id) {
  return sim.runs.get(id) || sim.history.find((r) => r.id === id) || null;
}

function entityInfo(ref) {
  if (!ref) return null;
  switch (ref.type) {
    case 'centre': {
      const c = sim.centres.get(ref.id);
      return c && { name: c.name, pos: () => ({ x: c.cx, z: c.cz }), radius: 8.6, distance: 42 };
    }
    case 'building': {
      const b = sim.buildings.get(ref.id);
      return b && { name: b.name, pos: () => ({ x: b.x, z: b.z }), radius: Math.max(b.w, b.d) / 2 + 0.8, distance: 30 };
    }
    case 'landmark': {
      const l = sim.landmarks.get(ref.id);
      return l && { name: l.name, pos: () => ({ x: l.x, z: l.z }), radius: Math.max(l.w, l.d) / 2 + 0.8, distance: l.kind === 'lake' ? 52 : 40 };
    }
    case 'village': {
      const v = sim.villages.get(ref.id);
      return v && { name: v.name, pos: () => ({ x: v.x, z: v.z }), radius: v.id === 'arasur' ? 0 : 9.4, distance: 58 };
    }
    case 'worker': {
      const v = villageOfAsha(ref.id);
      const name = ashaProfile(ref.id)?.name || v?.asha.find((a) => a.id === ref.id)?.name || 'ASHA worker';
      return v && { name: `${name}, ASHA`, pos: () => ({ x: v.x, z: v.z }), radius: v.id === 'arasur' ? 0 : 9.4, distance: 58 };
    }
    case 'location': {
      const v = sim.villages.get(ref.id);
      return v && { name: `${v.name}, needs attention`, pos: () => ({ x: v.x, z: v.z }), radius: v.id === 'arasur' ? 0 : 9.4, distance: 44 };
    }
    case 'case': {
      const c = realCase(ref.id);
      const b = c && sim.buildings.get(c.buildingId);
      return b && { name: `Case of ${c.patient?.name || 'a patient'}`, pos: () => ({ x: b.x, z: b.z }), radius: Math.max(b.w, b.d) / 2 + 0.8, distance: 38 };
    }
    case 'medfind': {
      const c = realCase(ref.id);
      const b = c && sim.buildings.get(c.buildingId);
      return b && { name: `Medicines for ${c.patient?.name || 'the patient'}`, pos: () => ({ x: b.x, z: b.z }), radius: Math.max(b.w, b.d) / 2 + 0.8, distance: medfindDistance(c) };
    }
    case 'vehicle': {
      const f = sim.fleet.get(ref.id);
      return f && { name: `${f.id} · ${f.name}`, pos: () => ({ x: f.vehicle.x, z: f.vehicle.z }), radius: f.kind === 'scooter' ? 1.15 : 1.9, distance: 24, follow: true };
    }
    case 'run': {
      const run = runOf(ref.id);
      if (!run) return null;
      const f = run.vehicleId ? sim.fleet.get(run.vehicleId) : null;
      const moving = f && run.status >= 2 && run.status < 5 && f.vehicle.mode !== 'parked';
      if (moving) return { name: run.id, pos: () => ({ x: f.vehicle.x, z: f.vehicle.z }), radius: f.kind === 'scooter' ? 1.15 : 1.9, distance: 26, follow: true };
      return { name: run.id, pos: () => ({ x: run.to.x, z: run.to.z }), radius: 2.4, distance: 30 };
    }
    case 'zone': {
      const z = sim.zones.get(ref.id);
      return z && { name: z.name, pos: () => ({ x: z.x, z: z.z }), radius: 0, distance: z.id === 'all' ? 128 : 74 };
    }
    default:
      return null;
  }
}

function select(ref, { fly = true } = {}) {
  if (ref.type === 'zone') {
    setZone(ref.id);
    return;
  }
  const info = entityInfo(ref);
  if (!info) return;
  state.selected = ref;
  if (ref.type === 'case') markSeen(realCase(ref.id));
  if (ref.type === 'building' && sim.cases.get(ref.id)?.external) markSeen(sim.cases.get(ref.id));
  setCollapsed('detail', false);
  if (ref.type === 'run') trackRun(ref.id, true);
  if (ref.type === 'vehicle') {
    const f = sim.fleet.get(ref.id);
    if (f.runId) trackRun(f.runId, true);
  }
  state.following = Boolean(info.follow);
  if (view) {
    view.actors.setSelection({ position: info.pos, radius: info.radius });
    if (fly) {
      const p = info.pos();
      view.controls.flyTo({ x: p.x, z: p.z, distance: info.distance }, { follow: info.follow ? info.pos : null });
    }
    updateRoute(true);
  }
  renderDetail();
  renderLabelsSelection();
  syncSelectedRows();
  if (window.matchMedia('(max-width: 760px)').matches) setSheet('detail');
  announce(`${info.name} selected`);
}

function clearSelection() {
  state.selected = null;
  state.following = false;
  if (view) {
    view.actors.setSelection(null);
    view.actors.setRoute(null);
    if (view.controls.follow) view.controls.follow = null;
  }
  renderDetail();
  renderLabelsSelection();
  syncSelectedRows();
}

function setZone(id) {
  state.zone = id;
  $('#zone-name').textContent = zoneName(id);
  const z = sim.zones.get(id);
  if (view && z) view.controls.flyTo({ x: z.x, z: z.z, distance: id === 'all' ? 128 : 74 });
  announce(`Showing ${zoneName(id)}`);
}

function trackRun(id, pinned = false) {
  if (state.trackedRunId === id && !pinned) return;
  state.trackedRunId = id;
  state.trackedPinned = pinned;
  renderTracker();
}

function currentRunPath(run) {
  const f = run?.vehicleId ? sim.fleet.get(run.vehicleId) : null;
  if (!f || run.status >= 5) return null;
  return traffic.routePoints(f.vehicle);
}

let routeClock = 0;
function updateRoute(force = false) {
  if (!view) return;
  const ref = state.selected;
  let run = null;
  if (ref?.type === 'run') run = runOf(ref.id);
  if (ref?.type === 'vehicle') run = runOf(sim.fleet.get(ref.id).runId);
  if (!run || (!force && routeClock < 0.45)) return;
  routeClock = 0;
  view.actors.setRoute(currentRunPath(run), run.type === 'referral' ? accents.error : accents.primary);
}

// ---- Detail panel ---------------------------------------------------------------------------------
const detailBinds = binder();

function detailHead(iconName, title, sub, { urgent = false } = {}) {
  const close = el('md-icon-button', { ariaLabel: 'Close details' }, icon('close'));
  close.addEventListener('click', clearSelection);
  return el(
    'div',
    { className: 'detail__head' },
    el('span', { className: `detail__icon${urgent ? ' error' : ''}` }, icon(iconName)),
    el('div', { className: 'detail__title' }, el('h2', { className: 'md-typescale-title-medium' }, title), sub ? el('span', { className: 'detail__sub md-typescale-body-small' }, sub) : null),
    close
  );
}

const stat = (label, fn) => el('div', { className: 'stat' }, detailBinds.text(el('span', { className: 'stat__value md-typescale-title-medium' }), fn), el('span', { className: 'stat__label md-typescale-label-small' }, label));
const sectionTitle = (iconName, text) => el('h3', { className: 'section-title md-typescale-title-small' }, icon(iconName), text);
const kvRow = (label, fn, binds = detailBinds) => [el('dt', { className: 'md-typescale-body-small' }, label), binds.text(el('dd', { className: 'md-typescale-body-small' }), fn)];

function boundPill(fnText, fnKind, iconName = null) {
  const textNode = el('span');
  const node = el('span', { className: 'pill' }, iconName ? icon(iconName) : null, textNode);
  detailBinds.text(textNode, fnText);
  detailBinds.run(() => {
    const cls = `pill ${fnKind()}`.trim();
    if (node.className !== cls) node.className = cls;
  });
  return node;
}

function runListItem(run) {
  const b = el('md-text-button', { className: 'row-button' }, run.id);
  b.addEventListener('click', () => select({ type: 'run', id: run.id }));
  return el(
    'li',
    {},
    el('div', { className: 'grow' }, b, el('span', { className: 'muted md-typescale-body-small' }, `${run.typeLabel} to ${run.to.name}`)),
    pill(run.steps[run.status].label, run.type === 'referral' ? 'urgent' : run.status >= 5 ? 'success' : 'info')
  );
}

function renderDetail() {
  const panel = $('#detail-content');
  detailBinds.reset();
  document.body.dataset.panel = '';
  const ref = state.selected;
  if (ref?.type !== 'medfind') clearMedFind();
  if (!ref) {
    setChildren(panel, overviewDetail());
    detailBinds.refresh();
    return;
  }
  const builders = { centre: centreDetail, building: buildingDetail, landmark: landmarkDetail, vehicle: vehicleDetail, run: runDetail, village: villageDetail, worker: workerDetail, location: locationDetail, case: caseDetail, medfind: medfindDetail };
  const key = `${ref.type}:${ref.id}`;
  if (panel.dataset.ref !== key) {
    panel.dataset.ref = key;
    panel.scrollTop = 0;
  }
  setChildren(panel, builders[ref.type]?.(ref.id) || overviewDetail());
  detailBinds.refresh();
}

const caseStats = (v) => sim.villageStats(v.id);
function villageSeverity(v) {
  const s = caseStats(v);
  return s.urgent ? 'urgent' : s.priority ? 'warning' : 'success';
}
function villageSummary(v) {
  const s = caseStats(v);
  if (!s.urgent && !s.priority) return 'No open cases';
  return [s.urgent ? `${s.urgent} urgent` : '', s.priority ? `${s.priority} review today` : ''].filter(Boolean).join(' · ');
}

/** Main view of the right panel: every active case, real ones from the ASHA app first. */
function overviewDetail() {
  const activeTitle = detailBinds.text(el('span', { className: 'detail__sub md-typescale-body-small' }), () => {
    const nReal = realOpen().length;
    const nSim = simOpen().length;
    return `${nReal} from the ASHA app · ${nSim} simulated home visits`;
  });
  const realBox = el('div', { className: 'active-real' });
  detailBinds.run(() => {
    const groups = attentionGroups();
    const key = `${queue.status}|${groups.map(([id, cs]) => `${id}:${cs.map((c) => `${c.id}.${c.level}.${seen.has(c.id) ? 1 : 0}`).join(',')}`).join('|')}`;
    if (realBox.dataset.key === key) return;
    realBox.dataset.key = key;
    if (!groups.length) {
      const signedOut = queue.status === 'demo' || queue.status === 'expired';
      const go = el('md-filled-tonal-button', {}, icon('lock', { slot: 'icon' }), 'Sign in as a doctor');
      go.addEventListener('click', openSignIn);
      setChildren(realBox, el('p', { className: 'muted md-typescale-body-small' }, signedOut ? 'Sign in as a doctor to see cases sent from the ASHA app.' : 'No case from the ASHA app is waiting. New ones appear here and as red pins on the map.'), signedOut ? el('div', { className: 'actions' }, go) : null);
      return;
    }
    setChildren(
      realBox,
      ...groups.map(([id, cases]) => {
        const v = sim.villages.get(id);
        const place = el('md-text-button', { className: 'row-button' }, icon('location_on', { slot: 'icon' }), `${v.name} · ${cases.length} case${cases.length === 1 ? '' : 's'}`);
        place.addEventListener('click', () => select({ type: 'location', id }));
        return el('div', { className: 'active-place' }, place, el('ul', { className: 'issue-list' }, ...cases.map((c) => issueCard(c))));
      })
    );
  });
  const simBox = el('ul', { className: 'list' });
  detailBinds.run(() => {
    const list = [...simOpen()].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.openedT - a.openedT);
    const key = list.map((c) => `${c.id}.${c.level}`).join(',');
    if (simBox.dataset.key === key) return;
    simBox.dataset.key = key;
    if (!list.length) return setChildren(simBox, el('li', { className: 'muted md-typescale-body-small' }, 'No simulated home-visit case is open.'));
    setChildren(
      simBox,
      ...list.map((c) => {
        const b = el('md-text-button', { className: 'row-button' }, caseLabel(c));
        b.addEventListener('click', () => select({ type: 'building', id: c.buildingId }));
        return el('li', {}, el('div', { className: 'grow' }, b, el('span', { className: 'muted md-typescale-body-small' }, `${casePatient(c)} · ${zoneName(c.zone)} · ${c.asha.name}`)), pill(CASE_LEVELS[c.level].short, CASE_PILL[c.level]));
      })
    );
  });
  return [
    el('div', { className: 'detail__head' }, el('span', { className: 'detail__icon error' }, icon('inbox')), el('div', { className: 'detail__title' }, el('h2', { className: 'md-typescale-title-medium' }, 'Active cases'), activeTitle)),
    el(
      'div',
      { className: 'detail__body' },
      sectionTitle('mobile', 'From the ASHA app (needs a doctor)'),
      realBox,
      sectionTitle('home', 'Home-visit cases on the map (simulated)'),
      simBox,
      el('details', { className: 'block-overview' }, el('summary', { className: 'md-typescale-title-small' }, `${BLOCK_NAME}, live: facilities, villages and queue`), ...blockOverview())
    )
  ];
}

const simOpen = () => [...sim.cases.values()].filter((c) => !c.external);

function blockOverview() {
  const list = el('ul', { className: 'list' });
  for (const c of sim.clinical) {
    const b = el('md-text-button', { className: 'row-button' }, c.name);
    b.addEventListener('click', () => select({ type: 'centre', id: c.id }));
    list.append(
      el(
        'li',
        {},
        el('div', { className: 'grow' }, b, detailBinds.text(el('span', { className: 'muted md-typescale-body-small' }), () => `${onDuty(c)} of ${c.doctors.length} doctors on duty · ${c.beds.total - c.beds.occupied} beds free`)),
        boundPill(() => `${c.waiting} waiting`, () => (c.waiting > 30 ? 'error' : c.waiting > 20 ? 'warning' : 'success'), 'groups')
      )
    );
  }
  const villagesList = el('ul', { className: 'list' });
  for (const v of villageList) {
    const b = el('md-text-button', { className: 'row-button' }, v.name);
    b.addEventListener('click', () => select({ type: 'village', id: v.id }));
    villagesList.append(
      el(
        'li',
        {},
        el('div', { className: 'grow' }, b, el('span', { className: 'muted md-typescale-body-small' }, `${v.houses.length} homes · ASHA ${v.asha.map((a) => a.name).join(', ')}`)),
        boundPill(() => villageSummary(v), () => villageSeverity(v))
      )
    );
  }
  const openCases = () => sim.cases.size;
  const queueBox = el('div', { className: 'case' });
  detailBinds.run(() => {
    const key = `${queue.status}:${JSON.stringify(queue.stats)}:${JSON.stringify(queue.ashas)}`;
    if (queueBox.dataset.key === key) return;
    queueBox.dataset.key = key;
    setChildren(queueBox, queueSection());
  });
  return [
    el('div', { className: 'stats' }, stat('Patients waiting', () => sim.clinical.reduce((s, c) => s + c.waiting, 0)), stat('Open cases', openCases), stat('Active runs', () => sim.runs.size)),
    queueBox,
    sectionTitle('local_hospital', 'Health facilities'),
    list,
    sectionTitle('cottage', 'Villages'),
    villagesList,
    el('p', { className: 'md-typescale-body-small detail__sub' }, `${DISTRICT_NAME} district · simulated block operations. Homes turn red for an urgent case (refer now) and yellow for a doctor review today. Select a village, home, centre or vehicle for live details. Drag to pan, right-drag to rotate, scroll or pinch to zoom.`)
  ];
}

/** Real doctor queue figures (GET /api/doctor/stats), or how to connect it. */
function queueSection() {
  const go = el('md-filled-tonal-button', {}, icon('lock', { slot: 'icon' }), 'Sign in as a doctor');
  go.addEventListener('click', openSignIn);
  const s = queue.stats;
  if (!s) {
    const text =
      queue.status === 'demo'
        ? 'Showing simulated cases only. Sign in as a doctor (top bar) and cases sent from the ASHA app appear here and blink on the map.'
        : queue.status === 'expired'
          ? 'Your doctor session expired. Sign in again to show real cases.'
          : 'Connecting to the doctor queue.';
    return [sectionTitle('inbox', 'Doctor queue'), el('p', { className: 'muted md-typescale-body-small' }, text), el('div', { className: 'actions' }, go)];
  }
  const kv = el('dl', { className: 'kv' });
  const row = (label, value) => [el('dt', { className: 'md-typescale-body-small' }, label), el('dd', { className: 'md-typescale-body-small' }, value)];
  appendChildren(
    kv,
    row('Waiting for review', `${s.waiting}${s.urgentWaiting ? `, ${s.urgentWaiting} urgent` : ''}`),
    row('Oldest waiting', s.oldestWaiting ? `${s.oldestWaiting.minutes} min` : 'None'),
    row('Received today', String(s.receivedToday)),
    row('Replied today', `${s.repliedToday}${s.medianReplyMinutes != null ? `, median ${s.medianReplyMinutes} min` : ''}`)
  );
  return [sectionTitle('inbox', 'Doctor queue (from the ASHA app)'), kv, ...ashaList()];
}

/** ASHA workers who use the app, with today's cases (GET /api/doctor/ashas). */
function ashaList() {
  if (!queue.ashas?.length) return [];
  const list = el('ul', { className: 'list' });
  for (const a of queue.ashas) {
    const b = el('md-text-button', { className: 'row-button' }, `${a.name}, ASHA`);
    b.addEventListener('click', () => select({ type: 'worker', id: a.id }));
    list.append(
      el(
        'li',
        {},
        el('div', { className: 'grow' }, b, el('span', { className: 'muted md-typescale-body-small' }, `${a.village} · ${a.casesToday} case${a.casesToday === 1 ? '' : 's'} today`)),
        a.openCases ? pill(`${a.openCases} open`, 'real') : pill('None open', 'success')
      )
    );
  }
  return [sectionTitle('badge', 'ASHA workers'), list];
}

function villageDetail(id) {
  const v = sim.villages.get(id);
  const body = el('div', { className: 'detail__body' });
  const houses = v.houses.map((hid) => sim.buildings.get(hid));
  body.append(el('div', { className: 'chips' }, boundPill(() => villageSummary(v), () => villageSeverity(v), 'home'), pill(v.id === 'arasur' ? 'Block headquarters town' : 'Village', 'info', 'location_on')));
  body.append(el('div', { className: 'stats' }, stat('Homes', () => houses.length), stat('Open cases', () => caseStats(v).urgent + caseStats(v).priority), stat('Visits due', () => houses.reduce((s, b) => s + (b.visitsDue || 0), 0))));
  const casesList = el('ul', { className: 'list' });
  detailBinds.run(() => {
    const open = houses.map((b) => sim.cases.get(b.id)).filter(Boolean).sort((a, b) => (a.level === 'URGENT' ? -1 : 0) - (b.level === 'URGENT' ? -1 : 0) || a.openedT - b.openedT);
    const key = open.map((c) => `${c.id}:${c.level}`).join(',');
    if (casesList.dataset.key === key) return;
    casesList.dataset.key = key;
    setChildren(casesList, open.length ? open.map(caseListItem) : el('li', { className: 'muted md-typescale-body-small' }, 'No open home-visit cases'));
  });
  body.append(sectionTitle('warning', 'Open home-visit cases'), casesList);
  const kv = el('dl', { className: 'kv' });
  for (const a of v.asha) {
    const who = el('md-text-button', { className: 'row-button' }, `${a.name}, ASHA`);
    who.addEventListener('click', () => select({ type: 'worker', id: a.id }));
    kv.append(el('dt', { className: 'md-typescale-body-small' }, 'ASHA worker'), el('dd', { className: 'md-typescale-body-small' }, who));
  }
  const hwc = v.hwc ? sim.hwcs.get(v.hwc.id) : null;
  if (hwc) appendChildren(kv, kvRow('Sub-centre', () => `${hwc.building.name}, CHO ${STAFF_STATUS[hwc.staff[0].status].toLowerCase()}`));
  const near = nearestCentre(v);
  appendChildren(kv, kvRow('Nearest health centre', () => `${near.c.name}, about ${fmtKm(near.d)}`));
  body.append(sectionTitle('groups', 'Health workers'), kv);
  if (hwc) {
    const go = el('md-filled-tonal-button', {}, icon('local_hospital', { slot: 'icon' }), `Open ${hwc.building.name}`);
    go.addEventListener('click', () => select({ type: 'building', id: hwc.building.id }));
    body.append(el('div', { className: 'actions' }, go));
  }
  return [detailHead('cottage', v.name, v.id === 'arasur' ? `Town, ${BLOCK_NAME}` : `Village, ${BLOCK_NAME}`, { urgent: caseStats(v).urgent > 0 }), body];
}

function caseListItem(c) {
  const home = sim.buildings.get(c.buildingId);
  const b = el('md-text-button', { className: 'row-button' }, caseLabel(c));
  b.addEventListener('click', () => select({ type: 'building', id: c.buildingId }));
  const who = c.external ? `${c.patient?.name || 'Patient'}, ${patientMeta(c.patient)}` : `infant, ${c.ageDays} days`;
  return el(
    'li',
    {},
    el('div', { className: 'grow' }, b, el('span', { className: 'muted md-typescale-body-small' }, `${home.name} · ${who} · ${c.external ? 'sent' : 'flagged'} ${fmtTime(c.flaggedAt)}`)),
    c.external ? pill('ASHA app', 'real') : null,
    pill(CASE_LEVELS[c.level].short, CASE_PILL[c.level])
  );
}

function nearestCentre(at) {
  let nearest = null;
  for (const c of sim.clinical) {
    const d = Math.hypot(c.gate.x - at.x, c.gate.z - at.z) * KM_PER_UNIT * 1.25;
    if (!nearest || d < nearest.d) nearest = { c, d };
  }
  return nearest;
}

function centreDetail(id) {
  const c = sim.centres.get(id);
  const isWarehouse = c.kind === 'warehouse';
  const body = el('div', { className: 'detail__body' });
  body.append(el('div', { className: 'chips' }, pill(c.kind === 'chc' ? 'Open 24 hours' : isWarehouse ? 'Dispatching' : 'OPD open', 'success'), pill(c.roadName || '', ''), pill(zoneName(c.zone), 'info', 'location_on')));
  if (!isWarehouse) {
    body.append(el('div', { className: 'stats' }, stat('Waiting', () => c.waiting), stat('Seen today', () => c.seenToday), stat('Avg wait', () => (c.waitMinutes === null ? 'n/a' : `${c.waitMinutes} min`))));
    const docs = el('ul', { className: 'list' });
    for (const d of c.doctors) {
      docs.append(el('li', {}, el('div', { className: 'grow' }, el('span', { className: 'md-typescale-body-medium' }, d.name), el('span', { className: 'muted md-typescale-body-small' }, d.role)), boundPill(() => DOCTOR_STATUS[d.status], () => DOCTOR_PILL[d.status])));
    }
    const docTitle = sectionTitle('stethoscope', '');
    detailBinds.text(docTitle.lastChild, () => `Doctors: ${onDuty(c)} of ${c.doctors.length} on duty`);
    body.append(docTitle, docs);
    const beds = el('dl', { className: 'kv' });
    if (c.beds) appendChildren(beds, kvRow(c.beds.label, () => `${c.beds.total - c.beds.occupied} free of ${c.beds.total}`));
    if (c.newborn) appendChildren(beds, kvRow(c.newborn.label, () => `${c.newborn.total - c.newborn.occupied} free of ${c.newborn.total}`));
    body.append(sectionTitle('bed', 'Beds'), beds);
  }
  if (!isWarehouse) {
    const stock = el('ul', { className: 'list' });
    const items = Object.keys(c.stock).sort((a, b) => c.stock[a] - c.stock[b]);
    for (const id of items) stock.append(stockRow(CATALOGUE[id].name, () => c.stock[id]));
    body.append(sectionTitle('medication', 'Medicine stock'), stock);
  }
  const runsList = el('ul', { className: 'list' });
  detailBinds.run(() => {
    const related = [...sim.runs.values()].filter((r) => r.from === c.id || r.to.id === c.id);
    const key = related.map((r) => `${r.id}:${r.status}`).join(',');
    if (runsList.dataset.key === key) return;
    runsList.dataset.key = key;
    setChildren(runsList, related.length ? related.map(runListItem) : el('li', { className: 'muted md-typescale-body-small' }, 'No active runs'));
  });
  const fleetHere = () => [...sim.fleet.values()].filter((f) => f.base === c.id);
  const fleetTitle = sectionTitle(isWarehouse ? 'local_shipping' : 'electric_moped', '');
  detailBinds.text(fleetTitle.lastChild, () => `${isWarehouse ? 'Vans' : 'Fleet'}: ${fleetHere().filter((f) => f.status === 'idle').length} of ${fleetHere().length} at base`);
  body.append(sectionTitle('route', 'Runs from or to this centre'), runsList, fleetTitle);
  return [detailHead(isWarehouse ? 'warehouse' : 'local_hospital', c.name, c.type), body];
}

function vehicleDetail(id) {
  const f = sim.fleet.get(id);
  const v = f.vehicle;
  const run = () => (f.runId ? runOf(f.runId) : null);
  const base = sim.centres.get(f.base);
  const body = el('div', { className: 'detail__body' });
  body.append(el('div', { className: 'chips' }, boundPill(() => FLEET_STATUS[f.status], () => FLEET_PILL[f.status]), boundPill(() => (state.following ? 'Following' : 'Not following'), () => (state.following ? 'info' : ''), 'my_location')));
  body.append(
    el(
      'div',
      { className: 'stats' },
      stat('Speed', () => `${Math.round(v.speed * KMH_PER_UNIT_S)} km/h`),
      stat('ETA', () => (run()?.etaMin && run().status < 5 ? `${run().etaMin} min` : 'n/a')),
      stat('Distance left', () => (run()?.remainingKm && run().status < 5 ? fmtKm(run().remainingKm) : 'n/a'))
    )
  );
  const carrying = el('ul', { className: 'list' });
  detailBinds.run(() => {
    const r = run();
    const key = r ? `${r.id}:${r.status}:${r.leg ?? ''}` : 'none';
    if (carrying.dataset.key === key) return;
    carrying.dataset.key = key;
    if (!r) {
      setChildren(carrying, el('li', { className: 'muted md-typescale-body-small' }, f.status === 'idle' ? 'At base, ready for the next run' : 'Returning to base'));
    } else if (r.type === 'referral') {
      setChildren(carrying, el('li', {}, el('div', { className: 'grow' }, el('span', { className: 'md-typescale-body-medium' }, `Urgent referral ${r.id}`), el('span', { className: 'muted md-typescale-body-small' }, `${r.patient.label}. Danger signs flagged by ${r.requester}.`)), pill('Urgent', 'urgent')));
    } else if (r.type === 'prescription') {
      setChildren(carrying, r.items.map((i) => el('li', {}, el('div', { className: 'grow' }, el('span', { className: 'md-typescale-body-small' }, i.name), el('span', { className: 'muted md-typescale-body-small' }, `From ${i.from}`)), pill(r.stops.find((s) => s.name === i.from)?.collectedAt ? 'On board' : 'To collect', r.stops.find((s) => s.name === i.from)?.collectedAt ? 'success' : 'info'))));
    } else {
      setChildren(carrying, r.items.map((i) => el('li', {}, el('span', { className: 'grow md-typescale-body-small' }, i.name), el('span', { className: 'md-typescale-label-medium' }, `${i.qty} ${i.unit}`))));
    }
  });
  body.append(sectionTitle(f.kind === 'ambulance' ? 'ambulance' : 'inventory_2', f.kind === 'ambulance' ? 'Patient' : 'Carrying'), carrying);
  const kv = el('dl', { className: 'kv' });
  appendChildren(kv, kvRow('Base', () => base.name), kvRow(f.kind === 'ambulance' ? 'Trips today' : 'Deliveries today', () => f.deliveriesToday), kvRow('Distance today', () => fmtKm(f.kmToday)));
  if (f.battery !== null) appendChildren(kv, kvRow('Battery', () => `${Math.round(f.battery)}%`));
  if (f.crew) appendChildren(kv, kvRow('Crew', () => f.crew));
  appendChildren(kv, kvRow('Cold box', () => (f.coldBoxC === null ? 'Not in use' : `${f.coldBoxC.toFixed(1)} °C${f.coldBoxC > 8 ? ', above 8 °C' : ''}`)));
  body.append(kv);
  const followBtn = el('md-filled-tonal-button', {}, icon('my_location', { slot: 'icon' }));
  const followText = document.createTextNode('');
  followBtn.append(followText);
  detailBinds.run(() => {
    const t = state.following ? 'Stop following' : 'Follow';
    if (followText.data !== t) followText.data = t;
  });
  followBtn.addEventListener('click', () => {
    if (!view) return;
    state.following = !state.following;
    if (state.following) view.controls.flyTo({ x: v.x, z: v.z, distance: Math.min(view.controls.distance, 30) }, { follow: () => ({ x: v.x, z: v.z }) });
    else view.controls.follow = null;
    detailBinds.refresh();
  });
  body.append(el('div', { className: 'actions' }, followBtn));
  return [detailHead(KIND_ICON[f.kind], `${f.id} · ${f.name}`, `${KIND_LABEL[f.kind]}, ${base.name}`, { urgent: f.kind === 'ambulance' }), body];
}

function buildingDetail(id) {
  const b = sim.buildings.get(id);
  if (b.kind === 'hwc') return hwcDetail(b);
  // A home with a real case from the ASHA app opens that case.
  const real = sim.cases.get(b.id);
  if (real?.external) return caseDetail(real.id);
  const answered = sim.closedCases.find((x) => x.buildingId === b.id);
  if (answered?.external && realCases.get(answered.id)?.record?.decision) return caseDetail(answered.id);
  const body = el('div', { className: 'detail__body' });
  const openCase = () => sim.cases.get(b.id) || null;
  const chips = el('div', { className: 'chips' }, pill(BUILDING_KIND[b.kind] || 'Building', ''), pill(zoneName(b.zone), 'info', 'location_on'));
  if (b.kind === 'house') chips.prepend(boundPill(() => (openCase() ? CASE_LEVELS[openCase().level].label : 'No open case'), () => (openCase() ? CASE_PILL[openCase().level] : 'success'), 'home'));
  body.append(chips);
  if (b.kind === 'house') {
    const caseBox = el('div', { className: 'case' });
    const caseBinds = binder();
    detailBinds.run(() => {
      const c = openCase();
      const last = c ? null : sim.closedCases.find((x) => x.buildingId === b.id);
      const key = c ? `${c.id}:${c.level}:${c.runId || ''}:${c.caseStatus || ''}` : last ? `closed:${last.id}` : 'none';
      if (caseBox.dataset.key !== key) {
        caseBox.dataset.key = key;
        caseBinds.reset();
        setChildren(caseBox, caseSection(c, last, caseBinds));
      }
      caseBinds.refresh();
    });
    body.append(caseBox);
  }
  const kv = el('dl', { className: 'kv' });
  if (b.asha) {
    if (b.households) appendChildren(kv, kvRow('Households', () => b.households));
    appendChildren(kv, kvRow('ASHA worker', () => `${b.asha.name}, ${b.asha.id}`));
    if (b.kind === 'house') appendChildren(kv, kvRow('Home visits due today', () => b.visitsDue || 'None'));
  }
  const near = nearestCentre(b);
  appendChildren(kv, kvRow('Road', () => b.roadName || ''), kvRow('Nearest health centre', () => `${near.c.name}, about ${fmtKm(near.d)}`));
  body.append(sectionTitle('location_on', 'Address and care team'), kv);
  const runsList = el('ul', { className: 'list' });
  detailBinds.run(() => {
    const related = [...sim.runs.values()].filter((r) => r.to.id === b.id);
    const key = related.map((r) => `${r.id}:${r.status}`).join(',');
    if (runsList.dataset.key === key) return;
    runsList.dataset.key = key;
    setChildren(runsList, related.length ? related.map(runListItem) : el('li', { className: 'muted md-typescale-body-small' }, 'No active runs to this address'));
  });
  body.append(sectionTitle('route', 'Runs to this address'), runsList);
  const urgentNow = b.kind === 'house' && openCase()?.level === 'URGENT';
  return [detailHead(BUILDING_ICON[b.kind] || 'home', b.name, `${BUILDING_KIND[b.kind] || 'Building'}, ${b.roadName || zoneName(b.zone)}`, { urgent: urgentNow }), body];
}

/** Open (or last closed) home-visit case for one home. Draft wording, needs clinician sign-off. */
function caseSection(c, last, binds) {
  if (!c && !last) return [sectionTitle('home', 'Home-visit case'), el('p', { className: 'muted md-typescale-body-small' }, 'No case flagged for this home today.')];
  if (!c) {
    const kv = el('dl', { className: 'kv' });
    appendChildren(kv, kvRow('Case', () => caseLabel(last), binds), kvRow('Closed', () => fmtTime(last.closedAt), binds), kvRow('Outcome', () => last.status, binds));
    return [sectionTitle('check_circle', 'Last case, closed'), kv];
  }
  const kv = el('dl', { className: 'kv' });
  appendChildren(
    kv,
    kvRow('Case', () => c.id, binds),
    kvRow('Patient', () => `Young infant, ${c.ageDays} days`, binds),
    kvRow('Flagged by', () => `${c.asha.name}, ${c.asha.id}`, binds),
    kvRow('Flagged at', () => fmtTime(c.flaggedAt), binds)
  );
  if (c.level === 'URGENT') {
    appendChildren(
      kv,
      kvRow(
        'Referral',
        () => {
          const run = c.runId ? runOf(c.runId) : null;
          return run ? `${run.id}, ${run.steps[run.status].label.toLowerCase()}${run.etaMin && run.status < 3 ? `, ambulance ${run.etaMin} min away` : ''}` : 'Waiting for a free ambulance';
        },
        binds
      )
    );
  } else {
    appendChildren(kv, kvRow('Doctor review', () => `Due today, in about ${Math.max(1, Math.round((c.reviewAt - sim.time) * SIM_MINUTES_PER_SECOND))} min`, binds));
  }
  const nodes = [sectionTitle('warning', c.escalated ? 'Open case, escalated on follow-up' : 'Open home-visit case'), kv];
  if (c.runId) {
    const go = el('md-filled-tonal-button', {}, icon('ambulance', { slot: 'icon' }), 'Track the referral');
    go.addEventListener('click', () => select({ type: 'run', id: c.runId }));
    nodes.push(el('div', { className: 'actions' }, go));
  }
  nodes.push(el('p', { className: 'md-typescale-body-small detail__sub' }, 'Level from the danger-sign rules on the ASHA app. The doctor makes the clinical decision. Draft wording.'));
  return nodes;
}

const QUEUE_CASE_STATUS = { received: 'Received, AI reading', processing: 'AI reading the photo and voice note', awaiting_review: 'Waiting for doctor review' };

// ---- Real cases from the ASHA app ------------------------------------------------------------------
// A place with open cases gets a red location pin ("needs attention"). The doctor opens the place, then a
// case: the side panel shows what the AI organised from the worker's photo and voice note (symptoms with
// their evidence, the photo and what is visible in it, the voice note translated to English, patient
// details, cited guidance) and the doctor answers on the same screen: medicines the doctor chooses and
// doses, or escalation to a larger hospital. AI never diagnoses, prescribes or lowers the rules-based
// level. Clinical wording here is draft and needs clinician sign-off.
const realCases = new Map(); // case id -> { record, asha, photoUrl, audioUrl, loading, error }
const LEVEL_ORDER = { URGENT: 0, PRIORITY: 1, ROUTINE: 2 };
const LEVEL_BADGE = { URGENT: 'Urgent · red', PRIORITY: 'Review today · yellow', ROUTINE: 'Routine' };
const OUTCOME_TEXT = { refer_now: 'Escalated to hospital', home_care_follow_up: 'Treat at home', need_more_info: 'Asked the ASHA for more', no_action: 'No further action' };
const LANG_LABEL = { en: 'English', hi: 'Hindi', ta: 'Tamil' };
const SIGN_SOURCE = { notes: "ASHA's note", live_voice: 'ASHA voice (live text)', checklist: 'ASHA', vitals: 'Measured', voice_vitals: 'Voice note', age_rule: 'Age rule', ai_voice: 'AI, voice note', ai_photo: 'AI, photo', system: 'System' };
// Common essential medicines as quick picks for the doctor (names only, no doses: the doctor doses).
const QUICK_MEDICINES = ['Paracetamol', 'ORS', 'Zinc', 'Cetirizine', 'Calamine lotion', 'Permethrin cream', 'Clotrimazole cream', 'Amoxicillin', 'Iron and folic acid', 'Albendazole'];
// Larger facilities for escalation (distances from Jamunamarathur are illustrative).
const HOSPITALS = [
  { name: 'PHC Jamunamarathur (24x7)', sub: 'Block PHC, newborn care, 108 base' },
  { name: 'Government Hospital, Polur', sub: 'Taluk hospital, about 40 km' },
  { name: 'Government Medical College Hospital, Tiruvannamalai', sub: 'District hospital, about 70 km' }
];
const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });

function whenText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === yesterday.toDateString() ? 'Yesterday' : dayFmt.format(d);
  return `${day} ${fmtTime(d)}`;
}
function agoText(date) {
  const min = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}
const firstName = (name) => String(name || 'the ASHA').replace(/\s*\(.*\)\s*$/, '').split(/[\s,]+/)[0];
const realOpen = () => [...sim.cases.values()].filter((c) => c.external);
const realCase = (id) => realOpen().find((c) => c.id === id) || sim.closedCases.find((c) => c.external && c.id === id) || null;

/** Open real cases grouped by village, most urgent first. */
function attentionGroups() {
  const groups = new Map();
  for (const c of realOpen()) {
    if (!groups.has(c.zone)) groups.set(c.zone, []);
    groups.get(c.zone).push(c);
  }
  for (const list of groups.values()) list.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.flaggedAt - b.flaggedAt);
  return [...groups].sort(([, a], [, b]) => LEVEL_ORDER[a[0].level] - LEVEL_ORDER[b[0].level] || a[0].flaggedAt - b[0].flaggedAt);
}

async function loadRealCase(id, { force = false } = {}) {
  let entry = realCases.get(id);
  if (entry && !force && (entry.record || entry.loading)) return entry;
  entry = entry || {};
  entry.loading = true;
  realCases.set(id, entry);
  try {
    const { case: record, asha } = await queueClient.getCase(id);
    entry.record = record;
    entry.asha = asha;
    entry.error = null;
    if (record.media?.photo && !entry.photoUrl) entry.photoUrl = await queueClient.getMediaUrl(id, 'photo').catch(() => null);
  } catch (err) {
    entry.error = String(err.message || err);
  }
  entry.loading = false;
  return entry;
}

/** Redraw the open case panel when its record changed (AI summary arrived, decision sent). */
function redrawRealCase(id) {
  const panel = document.querySelector(`#detail-content .rc[data-case-id="${CSS.escape(id)}"]`);
  if (panel) panel.redraw?.();
}

// ---- Location: the issues from one place ---------------------------------------------------------
function locationDetail(villageId) {
  const v = sim.villages.get(villageId);
  const cases = attentionGroups().find(([id]) => id === villageId)?.[1] || [];
  const body = el('div', { className: 'detail__body' });
  const urgent = cases.filter((c) => c.level === 'URGENT').length;
  body.append(
    el(
      'div',
      { className: 'chips' },
      cases.length ? pill(`${cases.length} case${cases.length === 1 ? '' : 's'} need attention`, urgent ? 'urgent' : 'warning', 'location_on') : pill('Nothing waiting', 'success'),
      ...v.asha.map((a) => pill(`ASHA ${a.name}`, 'real', 'badge'))
    )
  );
  const list = el('ul', { className: 'issue-list' });
  for (const c of cases) list.append(issueCard(c));
  body.append(cases.length ? list : el('p', { className: 'muted md-typescale-body-small' }, 'No open cases from this place right now.'));
  const more = el('md-text-button', {}, icon('cottage', { slot: 'icon' }), `About ${v.name}`);
  more.addEventListener('click', () => select({ type: 'village', id: v.id }, { fly: false }));
  body.append(el('div', { className: 'actions' }, more));
  return [detailHead('location_on', v.name, cases.length ? 'Needs attention: cases from the ASHA app' : `Village, ${BLOCK_NAME}`, { urgent: urgent > 0 }), body];
}

/** One issue in a place: who, what and how urgent, at a glance. */
function issueCard(c) {
  const p = c.patient || {};
  const entry = realCases.get(c.id);
  const ai = entry?.record?.ai;
  const reason = (c.reasons || []).find((r) => r.level === c.level) || (c.reasons || [])[0];
  const gist = ai?.status === 'done' && ai.output?.summaryForDoctor ? ai.output.summaryForDoctor : reason ? describeReason(reason, 'en', { forDoctor: true }) : 'Waiting for the AI to read the photo and voice note.';
  const card = el(
    'button',
    { type: 'button', className: `issue issue--${c.level.toLowerCase()}` },
    el(
      'span',
      { className: 'issue__top' },
      el('span', { className: 'issue__name md-typescale-title-small' }, p.name || 'Patient'),
      !seen.has(c.id) ? el('span', { className: 'pill urgent issue__new' }, 'New') : null,
      pill(CASE_LEVELS[c.level].short, CASE_PILL[c.level])
    ),
    el('span', { className: 'issue__meta md-typescale-body-small' }, [patientMeta(p), `${firstName(c.asha.name)}, ${agoText(c.flaggedAt)}`].join(' · ')),
    el('span', { className: 'issue__gist md-typescale-body-small' }, gist),
    el('span', { className: 'issue__media md-typescale-label-small' }, c.hasPhoto ? el('span', {}, icon('image'), 'Photo') : null, c.hasAudio ? el('span', {}, icon('graphic_eq'), 'Voice note') : null, el('span', {}, icon('arrow_forward'), 'Open'))
  );
  card.addEventListener('click', () => select({ type: 'case', id: c.id }));
  if (!entry && queueClient?.signedIn) loadRealCase(c.id).then(() => card.isConnected && card.replaceWith(issueCard(c)));
  return el('li', {}, card);
}

// ---- One case: AI-organised view and the doctor's answer -----------------------------------------
function caseDetail(id) {
  const c = realCase(id);
  if (!c) return overviewDetail();
  document.body.dataset.panel = 'case';
  const b = sim.buildings.get(c.buildingId);
  const panel = el('div', { className: 'rc', dataset: { caseId: c.id } });
  panel.redraw = () => {
    const keep = panel.querySelector('.rc-decide');
    const draft = keep?.saveDraft?.();
    setChildren(panel, realCaseContent(b, c, realCases.get(c.id), draft));
  };
  panel.redraw();
  if (!realCases.get(c.id)?.record && queueClient?.signedIn) loadRealCase(c.id).then(() => panel.isConnected && panel.redraw());
  return [panel];
}

/** What the worker said: the voice note translated to English, else live text, else her typed note. */
function ashaSaid(record) {
  const o = record.ai?.output;
  if (o?.transcriptEnglish) return { kind: 'voice', text: o.transcriptEnglish, original: o.transcriptOriginal, lang: o.languageDetected && o.languageDetected !== 'none' ? o.languageDetected : record.language };
  const live = record.assessment?.liveTranscript;
  if (live?.original) return { kind: 'live', text: live.english || live.original, original: live.original, lang: record.language };
  if (record.assessment?.notes) return { kind: 'note', text: record.assessment.notes, original: null, lang: record.language };
  return null;
}

function realCaseContent(b, c, entry, draft) {
  const record = entry?.record || null;
  const p = record?.patient || c.patient || {};
  const level = record?.triage?.level || c.level;
  const profile = entry?.asha || ashaProfile(c.asha.id);
  const ashaName = profile?.name || firstName(c.asha.name);
  const v = sim.villages.get(c.zone);
  const sexShort = p.sex === 'female' ? 'F' : p.sex === 'male' ? 'M' : null;
  const age = patientMeta({ ...p, sex: null, pregnant: false });
  const meta = [sexShort, age, p.pregnant ? (p.pregnancyMonths ? `pregnant ${p.pregnancyMonths} months` : 'pregnant') : null, caseLabel(c)].filter(Boolean).join(' · ');
  const back = el('md-text-button', { className: 'rc-back' }, icon('arrow_back', { slot: 'icon' }), `${v?.name || 'Place'} · needs attention`);
  back.addEventListener('click', () => select({ type: 'location', id: c.zone }));
  const head = detailHead('person', p.name || 'Patient', meta, { urgent: level === 'URGENT' });
  const body = el('div', { className: 'detail__body rc__body' });
  appendChildren(body, el('div', { className: 'chips' }, pill(LEVEL_BADGE[level] || level, CASE_PILL[level] || ''), pill('ASHA app', 'real', 'mobile'), pill(v?.name || '', 'info', 'location_on')));

  if (!record) {
    if (entry?.error) {
      const retry = el('md-outlined-button', {}, icon('refresh', { slot: 'icon' }), 'Try again');
      retry.addEventListener('click', () => loadRealCase(c.id, { force: true }).then(() => redrawRealCase(c.id)));
      appendChildren(body, el('p', { className: 'rc-banner warning md-typescale-body-small' }, `Could not load the case (${entry.error}).`), el('div', { className: 'actions' }, retry));
    } else if (!queueClient?.signedIn) {
      appendChildren(body, el('p', { className: 'muted md-typescale-body-small' }, 'Sign in as a doctor to open this case.'));
    } else {
      appendChildren(body, el('md-linear-progress', { indeterminate: true, ariaLabel: 'Loading the case' }), el('p', { className: 'muted md-typescale-body-small' }, 'Loading the case.'));
    }
    return [back, head, body];
  }

  // AI banner: what the AI made of it, clearly labelled. Rules set the floor; the doctor decides.
  const ai = record.ai || { status: 'pending' };
  const o = ai.status === 'done' ? ai.output : null;
  const model = ai.provider === 'mock' ? 'MOCK, no model' : ai.model || 'Gemini';
  if (ai.status === 'pending' || ai.status === 'processing') {
    appendChildren(body, 
      el(
        'div',
        { className: 'rc-banner provisional' },
        el('span', { className: 'rc-tag md-typescale-label-medium' }, 'Provisional · AI reading'),
        el('p', { className: 'md-typescale-body-small' }, 'Gemini is still reading the photo and voice note. The level shown comes from the danger-sign rules and can only go up. Rules stay the floor; you decide.')
      )
    );
  } else if (o) {
    appendChildren(body, 
      el(
        'div',
        { className: 'rc-banner ai' },
        el('span', { className: 'rc-tag md-typescale-label-medium' }, icon('star_shine'), `AI case summary · ${model}`),
        el('p', { className: 'md-typescale-body-medium' }, o.summaryForDoctor),
        o.uncertaintyNotes ? el('p', { className: 'md-typescale-body-small' }, `Uncertain: ${o.uncertaintyNotes}`) : null,
        el('p', { className: 'md-typescale-body-small muted' }, 'AI-generated, describes only what was seen and heard; it does not diagnose. Rules stay the floor; you decide.')
      )
    );
  } else {
    appendChildren(body, el('div', { className: 'rc-banner warning md-typescale-body-small' }, icon('error'), el('span', {}, `AI summary unavailable${ai.error ? ` (${ai.error})` : ''}. Review the photo and note directly; the rules-based level stands.`)));
  }

  // Symptoms and danger signs, each with where it came from.
  const reasons = (record.triage.reasons || []).filter((r) => r.level);
  const symptoms = el('ul', { className: 'rc-symptoms' });
  for (const r of reasons) {
    symptoms.append(
      el(
        'li',
        {},
        el('span', { className: 'grow' }, el('span', { className: 'md-typescale-body-medium' }, describeReason(r, 'en', { forDoctor: true })), el('span', { className: 'muted md-typescale-body-small' }, [SIGN_SOURCE[r.source] || r.source, r.evidence ? `"${r.evidence}"` : null, r.verify ? 'verify' : null].filter(Boolean).join(' · '))),
        pill(CASE_LEVELS[r.level]?.short || r.level, CASE_PILL[r.level] || '')
      )
    );
  }
  const absent = (o?.findings || []).filter((f) => f.status === 'absent').map((f) => signLabel(f.signId));
  appendChildren(body, 
    sectionTitle('sick', 'Symptoms and danger signs'),
    reasons.length ? symptoms : el('p', { className: 'muted md-typescale-body-small' }, 'No danger sign recorded.'),
    absent.length ? el('p', { className: 'muted md-typescale-body-small' }, `Said to be absent: ${absent.join('; ')}.`) : null
  );

  // Photo and what is visible in it.
  if (entry.photoUrl) {
    const shot = el('button', { type: 'button', className: 'rc-photo', ariaLabel: 'Enlarge the photo' }, el('img', { src: entry.photoUrl, alt: `Photo sent by ${ashaName}` }), el('span', { className: 'rc-photo__hint md-typescale-label-medium' }, 'Click to enlarge'));
    shot.addEventListener('click', () => openPhoto(entry.photoUrl, `Photo from ${ashaName} · ${p.name || 'patient'}`));
    appendChildren(body, sectionTitle('image', 'Photo from the ASHA'), shot);
    if (o?.photoObservations?.length) body.append(el('ul', { className: 'rc-bullets md-typescale-body-small' }, ...o.photoObservations.map((x) => el('li', {}, x))), el('p', { className: 'muted md-typescale-label-small' }, `What the AI sees (photo quality: ${o.photoQuality}). Not a diagnosis.`));
  }

  // Voice note translated to English (play only on request: rural data is precious).
  const said = ashaSaid(record);
  if (said) {
    const translated = said.lang && said.lang !== 'en';
    const voice = el(
      'div',
      { className: 'rc-voice' },
      el('p', { className: 'md-typescale-body-large' }, said.text),
      translated ? el('span', { className: 'pill info' }, `${said.kind === 'note' ? 'typed in' : 'translated from'} ${LANG_LABEL[said.lang] || said.lang}`) : null,
      said.original && said.original !== said.text ? el('details', { className: 'md-typescale-body-small' }, el('summary', {}, `Original (${LANG_LABEL[said.lang] || said.lang})`), el('p', {}, said.original)) : null
    );
    if (record.media?.audio) {
      const play = el('md-outlined-button', { className: 'rc-play' }, icon('play_arrow', { slot: 'icon' }), 'Play the voice note');
      play.addEventListener('click', async () => {
        play.disabled = true;
        const e = realCases.get(c.id);
        e.audioUrl = e.audioUrl || (await queueClient.getMediaUrl(c.id, 'audio').catch(() => null));
        if (!e.audioUrl) return void (play.disabled = false);
        const audio = el('audio', { className: 'rc-audio', controls: true, src: e.audioUrl, ariaLabel: `Voice note from ${ashaName}` });
        play.replaceWith(audio);
        audio.play().catch(() => {});
      });
      appendChildren(voice, play);
    }
    appendChildren(body, sectionTitle('record_voice_over', said.kind === 'voice' ? 'Voice note, in English' : said.kind === 'live' ? 'What the ASHA said' : "ASHA's note"), voice);
  }

  // Patient and medical details.
  const kv = el('dl', { className: 'kv rc-kv' });
  const row = (label, ...value) => kv.append(el('dt', { className: 'md-typescale-body-medium' }, label), el('dd', { className: 'md-typescale-body-medium' }, ...value));
  row('Patient', [p.name, patientMeta(p)].filter(Boolean).join(', '));
  const a = record.assessment || {};
  const vitals = [a.temperatureC != null ? `${a.temperatureC} °C` : null, a.breathsPerMin != null ? `${a.breathsPerMin} breaths per minute` : null].filter(Boolean);
  row('Vitals', vitals.length ? vitals.join(', ') : 'Not measured');
  row('History', p.returning ? `Returning patient, visit ${p.visit || 2}` : 'First visit');
  if (a.workerFlag) row('ASHA flag', 'She switched on "I see a danger sign"');
  const who = el('md-text-button', { className: 'row-button rc-who' }, `${ashaName}, ${profile?.village || v?.name || ''}${profile?.travel?.toDoctorKm ? ` · ~${profile.travel.toDoctorKm} km` : ''}`);
  who.addEventListener('click', () => select({ type: 'worker', id: c.asha.id }, { fly: false }));
  row('Sent by', who);
  row('Received', whenText(record.receivedAt));
  if (profile?.travel?.toPhcKm) row('To the PHC', `About ${profile.travel.toPhcKm} km${profile.travel.note ? `. ${profile.travel.note}` : ''}`);
  appendChildren(body, sectionTitle('person', 'Patient and medical details'), kv);
  if (o?.missingInformation?.length) body.append(sectionTitle('help', 'Still unknown'), el('ul', { className: 'rc-bullets md-typescale-body-small' }, ...o.missingInformation.map((x) => el('li', {}, x))));
  if (o?.followUpQuestions?.length) body.append(sectionTitle('chat', 'Questions to ask the ASHA'), el('ul', { className: 'rc-bullets md-typescale-body-small' }, ...o.followUpQuestions.map((q) => el('li', {}, q.english))));
  if (record.guidelines?.length) {
    appendChildren(body, 
      sectionTitle('menu_book', 'Guidance (WHO / MoHFW, draft corpus)'),
      ...record.guidelines.slice(0, 2).map((g) => el('div', { className: 'rc-guide' }, el('strong', { className: 'md-typescale-body-medium' }, g.title), el('p', { className: 'md-typescale-body-small' }, g.action || g.summary), el('span', { className: 'muted md-typescale-label-small' }, `${g.source.publisher}, ${g.source.document}${g.source.year ? ` (${g.source.year})` : ''}`)))
    );
  }

  appendChildren(body, record.decision ? decidedBlock(record, ashaName) : decisionBlock(c, record, ashaName, profile, level, draft));
  appendChildren(body, el('p', { className: 'md-typescale-body-small detail__sub' }, 'Prototype with synthetic or role-play cases: not for clinical use. The case position on the map is approximate. You make every clinical decision.'));
  return [back, head, body];
}

/** The doctor's answer: treat with medicines, escalate to a larger hospital, or ask for more. */
function decisionBlock(c, record, ashaName, profile, level, draft = null) {
  const root = el('div', { className: 'rc-decide' });
  const tabs = el(
    'md-tabs',
    { className: 'rc-tabs', ariaLabel: 'Your decision' },
    el('md-primary-tab', { dataset: { mode: 'treat' } }, 'Medicines'),
    el('md-primary-tab', { dataset: { mode: 'escalate' } }, 'Escalate'),
    el('md-primary-tab', { dataset: { mode: 'ask' } }, 'Ask the ASHA')
  );
  const modes = ['treat', 'escalate', 'ask'];
  let mode = draft?.mode || (level === 'URGENT' ? 'escalate' : 'treat');

  // Treat: medicines the doctor chooses and doses.
  const meds = el('div', { className: 'rc-meds' });
  const addMed = (m = {}) => {
    const name = el('md-outlined-text-field', { label: 'Medicine', value: m.name || '', className: 'rc-med__name' });
    const dose = el('md-outlined-text-field', { label: 'Dose', value: m.dose || '', placeholder: 'e.g. 250 mg, thin layer', className: 'rc-med__dose' });
    const how = el('md-outlined-text-field', { label: 'How often', value: m.how || '', placeholder: 'e.g. twice a day', className: 'rc-med__how' });
    const days = el('md-outlined-text-field', { label: 'Days', type: 'number', min: 1, max: 90, value: m.days ? String(m.days) : '', className: 'rc-med__days' });
    const remove = el('md-icon-button', { ariaLabel: 'Remove this medicine' }, icon('delete'));
    const line = el('div', { className: 'rc-med' }, name, dose, how, days, remove);
    remove.addEventListener('click', () => line.remove());
    meds.append(line);
    return name;
  };
  const quick = el('div', { className: 'rc-quick' });
  for (const n of QUICK_MEDICINES) {
    const chip = el('md-assist-chip', { label: n });
    chip.addEventListener('click', () => addMed({ name: n }).parentElement.querySelector('.rc-med__dose').focus());
    quick.append(chip);
  }
  const addOther = el('md-text-button', {}, icon('add_circle', { slot: 'icon' }), 'Add another medicine');
  addOther.addEventListener('click', () => addMed().focus());
  for (const m of draft?.medicines || []) addMed(m);
  const followDays = el('md-outlined-select', { label: 'Visit again in', className: 'rc-follow' });
  for (const [value, text] of [['', 'No follow-up visit'], ['1', '1 day'], ['2', '2 days'], ['3', '3 days'], ['7', '1 week']]) followDays.append(el('md-select-option', { value, selected: (draft?.followDays || '2') === value }, el('div', { slot: 'headline' }, text)));
  const treatPane = el(
    'div',
    { className: 'rc-pane', dataset: { mode: 'treat' } },
    el('p', { className: 'muted md-typescale-body-small' }, 'Pick or type medicines and give the dose. The ASHA gets your list in her language.'),
    quick,
    meds,
    addOther,
    followDays
  );

  // Escalate: a larger facility, now or within a day.
  const hospitalList = el('div', { className: 'rc-hospitals', role: 'radiogroup', ariaLabel: 'Send the patient to' });
  HOSPITALS.forEach((h) => {
    const radio = el('md-radio', { name: `hospital-${c.id}`, value: h.name, checked: (draft?.hospital || HOSPITALS[level === 'URGENT' ? 0 : 1].name) === h.name });
    hospitalList.append(el('label', { className: 'rc-hospital md-typescale-body-medium' }, radio, el('span', { className: 'grow' }, h.name, el('span', { className: 'muted md-typescale-body-small' }, h.sub))));
  });
  const now = el('md-switch', { selected: draft ? draft.now : level === 'URGENT', ariaLabel: 'Go now and call 108' });
  const escalatePane = el(
    'div',
    { className: 'rc-pane', dataset: { mode: 'escalate' } },
    el('p', { className: 'muted md-typescale-body-small' }, `Send the patient to a larger facility. ${level === 'URGENT' ? 'The danger-sign rules marked this urgent.' : ''}`),
    hospitalList,
    el('label', { className: 'rc-switch md-typescale-body-medium' }, el('span', { className: 'grow' }, 'Go now and call 108 for transport'), now)
  );

  // Ask: questions back to the ASHA.
  const askPane = el('div', { className: 'rc-pane', dataset: { mode: 'ask' } }, el('p', { className: 'muted md-typescale-body-small' }, 'Ask the ASHA for more before deciding. Your questions go to her phone in her language.'));
  const questions = (record.ai?.output?.followUpQuestions || []).map((q) => q.english).join('\n');

  const note = el('md-outlined-text-field', { type: 'textarea', rows: 3, label: `Message for ${ashaName}`, className: 'rc-note', value: draft?.note ?? '' });
  const assessment = el('md-outlined-text-field', { type: 'textarea', rows: 2, label: 'Your assessment (stays in the record)', supportingText: 'Your provisional diagnosis or notes. Not sent to the ASHA.', className: 'rc-assess', value: draft?.assessment || '' });
  const send = el('md-filled-button', { className: 'rc-primary' }, icon('send', { slot: 'icon' }), `Send to ${ashaName}`);
  const status = el('p', { className: 'md-typescale-body-small rc-status', role: 'status' });
  const translateNote = record.language !== 'en' ? `${ashaName} sees it in ${LANG_LABEL[record.language] || record.language} (machine translated) with your original text.` : '';

  const readMeds = () =>
    [...meds.querySelectorAll('.rc-med')]
      .map((line) => ({
        name: String(line.querySelector('.rc-med__name').value || '').trim(),
        dose: String(line.querySelector('.rc-med__dose').value || '').trim(),
        how: String(line.querySelector('.rc-med__how').value || '').trim(),
        days: Number(line.querySelector('.rc-med__days').value) || null
      }))
      .filter((m) => m.name);
  const hospital = () => [...hospitalList.querySelectorAll('md-radio')].find((r) => r.checked)?.value || HOSPITALS[0].name;
  root.saveDraft = () => ({ mode, medicines: readMeds(), note: note.value, assessment: assessment.value, hospital: hospital(), now: now.selected, followDays: followDays.value });

  const showMode = (m) => {
    mode = m;
    for (const pane of root.querySelectorAll('.rc-pane')) pane.hidden = pane.dataset.mode !== m;
    if (m === 'ask' && !note.value && questions) note.value = questions;
    note.label = m === 'ask' ? `Questions for ${ashaName}` : `Message for ${ashaName}${m === 'escalate' ? ' (optional)' : ''}`;
    send.lastChild.data = m === 'escalate' ? `Escalate and tell ${ashaName}` : `Send to ${ashaName}`;
  };
  tabs.addEventListener('change', () => showMode(tabs.activeTab?.dataset.mode || 'treat'));

  send.addEventListener('click', async () => {
    const text = String(note.value || '').trim();
    let body;
    if (mode === 'treat') {
      const list = readMeds();
      if (list.some((m) => !m.dose)) return void (status.textContent = 'Give a dose for every medicine.');
      if (!list.length && !text) return void (status.textContent = 'Add a medicine or a message.');
      const days = Number(followDays.value) || null;
      const follow = days ? new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) : null;
      const lines = list.map((m) => `- ${m.name}, ${m.dose}${m.how ? `, ${m.how}` : ''}${m.days ? `, for ${m.days} day${m.days === 1 ? '' : 's'}` : ''}`);
      const instructions = [text, list.length ? `Medicines:\n${lines.join('\n')}` : null, follow ? `Visit the patient again on ${follow}. Send a new case at once if any danger sign appears.` : 'Send a new case at once if any danger sign appears.'].filter(Boolean).join('\n\n');
      body = { outcome: 'home_care_follow_up', instructions, medicines: list.map((m) => ({ name: m.name, dose: m.dose, ...(m.how ? { how: m.how } : {}), days: m.days })), followUpDate: follow };
    } else if (mode === 'escalate') {
      const where = hospital();
      const instructions = [`Take the patient to ${where} ${now.selected ? 'now. Call 108 for transport.' : 'within 24 hours.'}`, text].filter(Boolean).join('\n\n');
      body = { outcome: 'refer_now', instructions, referTo: where };
    } else {
      if (!text) return void (status.textContent = 'Write your questions for the ASHA.');
      body = { outcome: 'need_more_info', instructions: text };
    }
    const own = String(assessment.value || '').trim();
    if (own) body.assessment = own;
    send.disabled = true;
    status.textContent = `Sending to ${ashaName}.`;
    try {
      const updated = await queueClient.decide(c.id, body);
      const e = realCases.get(c.id) || {};
      e.record = updated;
      realCases.set(c.id, e);
      announce(`Sent to ${ashaName}: ${OUTCOME_TEXT[body.outcome]}`);
      redrawRealCase(c.id);
    } catch (err) {
      status.textContent = `Could not send (${err.message}). Try again.`;
      send.disabled = false;
    }
  });

  appendChildren(root, sectionTitle('stethoscope', 'Your decision'), tabs, treatPane, escalatePane, askPane, note, assessment, translateNote ? el('p', { className: 'muted md-typescale-body-small' }, translateNote) : null, send, status);
  requestAnimationFrame(() => {
    tabs.activeTabIndex = modes.indexOf(mode);
    showMode(mode);
  });
  showMode(mode);
  return root;
}

function decidedBlock(record, ashaName) {
  const d = record.decision;
  const banner = el(
    'div',
    { className: 'rc-banner done' },
    el('span', { className: 'rc-tag md-typescale-label-medium' }, icon('check_circle'), `Sent to ${ashaName} · ${OUTCOME_TEXT[d.outcome] || d.outcome} · ${fmtTime(new Date(d.at))}`),
    el('p', { className: 'md-typescale-body-medium rc-pre' }, d.instructions),
    d.translated ? el('p', { className: 'md-typescale-body-small muted rc-pre' }, `${ashaName} sees (${LANG_LABEL[d.translated.lang] || d.translated.lang}, machine translated): ${d.translated.text}`) : null,
    d.translationError ? el('p', { className: 'md-typescale-body-small muted' }, `Translation failed; ${ashaName} sees your original text.`) : null,
    d.assessment ? el('p', { className: 'md-typescale-body-small' }, `Your assessment: ${d.assessment}`) : null
  );
  if (!d.medicines?.length) return banner;
  return el('div', { className: 'rc-decided' }, banner, deliveryBlock(record));
}

/** Next step after a prescription: find the medicines on the map, or follow the bike bringing them. */
function deliveryBlock(record) {
  const dsp = record.dispatch;
  const box = el('div', { className: 'rc-delivery' });
  if (!dsp) {
    const find = el('md-filled-tonal-button', { className: 'rc-find' }, icon('radar', { slot: 'icon' }), 'Look for medicines');
    find.addEventListener('click', () => select({ type: 'medfind', id: record.id }));
    appendChildren(
      box,
      sectionTitle('local_pharmacy', 'Get the medicines to the patient'),
      el('p', { className: 'muted md-typescale-body-small' }, 'Scan the block for PHC pharmacies, sub-centres and medical shops that have these medicines, then send a bike to the patient.'),
      el('div', { className: 'actions' }, find)
    );
    return box;
  }
  const runId = rx.byCase.get(record.id);
  const stops = dsp.stops.map((s) => s.name).join(', ');
  const delivered = dsp.status === 'delivered';
  appendChildren(
    box,
    sectionTitle(delivered ? 'check_circle' : 'electric_moped', delivered ? 'Medicines delivered' : 'Medicines on the way'),
    el(
      'p',
      { className: 'md-typescale-body-medium' },
      delivered
        ? `${dsp.courier.name} delivered the medicines${dsp.deliveredAt ? ` at ${fmtTime(new Date(dsp.deliveredAt))}` : ''}. Collected from ${stops}.`
        : `${dsp.courier.name} (${dsp.courier.id}) is collecting from ${stops} and bringing them to the patient. About ${dsp.etaMin} min, ${fmtKm(dsp.distanceKm)}.`
    ),
    dsp.missing?.length ? el('p', { className: 'rc-banner warning md-typescale-body-small' }, icon('warning'), el('span', {}, `Not found nearby: ${dsp.missing.join(', ')}. Tell the ASHA how to get them.`)) : null
  );
  if (runId && !delivered) {
    const track = el('md-filled-tonal-button', {}, icon('my_location', { slot: 'icon' }), `Track ${runId}`);
    track.addEventListener('click', () => select({ type: 'run', id: runId }));
    appendChildren(box, el('div', { className: 'actions' }, track));
  }
  return box;
}

function openPhoto(url, title) {
  $('#photo-large').src = url;
  $('#photo-large').alt = title;
  $('#photo-headline').textContent = title;
  $('#photo-dialog').show();
}

// ---- Medicine finder: scan the map, choose where to collect, send one bike to the patient ------------
// Stock and distances are simulated demo data. The doctor chooses the places; the bike collects in
// nearest-next order and the dispatch is saved on the server so the ASHA's phone shows it.
const rx = { byCase: new Map(), pending: new Set() }; // case id -> run id; dispatches being saved
const medfind = { caseId: null, keys: new Set(), timers: [], nodes: new Map() };
const SCAN_LIFE = 2.6;
const srcOf = (id) => sim.sources.find((s) => s.id === id) || null;
const srcTop = (s) => (s.centre ? 1.2 : (s.shop?.building.h ?? s.hwc?.building.h ?? 2) + 0.4);
const medNames = (record) => (record?.decision?.medicines || []).map((m) => m.name);
const shortMed = (name) => String(name).split(/[\s(]/)[0];
const round1 = (n) => Math.round(n * 10) / 10;

function medfindDistance(c) {
  const b = sim.buildings.get(c.buildingId);
  const names = medNames(realCases.get(c.id)?.record);
  const places = names.length ? sim.findMedicineSources(names, b.id).filter((f) => f.covered > 0) : sim.sources;
  const far = places.reduce((m, s) => Math.max(m, Math.hypot(s.x - b.x, s.z - b.z)), 0);
  return Math.min(150, Math.max(80, far * 2));
}

function clearMedMarkers() {
  for (const timer of medfind.timers) clearTimeout(timer);
  medfind.timers = [];
  for (const key of medfind.keys) {
    view?.actors.removeBeacon(key);
    removeLabel(key);
  }
  medfind.keys.clear();
  medfind.nodes.clear();
}

function clearMedFind() {
  if (!medfind.caseId) return;
  clearMedMarkers();
  medfind.caseId = null;
  if (!['run', 'vehicle'].includes(state.selected?.type)) view?.actors.setRoute(null);
}

/** One sentence for a pickup plan: who collects from where, how far and how long. */
function planText(plan) {
  if (!plan?.stops.length) return 'No chosen place has a prescribed medicine.';
  const where = plan.stops.map((s) => s.name).join(', then ');
  if (!plan.courier) return `Collect from ${where}. No bike is free right now.`;
  return `${plan.courier.name} (${plan.courier.id}) from ${plan.courier.base} collects from ${where}, then rides to the patient. ${fmtKm(plan.distanceKm)}, about ${plan.etaMin} min.`;
}

function medfindDetail(id) {
  const c = realCase(id);
  if (!c) return overviewDetail();
  document.body.dataset.panel = 'case';
  const entry = realCases.get(id);
  const record = entry?.record;
  const p = record?.patient || c.patient || {};
  const v = sim.villages.get(c.zone);
  const back = el('md-text-button', { className: 'rc-back' }, icon('arrow_back', { slot: 'icon' }), `Back to ${p.name || 'the case'}`);
  back.addEventListener('click', () => select({ type: 'case', id }));
  const head = detailHead('radar', 'Look for medicines', `For ${p.name || 'the patient'} · ${v?.name || ''}`);
  const body = el('div', { className: 'detail__body rx' });
  if (!record) {
    if (queueClient?.signedIn) loadRealCase(id).then(() => state.selected?.type === 'medfind' && state.selected.id === id && renderDetail());
    appendChildren(body, el('md-linear-progress', { indeterminate: true, ariaLabel: 'Loading the prescription' }));
    return [back, head, body];
  }
  const names = medNames(record);
  if (!names.length || record.dispatch) {
    appendChildren(body, record.dispatch ? deliveryBlock(record) : el('p', { className: 'muted md-typescale-body-small' }, 'Prescribe medicines on the case first.'));
    return [back, head, body];
  }

  const rescan = medfind.caseId !== id;
  clearMedMarkers();
  medfind.caseId = id;
  const home = sim.buildings.get(c.buildingId);
  const found = sim.findMedicineSources(names, home.id);
  const withStock = found.filter((f) => f.covered > 0);
  const none = found.filter((f) => f.covered === 0);
  const suggestion = sim.planPickup(names, home.id);
  const chosen = new Set(suggestion.stops.map((s) => s.id));
  let plan = suggestion;

  appendChildren(
    body,
    el('div', { className: 'chips' }, ...names.map((n) => (matchMedicine(n) ? pill(n, 'info', 'medication') : pill(`${n}: not in the stock list`, 'warning', 'help'))))
  );
  const scanStatus = el('p', { className: 'rx-scan md-typescale-body-small', role: 'status' });
  const scanned = () => (scanStatus.textContent = `${withStock.length} of ${found.length} places in the block have at least one of these medicines.`);
  appendChildren(body, scanStatus);

  // Suggested round: the fewest places nearest the patient that together have everything.
  const useIt = el('md-outlined-button', {}, icon('check_circle', { slot: 'icon' }), 'Use suggestion');
  appendChildren(
    body,
    el(
      'div',
      { className: 'rx-suggest' },
      el('span', { className: 'rc-tag md-typescale-label-medium' }, icon('star_shine'), 'Suggested pickup'),
      el('p', { className: 'md-typescale-body-small' }, planText(suggestion)),
      suggestion.missing.length ? el('p', { className: 'md-typescale-body-small' }, `Not found anywhere in the block: ${suggestion.missing.join(', ')}.`) : null,
      el('div', { className: 'actions' }, useIt)
    )
  );

  // Every place that has at least one medicine, nearest the patient first among equals.
  const list = el('ul', { className: 'rx-sources' });
  const boxes = new Map();
  const toggle = (sid, on = !chosen.has(sid)) => {
    if (on) chosen.add(sid);
    else chosen.delete(sid);
    update();
  };
  for (const f of withStock) {
    const box = el('md-checkbox', { checked: chosen.has(f.id), ariaLabel: `Collect from ${f.name}` });
    box.addEventListener('change', () => toggle(f.id, box.checked));
    boxes.set(f.id, box);
    const locate = el('md-icon-button', { ariaLabel: `Show ${f.name} on the map` }, icon('my_location'));
    locate.addEventListener('click', () => view?.controls.flyTo({ x: f.x, z: f.z, distance: 40 }));
    const stock = el(
      'span',
      { className: 'rx-stock' },
      ...f.rows.map((r) => pill(r.units ? `${shortMed(r.medicine || r.name)} ${r.units} ${r.unit}` : `${shortMed(r.medicine || r.name)} out`, r.level === 'ok' ? 'success' : r.level === 'low' ? 'warning' : ''))
    );
    list.append(
      el(
        'li',
        { className: 'rx-source', dataset: { source: f.id } },
        el('label', { className: 'rx-source__pick' }, box, el('span', { className: 'grow' }, el('span', { className: 'md-typescale-title-small' }, f.name), el('span', { className: 'muted md-typescale-body-small' }, `${f.kindLabel} · ${fmtKm(f.km)} from the patient · ${f.covered} of ${f.total}`))),
        locate,
        stock
      )
    );
  }
  appendChildren(body, sectionTitle('local_pharmacy', `Places with stock (${withStock.length})`), withStock.length ? list : el('p', { className: 'muted md-typescale-body-small' }, 'None of the prescribed medicines is in stock in the block.'));
  if (none.length) body.append(el('details', { className: 'rx-none md-typescale-body-small' }, el('summary', {}, `Out of stock at ${none.length} place${none.length === 1 ? '' : 's'}`), el('p', {}, none.map((f) => f.name).join(', '))));

  // The round the doctor has chosen.
  const round = el('div', { className: 'rx-round' });
  const send = el('md-filled-button', { className: 'rc-primary rx-send' }, icon('electric_moped', { slot: 'icon' }), 'Send bike');
  const status = el('p', { className: 'md-typescale-body-small rc-status', role: 'status' });
  appendChildren(body, sectionTitle('route', 'Your pickup round'), round, send, status, el('p', { className: 'md-typescale-body-small detail__sub' }, 'Stock, distances and bikes are simulated for this demo. The pharmacist checks every medicine and dose before it leaves.'));

  function update() {
    plan = chosen.size ? sim.planPickup(names, home.id, [...chosen]) : null;
    for (const [sid, box] of boxes) if (box.checked !== chosen.has(sid)) box.checked = chosen.has(sid);
    const order = new Map((plan?.stops || []).map((s, k) => [s.id, k + 1]));
    for (const [sid, n] of medfind.nodes) {
      const k = order.get(sid);
      n.node.classList.toggle('map-label--chosen', chosen.has(sid));
      n.num.textContent = k ? String(k) : '';
      n.num.hidden = !k;
      const beacon = view?.actors.beacons.get(`med:${sid}`);
      if (beacon) beacon.pulse = chosen.has(sid);
    }
    view?.actors.setRoute(plan?.courier ? sim.planRoute(plan) : null, accents.primary);
    const unused = [...chosen].filter((sid) => !order.has(sid)).map((sid) => withStock.find((f) => f.id === sid)?.name).filter(Boolean);
    setChildren(
      round,
      plan?.stops.length
        ? el('ol', { className: 'rx-stops' }, ...plan.stops.map((s) => el('li', { className: 'md-typescale-body-small' }, el('strong', {}, s.name), `: ${s.items.map((i) => i.name).join(', ')}${s.atBase ? ' (at the bike base)' : ''}`)))
        : el('p', { className: 'muted md-typescale-body-small' }, 'Tick the places the bike should collect from.'),
      plan?.stops.length
        ? el('div', { className: 'stats' }, ...[['Stops', String(plan.stops.length)], ['Distance', fmtKm(plan.distanceKm)], ['ETA', plan.etaMin ? `${plan.etaMin} min` : 'n/a']].map(([label, value]) => el('div', { className: 'stat' }, el('span', { className: 'stat__value md-typescale-title-medium' }, value), el('span', { className: 'stat__label md-typescale-label-small' }, label))))
        : null,
      plan?.stops.length ? el('p', { className: 'md-typescale-body-small' }, plan.courier ? `Bike: ${plan.courier.name} (${plan.courier.id}), ${plan.courier.base}` : 'No bike is free right now. Try again in a minute.') : null,
      unused.length ? el('p', { className: 'muted md-typescale-body-small' }, `Not needed: ${unused.join(', ')} (a nearer chosen place has the same medicines).`) : null,
      plan?.missing.length ? el('p', { className: 'rc-banner warning md-typescale-body-small' }, icon('warning'), el('span', {}, `Still missing: ${plan.missing.join(', ')}. Choose another place, or tell the ASHA.`)) : null
    );
    send.disabled = !plan?.stops.length || !plan.courier;
  }

  useIt.addEventListener('click', () => {
    chosen.clear();
    for (const s of suggestion.stops) chosen.add(s.id);
    update();
  });

  send.addEventListener('click', async () => {
    const fresh = sim.planPickup(names, home.id, [...chosen]);
    if (!fresh.stops.length) return void (status.textContent = 'Choose at least one place that has a prescribed medicine.');
    if (!fresh.courier) return void (status.textContent = 'No bike is free right now. Try again in a minute.');
    send.disabled = true;
    status.textContent = `Sending ${fresh.courier.name}.`;
    rx.pending.add(id);
    try {
      const updated = await queueClient.dispatch(id, {
        stops: fresh.stops.map((s) => ({ id: s.id, name: s.name, kind: s.kind, items: s.items.map((i) => i.name), km: s.km == null ? null : round1(s.km) })),
        courier: { id: fresh.courier.id, name: fresh.courier.name },
        distanceKm: round1(fresh.distanceKm),
        etaMin: fresh.etaMin,
        missing: fresh.missing
      });
      const e = realCases.get(id) || {};
      e.record = updated;
      realCases.set(id, e);
      const run = startRx(id, home.id, updated);
      announce(`${fresh.courier.name} is on the way to collect the medicines for ${p.name || 'the patient'}.`);
      select(run ? { type: 'run', id: run.id } : { type: 'case', id });
    } catch (err) {
      status.textContent = /409/.test(err.message) ? 'Medicines for this case were already sent.' : `Could not send (${err.message}). Try again.`;
      send.disabled = false;
    } finally {
      rx.pending.delete(id);
    }
  });

  // Map: a scan spreads from the home; each place lights up as the scan reaches it.
  const radius = Math.max(20, ...withStock.map((f) => Math.hypot(f.x - home.x, f.z - home.z) + 6));
  const reveal = (f) => {
    const key = `med:${f.id}`;
    const src = srcOf(f.id);
    view?.actors.addBeacon(key, { x: f.x, z: f.z, top: srcTop(src), hex: f.covered === f.total ? accents.success : accents.warning, pulse: chosen.has(f.id) });
    const num = el('span', { className: 'map-label__num', hidden: true });
    const label = addLabel({
      key,
      anchor: () => ({ x: f.x, y: srcTop(src) + 6.4, z: f.z }),
      onClick: () => toggle(f.id),
      build(node) {
        node.classList.add('map-label--med', f.covered === f.total ? 'map-label--all' : 'map-label--some');
        node.append(num, icon(SOURCE_ICON[f.kind]), el('span', { className: 'label__text' }, el('span', {}, f.name), el('span', { className: 'label__sub' }, `${f.covered}/${f.total} in stock · ${fmtKm(f.km)}`)));
        node.setAttribute('aria-label', `${f.name}: ${f.covered} of ${f.total} medicines in stock, ${fmtKm(f.km)} from the patient. Choose or remove`);
      }
    });
    medfind.keys.add(key);
    medfind.nodes.set(f.id, { node: label.node, num });
    update();
  };
  if (rescan && view && !reducedMotion) {
    view.actors.scan(home.x, home.z, radius, accents.primary);
    scanStatus.textContent = `Scanning ${found.length} pharmacies, sub-centres and medical shops in the block.`;
    for (const f of withStock) {
      const d = Math.hypot(f.x - home.x, f.z - home.z);
      const k = 1 - Math.cbrt(Math.max(0, 1 - d / radius));
      medfind.timers.push(setTimeout(() => reveal(f), k * SCAN_LIFE * 1000));
    }
    medfind.timers.push(setTimeout(scanned, SCAN_LIFE * 1000));
  } else {
    for (const f of withStock) reveal(f);
    scanned();
  }
  update();
  return [back, head, body];
}

/** Start the bike for a saved dispatch (just sent here, sent from another screen, or after a reload). */
function startRx(caseId, homeId, record) {
  if (rx.byCase.has(caseId)) return runOf(rx.byCase.get(caseId));
  const d = record.dispatch;
  const common = { caseId, homeId, names: medNames(record), patientName: record.patient?.name || null, doctorName: d.by?.name || record.decision?.by?.name || null };
  const run = sim.dispatchPrescription({ ...common, stopIds: d.stops.map((s) => s.id), courierId: d.courier.id }) || sim.dispatchPrescription({ ...common, stopIds: null });
  if (!run) return null;
  rx.byCase.set(caseId, run.id);
  run.stops.forEach((s, k) => {
    if (s.atBase) return;
    const src = srcOf(s.id);
    const key = `rxstop:${run.id}:${s.id}`;
    view?.actors.addBeacon(key, { x: src.x, z: src.z, top: srcTop(src), hex: accents.primary, pulse: true });
    addLabel({
      key,
      small: true,
      anchor: () => ({ x: src.x, y: srcTop(src) + 6.4, z: src.z }),
      onClick: () => select({ type: 'run', id: run.id }),
      build(node) {
        node.append(icon('local_pharmacy'), el('span', {}, `${run.id} stop ${k + 1} · ${s.name}`));
        node.setAttribute('aria-label', `${run.id}, stop ${k + 1}: ${s.name}. Show the delivery`);
      }
    });
  });
  return run;
}

function clearRxStops(run) {
  for (const s of run.stops || []) {
    view?.actors.removeBeacon(`rxstop:${run.id}:${s.id}`);
    removeLabel(`rxstop:${run.id}:${s.id}`);
  }
}

/** Resume a dispatch that is on the way but has no bike on this screen yet. */
async function resumeDispatch(caseId) {
  if (rx.byCase.has(caseId) || rx.pending.has(caseId)) return;
  rx.pending.add(caseId);
  try {
    const entry = await loadRealCase(caseId, { force: true });
    const record = entry.record;
    if (record?.dispatch?.status !== 'on_the_way' || rx.byCase.has(caseId)) return;
    const home = sim.homeOf({ id: record.id, village: record.worker?.village || record.patient?.village || null, workerId: record.worker?.id || null });
    if (home) startRx(caseId, home.id, record);
  } catch {
    // The next refresh or event tries again.
  } finally {
    rx.pending.delete(caseId);
  }
}
// ---- Rural worker (ASHA) profile -----------------------------------------------------------------
function ashaProfile(id) {
  return queue.ashas?.find((a) => a.id === id) || null;
}

function villageOfAsha(id) {
  const prof = ashaProfile(id);
  const byName = prof && villageList.find((v) => v.name.toLowerCase() === String(prof.village).toLowerCase());
  return byName || villageList.find((v) => v.asha.some((a) => a.id === id)) || null;
}

function workerDetail(id) {
  const prof = ashaProfile(id);
  const v = villageOfAsha(id);
  const synthetic = v?.asha.find((a) => a.id === id);
  const name = prof?.name || synthetic?.name || 'ASHA worker';
  const body = el('div', { className: 'detail__body' });
  const real = Boolean(prof);
  body.append(el('div', { className: 'chips' }, pill(real ? 'ASHA app user' : 'Simulated ASHA', real ? 'real' : '', 'badge'), pill(v?.name || prof?.village || '', 'info', 'location_on')));
  const open = () => [...sim.cases.values()].filter((c) => c.asha.id === id);
  body.append(
    el(
      'div',
      { className: 'stats' },
      stat('Cases today', () => (prof ? prof.casesToday : '-')),
      stat('Open cases', () => open().length),
      stat('Households', () => prof?.households ?? (v ? sim.buildings.get(v.houses[0])?.households || '-' : '-'))
    )
  );
  const kv = el('dl', { className: 'kv' });
  const row = (label, value) => value && kv.append(el('dt', { className: 'md-typescale-body-small' }, label), el('dd', { className: 'md-typescale-body-small' }, String(value)));
  row('Village', prof ? `${prof.village}, ${prof.block}` : v?.name);
  row('District', prof?.district ? `${prof.district}, ${prof.state}` : `${DISTRICT_NAME}, Tamil Nadu`);
  row('PHC', prof?.phc);
  row('Doctor', prof?.doctorId && queue.doctor?.id === prof.doctorId ? `${queue.doctor.name} (you)` : prof?.doctorId ? 'Assigned doctor' : null);
  row('ASHA since', prof?.since);
  row('Population covered', prof?.population);
  row('Language', prof?.language ? LANG_LABEL[prof.language] || prof.language : null);
  row('Phone', prof?.phone);
  row('To the PHC', prof?.travel?.toPhcKm ? `About ${prof.travel.toPhcKm} km` : null);
  row('To you', prof?.travel?.toDoctorKm ? `About ${prof.travel.toDoctorKm} km` : null);
  row('Travel', prof?.travel?.note);
  row('Last case', prof?.lastCaseAt ? whenText(prof.lastCaseAt) : null);
  body.append(sectionTitle('badge', 'Profile'), kv);
  const list = el('ul', { className: 'list' });
  detailBinds.run(() => {
    const items = open();
    const key = items.map((c) => `${c.id}:${c.level}`).join(',');
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    setChildren(list, items.length ? items.map(caseListItem) : el('li', { className: 'muted md-typescale-body-small' }, 'No open cases'));
  });
  body.append(sectionTitle('warning', 'Open cases from this ASHA'), list);
  if (v) {
    const go = el('md-filled-tonal-button', {}, icon('cottage', { slot: 'icon' }), `Show ${v.name}`);
    go.addEventListener('click', () => select({ type: 'village', id: v.id }));
    body.append(el('div', { className: 'actions' }, go));
  }
  if (!real) body.append(el('p', { className: 'md-typescale-body-small detail__sub' }, 'Simulated ASHA for the demo block. Sign in as a doctor to see the profiles of ASHA workers who use the app.'));
  return [detailHead('badge', name, `ASHA worker, ${v?.name || prof?.village || BLOCK_NAME}`), body];
}

function hwcDetail(b) {
  const h = sim.hwcs.get(b.id);
  const body = el('div', { className: 'detail__body' });
  body.append(el('div', { className: 'chips' }, boundPill(() => (h.staff.some((s) => s.status === 'present') ? 'Open' : 'Staff on field visits'), () => (h.staff.some((s) => s.status === 'present') ? 'success' : 'warning')), pill(zoneName(b.zone), 'info', 'location_on')));
  body.append(el('div', { className: 'stats' }, stat('Seen today', () => h.seenToday), stat('Staff present', () => `${h.staff.filter((s) => s.status === 'present').length} of ${h.staff.length}`), stat('Open cases', () => sim.villageStats(b.zone).urgent + sim.villageStats(b.zone).priority)));
  const staff = el('ul', { className: 'list' });
  for (const s of h.staff) staff.append(el('li', {}, el('div', { className: 'grow' }, el('span', { className: 'md-typescale-body-medium' }, s.name), el('span', { className: 'muted md-typescale-body-small' }, s.title)), boundPill(() => STAFF_STATUS[s.status], () => STAFF_PILL[s.status])));
  body.append(sectionTitle('groups', 'Staff'), staff);
  const stock = el('ul', { className: 'list' });
  for (const id of Object.keys(h.stock)) stock.append(stockRow(CATALOGUE[id].name, () => h.stock[id]));
  body.append(sectionTitle('medication', 'Medicine stock'), stock);
  const runsList = el('ul', { className: 'list' });
  detailBinds.run(() => {
    const related = [...sim.runs.values()].filter((r) => r.to.id === b.id);
    const key = related.map((r) => `${r.id}:${r.status}`).join(',');
    if (runsList.dataset.key === key) return;
    runsList.dataset.key = key;
    setChildren(runsList, related.length ? related.map(runListItem) : el('li', { className: 'muted md-typescale-body-small' }, 'No supplies on the way'));
  });
  body.append(sectionTitle('route', 'Supplies on the way'), runsList);
  return [detailHead('local_hospital', b.name, `${BUILDING_KIND.hwc}, ${zoneName(b.zone)}`), body];
}

function stockRow(name, level) {
  const bar = el('md-linear-progress', { ariaLabel: `${name} stock` });
  const wrap = el('span', { className: 'bar' }, bar);
  const pct = el('span', { className: 'md-typescale-label-small' });
  wrap.append(pct);
  detailBinds.prop(bar, 'value', () => Math.round(level() * 100) / 100);
  detailBinds.text(pct, () => `${Math.round(level() * 100)}%`);
  detailBinds.run(() => {
    const cls = `bar ${level() < 0.12 ? 'error' : level() < 0.25 ? 'warning' : ''}`.trim();
    if (wrap.className !== cls) wrap.className = cls;
  });
  return el('li', {}, el('span', { className: 'grow md-typescale-body-small' }, name), wrap);
}

function landmarkDetail(id) {
  const l = sim.landmarks.get(id);
  const body = el('div', { className: 'detail__body' });
  body.append(el('div', { className: 'chips' }, pill('Landmark', ''), pill(zoneName(l.zone), 'info', 'location_on')), el('p', { className: 'md-typescale-body-medium' }, l.info));
  const kv = el('dl', { className: 'kv' });
  const near = nearestCentre(l);
  if (l.kind === 'temple') appendChildren(kv, kvRow('Crowd level', () => (sim.season.id === 'festival' ? 'High (festival)' : 'Normal')));
  if (l.kind === 'lake') appendChildren(kv, kvRow('Water level', () => (sim.season.id === 'monsoon' ? 'High, monsoon' : 'Normal')));
  if (l.kind === 'busstand') appendChildren(kv, kvRow('Next bus to PHC Jamunamarathur', () => `In ${30 - (Math.floor(sim.time * SIM_MINUTES_PER_SECOND) % 30)} min`));
  appendChildren(kv, kvRow('Nearest health centre', () => `${near.c.name}, about ${fmtKm(near.d)}`));
  body.append(kv);
  return [detailHead(LANDMARK_ICON[l.kind] || 'location_on', l.name, zoneName(l.zone)), body];
}

function runDetail(id) {
  const run = runOf(id);
  if (!run) return overviewDetail();
  const body = el('div', { className: 'detail__body' });
  const from = sim.centres.get(run.from);
  body.append(el('div', { className: 'chips' }, boundPill(() => run.steps[run.status].label, () => (run.type === 'referral' ? 'urgent' : run.status >= 5 ? 'success' : 'info')), pill(run.typeLabel, '')));
  const rxRun = run.type === 'prescription';
  body.append(el('div', { className: 'stats' }, stat('ETA', () => (run.status >= 5 ? 'Done' : run.etaMin ? `${run.etaMin} min` : 'n/a')), stat('Distance', () => fmtKm(run.distanceKm)), stat(run.type === 'referral' ? 'Urgency' : rxRun ? 'Stops' : 'Value', () => (run.type === 'referral' ? 'Urgent' : rxRun ? `${run.stops.filter((s) => s.collectedAt).length} of ${run.stops.length}` : rupees.format(run.value)))));
  const kv = el('dl', { className: 'kv' });
  appendChildren(kv, kvRow(rxRun ? 'Bike base' : 'From', () => from.name), kvRow('To', () => (rxRun && run.patientName ? `${run.patientName}, ${run.to.name}` : run.to.name)), kvRow(rxRun ? 'Prescribed by' : 'Requested by', () => run.requester));
  if (run.vehicleId) appendChildren(kv, kvRow('Vehicle', () => `${run.vehicleId} · ${sim.fleet.get(run.vehicleId).name}`));
  if (run.coldChain) appendChildren(kv, kvRow('Cold box', () => (run.boxTempC === null ? 'Ready' : `${run.boxTempC.toFixed(1)} °C`)));
  body.append(kv);
  if (rxRun) {
    body.append(
      sectionTitle('local_pharmacy', 'Pickup round'),
      el(
        'ol',
        { className: 'list rx-run-stops' },
        run.stops.map((s) =>
          el(
            'li',
            {},
            el('div', { className: 'grow' }, el('span', { className: 'md-typescale-body-medium' }, s.name), el('span', { className: 'muted md-typescale-body-small' }, s.items.map((i) => i.name).join(', '))),
            pill(s.collectedAt ? `Collected ${fmtTime(s.collectedAt)}` : 'To collect', s.collectedAt ? 'success' : 'info')
          )
        )
      )
    );
    if (run.missing?.length) body.append(el('p', { className: 'rc-banner warning md-typescale-body-small' }, icon('warning'), el('span', {}, `Not found nearby: ${run.missing.join(', ')}.`)));
    if (run.caseId && realCase(run.caseId)) {
      const toCase = el('md-text-button', {}, icon('arrow_back', { slot: 'icon' }), `Back to ${run.patientName || 'the case'}`);
      toCase.addEventListener('click', () => select({ type: 'case', id: run.caseId }));
      body.append(el('div', { className: 'actions' }, toCase));
    }
  } else if (run.items.length) {
    body.append(sectionTitle('inventory_2', 'Items'), el('ul', { className: 'list' }, run.items.map((i) => el('li', {}, el('span', { className: 'grow md-typescale-body-small' }, i.name), el('span', { className: 'md-typescale-label-medium' }, `${i.qty} ${i.unit}`)))));
  }
  if (run.type === 'referral') body.append(el('p', { className: 'md-typescale-body-small detail__sub' }, `${run.patient.label}. Danger signs flagged by the ASHA worker using the danger-sign rules; the receiving doctor makes the clinical decision.`));
  return [detailHead(RUN_ICON[run.type] || 'medication', run.id, `${run.typeLabel} to ${run.to.name}`, { urgent: run.type === 'referral' }), body];
}

// ---- Tracker ------------------------------------------------------------------------------------
const trackerBinds = binder();

function pickTrackedRun() {
  const current = state.trackedRunId ? runOf(state.trackedRunId) : null;
  if (current && (sim.runs.has(current.id) || sim.time - (current.doneT ?? 0) < 6)) return current;
  state.trackedPinned = false;
  const active = [...sim.runs.values()];
  const moving = active.filter((r) => r.status >= 3 && r.status < 5).sort((a, b) => (a.type === 'referral' ? -1 : 0) - (b.type === 'referral' ? -1 : 0) || b.createdT - a.createdT);
  return moving[0] || active.sort((a, b) => b.createdT - a.createdT)[0] || null;
}

function renderTracker() {
  const panel = $('#tracker-content');
  trackerBinds.reset();
  const run = pickTrackedRun();
  state.trackedRunId = run?.id || null;
  panel.dataset.run = run?.id || '';
  if (!run) {
    setChildren(panel, el('div', { className: 'empty' }, icon('route'), el('p', { className: 'md-typescale-body-medium' }, 'No active runs right now')));
    return;
  }
  $('#tracker').classList.toggle('urgent-run', run.type === 'referral');
  const livePill = el('span', { className: 'pill' });
  trackerBinds.text(livePill, () => (sim.runs.has(run.id) ? 'Live' : 'Done'));
  trackerBinds.run(() => {
    const cls = `pill ${sim.runs.has(run.id) ? (run.type === 'referral' ? 'urgent' : 'info') : 'success'}`;
    if (livePill.className !== cls) livePill.className = cls;
  });
  const meta = run.type === 'referral' ? run.patient.label : run.type === 'prescription' ? `For ${run.patientName || 'the patient'} · ${run.stops.length} stop${run.stops.length === 1 ? '' : 's'}` : `${run.items.length} item${run.items.length === 1 ? '' : 's'} · ${rupees.format(run.value)}`;
  const title = el('md-text-button', { className: 'row-button' }, `${run.typeLabel} ${run.id}`);
  title.addEventListener('click', () => select({ type: 'run', id: run.id }));
  const head = el('div', { className: 'tracker__head' }, icon(RUN_ICON[run.type] || 'medication'), el('div', { className: 'tracker__title md-typescale-title-small' }, title, livePill), el('span', { className: 'tracker__meta md-typescale-label-medium' }, meta));
  const steps = el('ol', { className: 'steps', ariaLabel: 'Progress' });
  run.steps.forEach((s, k) => {
    const time = el('span', { className: 'step__time' });
    const li = el('li', { className: 'step' }, el('span', { className: 'step__dot' }, icon(STEP_ICONS[run.type][k])), el('span', { className: 'step__label' }, s.label), time);
    trackerBinds.run(() => {
      const cls = `step${k < run.status || (k === run.status && run.status === 5) ? ' done' : k === run.status ? ' current' : ''}`;
      if (li.className !== cls) li.className = cls;
      li.setAttribute('aria-current', k === run.status ? 'step' : 'false');
    });
    trackerBinds.text(time, () => (s.at ? fmtTime(s.at) : k === 5 && run.etaMin ? `in ${run.etaMin} min` : ''));
    steps.append(li);
  });
  const f = run.vehicleId ? sim.fleet.get(run.vehicleId) : null;
  let courier = null;
  if (f) {
    const sub = el('span', { className: 'courier__sub md-typescale-body-small' });
    trackerBinds.text(sub, () => (run.status >= 5 ? `Completed in ${run.durationMin} min` : run.remainingKm ? `${fmtKm(run.remainingKm)} · ${run.etaMin} min away` : 'Preparing'));
    const who = el('md-text-button', { className: 'row-button' }, `${f.kind === 'scooter' ? 'Courier' : f.kind === 'ambulance' ? 'Ambulance' : 'Van'}: ${f.name} (${f.id})`);
    who.addEventListener('click', () => select({ type: 'vehicle', id: f.id }));
    const status = el('span', { className: 'pill' });
    trackerBinds.text(status, () => FLEET_STATUS[f.status]);
    trackerBinds.run(() => {
      const cls = `pill ${FLEET_PILL[f.status]}`.trim();
      if (status.className !== cls) status.className = cls;
    });
    courier = el('div', { className: 'courier' }, el('span', { className: 'courier__avatar' }, icon(KIND_ICON[f.kind])), el('div', { className: 'courier__text' }, who, sub), status);
  } else {
    const waitingText = run.type === 'prescription' ? 'Waiting for a free bike' : run.status < 2 ? `Being packed at ${sim.centres.get(run.from).name}` : run.waiting === 'kerb' ? 'Finding a kerbside stop' : 'Waiting for a free courier';
    courier = el('div', { className: 'courier' }, el('span', { className: 'courier__avatar' }, icon('schedule')), el('div', { className: 'courier__text' }, el('span', { className: 'md-typescale-body-medium' }, waitingText), el('span', { className: 'courier__sub md-typescale-body-small' }, `${sim.centres.get(run.from).name} pharmacy`)));
  }
  panel.dataset.key = trackerKey(run);
  setChildren(panel, head, steps, courier);
  trackerBinds.refresh();
}

/** The tracker is rebuilt when its run, vehicle or waiting state changes, and refreshed in place otherwise. */
function trackerKey(run) {
  return run ? `${run.id}:${run.vehicleId || ''}:${run.status < 2 ? 'prep' : run.waiting || ''}` : '';
}

// ---- Tables -------------------------------------------------------------------------------------
const TABLES = {
  centres: {
    caption: 'Health facilities',
    columns: ['Facility', 'Area', 'Waiting', 'Seen today', 'Staff on duty', 'Beds free', 'Stock alerts', 'Load'],
    rows: () => [...centreList, ...hwcList],
    key: (c) => c.id || c.building.id,
    ref: (c) => (c.building ? { type: 'building', id: c.building.id } : { type: 'centre', id: c.id }),
    label: (c) => c.name || c.building.name,
    cells: (c) => {
      if (c.building) {
        const low = Object.values(c.stock).filter((l) => l < 0.25).length;
        const present = c.staff.filter((s) => s.status === 'present').length;
        return [zoneName(c.building.zone), 'n/a', String(c.seenToday), { pill: `${present} of ${c.staff.length} present`, kind: present ? 'success' : 'warning' }, 'n/a', { pill: low ? `${low} low` : 'OK', kind: low ? 'warning' : 'success' }, { bar: null }];
      }
      const low = Object.values(c.stock).filter((l) => l < 0.25).length;
      const warehouse = c.kind === 'warehouse';
      return [
        zoneName(c.zone),
        warehouse ? 'n/a' : String(c.waiting),
        warehouse ? 'n/a' : String(c.seenToday),
        warehouse ? 'n/a' : `${onDuty(c)} of ${c.doctors.length} doctors`,
        c.beds ? `${c.beds.total - c.beds.occupied} of ${c.beds.total}` : 'n/a',
        { pill: warehouse ? 'n/a' : low ? `${low} low` : 'OK', kind: warehouse ? '' : low ? 'warning' : 'success' },
        { bar: warehouse ? null : Math.min(1, c.waiting / 36), kind: c.waiting > 30 ? 'error' : c.waiting > 20 ? 'warning' : '' }
      ];
    }
  },
  cases: {
    caption: 'Home-visit cases: real cases from the ASHA app and simulated ones',
    columns: ['Case', 'Level', 'Source', 'Village', 'Home', 'Patient', 'Flagged by', 'Flagged', 'Next step'],
    rows: () => [
      ...[...sim.cases.values()].sort((a, b) => Number(Boolean(b.external)) - Number(Boolean(a.external)) || (b.level === 'URGENT') - (a.level === 'URGENT') || b.openedT - a.openedT),
      ...sim.closedCases.slice(0, 12)
    ],
    key: (c) => c.id,
    ref: (c) => ({ type: 'building', id: c.buildingId }),
    label: (c) => caseLabel(c),
    cells: (c) => {
      const open = sim.cases.get(c.buildingId) === c;
      const run = c.runId ? runOf(c.runId) : null;
      const next = !open
        ? c.status
        : c.external
          ? QUEUE_CASE_STATUS[c.caseStatus] || 'In the doctor queue'
          : c.level === 'URGENT'
            ? run
              ? `${run.id}, ${run.steps[run.status].label.toLowerCase()}`
              : 'Waiting for ambulance'
            : `Review in ${Math.max(1, Math.round((c.reviewAt - sim.time) * SIM_MINUTES_PER_SECOND))} min`;
      return [
        { pill: open ? CASE_LEVELS[c.level].short : 'Closed', kind: open ? CASE_PILL[c.level] : 'success' },
        { pill: c.external ? 'ASHA app' : 'Simulated', kind: c.external ? 'real' : '' },
        zoneName(c.zone),
        sim.buildings.get(c.buildingId).name,
        c.external ? (c.patient?.name ? `${c.patient.name}, ${patientMeta(c.patient)}` : patientMeta(c.patient)) : `Infant, ${c.ageDays} days`,
        c.asha.name,
        fmtTime(c.flaggedAt),
        next
      ];
    }
  },
  runs: {
    caption: 'Medicine runs, restocks and referrals',
    columns: ['Run', 'Type', 'Items', 'Value', 'From', 'To', 'Vehicle', 'ETA', 'Status'],
    rows: () => [...[...sim.runs.values()].sort((a, b) => (b.type === 'referral') - (a.type === 'referral') || b.createdT - a.createdT), ...sim.history.slice(0, 20)],
    key: (r) => r.id,
    ref: (r) => ({ type: 'run', id: r.id }),
    label: (r) => r.id,
    cells: (r) => [
      r.typeLabel,
      r.type === 'referral' ? r.patient.label : `${r.items[0]?.name}${r.items.length > 1 ? ` +${r.items.length - 1}` : ''}`,
      r.type === 'referral' || r.type === 'prescription' ? 'n/a' : rupees.format(r.value),
      sim.centres.get(r.from).name,
      r.to.name,
      r.vehicleId || 'Waiting',
      r.status >= 5 ? `${r.durationMin} min` : r.etaMin ? `${r.etaMin} min` : 'n/a',
      { pill: r.steps[r.status].label, kind: r.type === 'referral' && r.status < 5 ? 'urgent' : r.status >= 5 ? 'success' : r.status >= 3 ? 'info' : 'warning' }
    ]
  },
  fleet: {
    caption: 'Couriers, ambulances and vans',
    columns: ['Vehicle', 'Name', 'Type', 'Base', 'Status', 'Run', 'Distance today', 'Battery'],
    rows: () => [...sim.fleet.values()],
    key: (f) => f.id,
    ref: (f) => ({ type: 'vehicle', id: f.id }),
    label: (f) => f.id,
    cells: (f) => [
      f.name,
      KIND_LABEL[f.kind],
      sim.centres.get(f.base).name,
      { pill: FLEET_STATUS[f.status], kind: FLEET_PILL[f.status] },
      f.runId || 'None',
      fmtKm(f.kmToday),
      f.battery === null ? 'n/a' : `${Math.round(f.battery)}%`
    ]
  }
};

const tableState = { tab: null, body: null, rows: new Map() };

function buildTable(wrap, def, { compact = false } = {}) {
  const table = el('table', { className: 'data' });
  table.append(el('caption', { className: 'visually-hidden' }, def.caption));
  table.append(el('thead', {}, el('tr', {}, def.columns.map((c, i) => el('th', { scope: 'col', className: i > 0 && /Waiting|Seen|Value|ETA|Distance|Battery/.test(c) ? 'num' : '' }, c)))));
  const tbody = el('tbody');
  table.append(tbody);
  setChildren(wrap, table);
  return { tbody, rows: new Map(), def, compact };
}

function makeCell(value, header) {
  const td = el('td', { className: /Waiting|Seen|Value|ETA|Distance|Battery/.test(header) ? 'num' : '' });
  const update = (v) => {
    if (v && typeof v === 'object' && 'pill' in v) {
      let p = td.firstElementChild;
      if (!p || !p.classList.contains('pill')) {
        p = el('span', { className: 'pill' });
        setChildren(td, p);
      }
      if (p.textContent !== v.pill) p.textContent = v.pill;
      const cls = `pill ${v.kind}`.trim();
      if (p.className !== cls) p.className = cls;
    } else if (v && typeof v === 'object' && 'bar' in v) {
      if (v.bar === null) {
        if (td.textContent !== 'n/a') td.textContent = 'n/a';
        return;
      }
      let wrap = td.firstElementChild;
      if (!wrap || !wrap.classList.contains('bar')) {
        wrap = el('span', { className: 'bar' }, el('md-linear-progress', { ariaLabel: 'Load' }), el('span', { className: 'md-typescale-label-small' }));
        setChildren(td, wrap);
      }
      wrap.firstElementChild.value = v.bar;
      const pct = `${Math.round(v.bar * 100)}%`;
      if (wrap.lastElementChild.textContent !== pct) wrap.lastElementChild.textContent = pct;
      const cls = `bar ${v.kind}`.trim();
      if (wrap.className !== cls) wrap.className = cls;
    } else if (td.textContent !== v) {
      td.textContent = v;
    }
  };
  update(value);
  return { td, update };
}

function syncTable(t) {
  const items = t.def.rows();
  const seen = new Set();
  let previous = null;
  for (const item of items) {
    const key = t.def.key(item);
    seen.add(key);
    let row = t.rows.get(key);
    const cells = t.def.cells(item);
    if (!row) {
      const button = el('md-text-button', { className: 'row-button' }, t.def.label(item));
      button.addEventListener('click', () => select(t.def.ref(item)));
      const tr = el('tr', { dataset: { key } }, el('th', { scope: 'row' }, button));
      const cellObjs = cells.map((v, i) => makeCell(v, t.def.columns[i + 1]));
      for (const c of cellObjs) tr.append(c.td);
      row = { tr, cells: cellObjs, ref: t.def.ref(item) };
      t.rows.set(key, row);
    } else {
      cells.forEach((v, i) => row.cells[i].update(v));
    }
    const expected = previous ? previous.nextSibling : t.tbody.firstChild;
    if (expected !== row.tr) t.tbody.insertBefore(row.tr, expected);
    previous = row.tr;
  }
  for (const [key, row] of t.rows) {
    if (!seen.has(key)) {
      row.tr.remove();
      t.rows.delete(key);
    }
  }
}

let mainTable = null;
let activeTable = null;

function renderTables(force = false) {
  if (force || !mainTable || mainTable.def !== TABLES[state.tab]) mainTable = buildTable($('#table-wrap'), TABLES[state.tab]);
  syncTable(mainTable);
  if (!activeTable) {
    activeTable = buildTable($('#active-wrap'), {
      caption: 'Active runs',
      columns: ['Run', 'To', 'ETA', 'Status'],
      rows: () => [...sim.runs.values()].sort((a, b) => (b.type === 'referral') - (a.type === 'referral') || (a.etaMin ?? 99) - (b.etaMin ?? 99)),
      key: (r) => r.id,
      ref: (r) => ({ type: 'run', id: r.id }),
      label: (r) => r.id,
      cells: (r) => [r.to.name, r.etaMin ? `${r.etaMin} min` : 'n/a', { pill: r.steps[r.status].label, kind: r.type === 'referral' ? 'urgent' : r.status >= 3 ? 'info' : 'warning' }]
    });
  }
  syncTable(activeTable);
  $('#active-title').textContent = `Active runs (${sim.runs.size})`;
  syncSelectedRows();
}

function syncSelectedRows() {
  for (const t of [mainTable, activeTable]) {
    if (!t) continue;
    for (const row of t.rows.values()) {
      const on = Boolean(state.selected && row.ref.type === state.selected.type && row.ref.id === state.selected.id);
      if ((row.tr.getAttribute('aria-selected') === 'true') !== on) row.tr.setAttribute('aria-selected', String(on));
    }
  }
}

// ---- KPIs ---------------------------------------------------------------------------------------
function sparkline(svg, values) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * 84, 30 - ((v - min) / Math.max(1, max - min)) * 26]);
  const ns = 'http://www.w3.org/2000/svg';
  let line = svg.querySelector('polyline');
  let area = svg.querySelector('polygon');
  if (!line) {
    area = document.createElementNS(ns, 'polygon');
    line = document.createElementNS(ns, 'polyline');
    svg.append(area, line);
  }
  const p = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  line.setAttribute('points', p);
  area.setAttribute('points', `0,32 ${p} 84,32`);
}

function setDelta(node, delta, { lowerIsBetter = false, suffix }) {
  const pct = Math.round(delta * 100);
  const better = lowerIsBetter ? pct <= 0 : pct >= 0;
  node.classList.toggle('worse', !better);
  setChildren(node, icon(pct >= 0 ? 'trending_up' : 'trending_down'), `${pct >= 0 ? '+' : ''}${pct}% ${suffix}`);
}

function renderKpis() {
  const k = sim.kpis();
  const p = $('#kpi-patients');
  p.querySelector('[data-value]').textContent = String(k.patients.value);
  setDelta(p.querySelector('[data-delta]'), k.patients.delta, { suffix: 'vs last hour' });
  sparkline(p.querySelector('[data-spark]'), k.patients.spark);
  const d = $('#kpi-delivery');
  d.querySelector('[data-value]').textContent = `${k.delivery.value} min`;
  setDelta(d.querySelector('[data-delta]'), k.delivery.delta, { lowerIsBetter: true, suffix: 'vs usual' });
  sparkline(d.querySelector('[data-spark]'), k.delivery.spark);
  const doc = $('#kpi-doctors');
  doc.querySelector('[data-value]').textContent = `${k.doctors.onDuty} / ${k.doctors.total}`;
  doc.querySelector('[data-delta]').textContent = `${k.doctors.inOpd} in OPD now`;
  doc.querySelector('[data-ring]').value = k.doctors.onDuty / Math.max(1, k.doctors.total);
  const cs = $('#kpi-cases');
  const open = k.cases.urgent + k.cases.priority;
  cs.querySelector('[data-value]').textContent = String(open);
  cs.querySelector('[data-delta]').textContent = `${k.cases.urgent} urgent · ${k.cases.priority} review today${k.cases.real ? ` · ${k.cases.real} from ASHA app` : ''}`;
  cs.classList.toggle('has-urgent', k.cases.urgent > 0);
  const bar = cs.querySelector('[data-sevbar]');
  bar.children[0].style.flexGrow = String(k.cases.urgent);
  bar.children[1].style.flexGrow = String(k.cases.priority);
  bar.setAttribute('aria-label', `${k.cases.urgent} urgent and ${k.cases.priority} review today`);
}

// Map legend and the cases bar: swatches use the same world colours as the 3D map.
for (const node of document.querySelectorAll('[data-swatch]')) {
  const c = node.dataset.swatch;
  node.style.backgroundColor = SEVERITY_COLORS[c] || (c === 'facility' ? PALETTE.white : PALETTE.houseWall);
  if (c === 'facility') node.style.borderColor = PALETTE.facilityRed;
}
$('#kpi-cases .sevbar__urgent').style.backgroundColor = SEVERITY_COLORS.URGENT;
$('#kpi-cases .sevbar__priority').style.backgroundColor = SEVERITY_COLORS.PRIORITY;

// ---- Labels on the map --------------------------------------------------------------------------
const labels = [];
const labelLayer = $('#labels');

function addLabel({ key, anchor, build, visible = () => true, small = false, onClick }) {
  const node = el('button', { type: 'button', className: `map-label${small ? ' map-label--small' : ''}` });
  build(node);
  if (onClick) node.addEventListener('click', onClick);
  labelLayer.append(node);
  const label = { key, node, anchor, visible, shown: false, x: null, y: null };
  labels.push(label);
  return label;
}

function removeLabel(key) {
  const i = labels.findIndex((l) => l.key === key);
  if (i >= 0) {
    labels[i].node.remove();
    labels.splice(i, 1);
  }
}

const labelBinds = binder();
function centreLabelStatus(c) {
  if (c.kind === 'warehouse') return '';
  return c.waiting > 30 ? 'error' : c.waiting > 20 ? 'warning' : '';
}

for (const c of centreList) {
  addLabel({
    key: `centre:${c.id}`,
    anchor: () => ({ x: c.main.x, y: c.labelY, z: c.main.z }),
    onClick: () => select({ type: 'centre', id: c.id }),
    build(node) {
      const dot = el('span', { className: 'dot' });
      const sub = el('span', { className: 'label__sub' });
      labelBinds.text(sub, () => (c.kind === 'warehouse' ? `${[...sim.runs.values()].filter((r) => r.from === c.id).length} restocks in progress` : `${c.waiting} waiting · ${onDuty(c)}/${c.doctors.length} doctors · ${c.beds.total - c.beds.occupied} beds free`));
      labelBinds.run(() => {
        const cls = `dot ${centreLabelStatus(c)}`.trim();
        if (dot.className !== cls) dot.className = cls;
      });
      node.append(dot, el('span', { className: 'label__text' }, el('span', {}, c.name), sub));
      node.setAttribute('aria-label', `${c.name}, show details`);
    }
  });
}
for (const v of villageList) {
  addLabel({
    key: `village:${v.id}`,
    // On the far edge of the village as seen from the camera, so the label never hides its homes.
    anchor: () => {
      const az = view ? view.controls.azimuth : 0;
      return { x: v.x - Math.sin(az) * 8.4, y: 2.4, z: v.z - Math.cos(az) * 8.4 };
    },
    visible: () => !view || view.controls.distance < 150,
    onClick: () => select({ type: realOpen().some((c) => c.zone === v.id) ? 'location' : 'village', id: v.id }),
    build(node) {
      node.classList.add('map-label--village');
      const dot = el('span', { className: 'dot' });
      const sub = el('span', { className: 'label__sub' });
      labelBinds.text(sub, () => villageSummary(v));
      labelBinds.run(() => {
        const sev = villageSeverity(v);
        const cls = `dot ${sev === 'urgent' ? 'error' : sev === 'warning' ? 'warning' : 'ok'}`;
        if (dot.className !== cls) dot.className = cls;
        node.classList.toggle('map-label--urgent', sev === 'urgent');
      });
      node.append(dot, el('span', { className: 'label__text' }, el('span', {}, v.name), sub));
      node.setAttribute('aria-label', `${v.name}, show village details`);
    }
  });
}
for (const h of hwcList) {
  const b = h.building;
  addLabel({
    key: `building:${b.id}`,
    small: true,
    anchor: () => ({ x: b.x, y: b.h + 2.2, z: b.z }),
    visible: () => !view || view.controls.distance < 70 || (state.selected?.type === 'building' && state.selected.id === b.id),
    onClick: () => select({ type: 'building', id: b.id }),
    build(node) {
      const text = el('span');
      labelBinds.text(text, () => `${b.name} · CHO ${STAFF_STATUS[h.staff[0].status].toLowerCase()}`);
      node.append(icon('local_hospital'), text);
      node.setAttribute('aria-label', `${b.name}, show details`);
    }
  });
}
for (const l of layout.landmarks) {
  addLabel({
    key: `landmark:${l.id}`,
    small: true,
    anchor: () => ({ x: l.x, y: l.labelY, z: l.z }),
    visible: () => !view || view.controls.distance < 95 || (state.selected?.type === 'landmark' && state.selected.id === l.id),
    onClick: () => select({ type: 'landmark', id: l.id }),
    build(node) {
      node.append(icon(LANDMARK_ICON[l.kind] || 'location_on'), el('span', {}, l.name));
      node.setAttribute('aria-label', `${l.name}, show details`);
    }
  });
}

const pinLabels = new Map();
function addRunLabel(run) {
  const urgent = run.type === 'referral';
  const label = addLabel({
    key: `run:${run.id}`,
    small: true,
    anchor: () => {
      const pin = view?.actors.pins.get(run.id);
      return pin ? { x: pin.x, y: pin.mesh.position.y + 2.2, z: pin.z } : null;
    },
    visible: () => sim.time - run.createdT < 9 || state.trackedRunId === run.id || urgent,
    onClick: () => select({ type: 'run', id: run.id }),
    build(node) {
      if (urgent) node.classList.add('map-label--urgent');
      node.append(icon(RUN_ICON[run.type] || 'medication'), el('span', {}, urgent ? `Urgent · ${run.id}` : run.type === 'prescription' ? `${run.id} · medicines for ${run.patientName || 'the patient'}` : `${run.id} · ${run.items[0]?.name}${run.items.length > 1 ? ` +${run.items.length - 1}` : ''}`));
      node.setAttribute('aria-label', `${run.typeLabel} ${run.id}, show details`);
    }
  });
  pinLabels.set(run.id, label);
}

const fleetLabels = new Map();
for (const f of sim.fleet.values()) {
  fleetLabels.set(
    f.id,
    addLabel({
      key: `vehicle:${f.id}`,
      small: true,
      anchor: () => ({ x: f.vehicle.x, y: f.kind === 'scooter' ? 2.0 : 2.6, z: f.vehicle.z }),
      visible: () => {
        const sel = state.selected?.type === 'vehicle' && state.selected.id === f.id;
        if (sel) return true;
        if (f.status === 'idle' || !view) return false;
        if (f.kind === 'ambulance' && f.vehicle.emergency) return true;
        return view.controls.distance < 75;
      },
      onClick: () => select({ type: 'vehicle', id: f.id }),
      build(node) {
        const text = el('span');
        labelBinds.text(text, () => {
          const run = f.runId ? runOf(f.runId) : null;
          const eta = run && run.status < 5 && run.etaMin ? ` · ${run.etaMin} min` : '';
          return `${f.id}${eta || ` · ${FLEET_STATUS[f.status]}`}`;
        });
        labelBinds.run(() => {
          node.classList.toggle('map-label--urgent', f.kind === 'ambulance' && f.vehicle.emergency);
          node.classList.toggle('map-label--selected', state.selected?.type === 'vehicle' && state.selected.id === f.id);
        });
        node.append(icon(KIND_ICON[f.kind]), text);
        node.setAttribute('aria-label', `${f.id}, ${f.name}, show details`);
      }
    })
  );
}

function renderLabelsSelection() {
  labelBinds.refresh();
  for (const l of labels) {
    const [type, id] = l.key.split(':');
    l.node.classList.toggle('map-label--selected', Boolean(state.selected && state.selected.type === type && state.selected.id === id && type !== 'run'));
  }
}

function positionLabels() {
  if (!view) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  for (const l of labels) {
    const a = l.visible() ? l.anchor() : null;
    const p = a ? view.project(a.x, a.y, a.z) : null;
    const show = Boolean(p && p.x > -40 && p.x < w + 40 && p.y > -20 && p.y < h + 20);
    if (!show) {
      if (l.shown) {
        l.node.style.transform = 'translate3d(-9999px, -9999px, 0)';
        l.node.tabIndex = -1;
        l.shown = false;
      }
      continue;
    }
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (!l.shown || x !== l.x || y !== l.y) {
      l.node.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, calc(-100% - 6px))`;
      l.x = x;
      l.y = y;
    }
    if (!l.shown) {
      l.node.tabIndex = 0;
      l.shown = true;
    }
  }
}

// ---- Sim events ---------------------------------------------------------------------------------
let warming = false;
sim.on('run:new', (run) => {
  if (view) {
    const pin = view.actors.addPin(run, { x: run.to.x, z: run.to.z, y: (run.to.top || 2) + 0.4 });
    if (warming) pin.t = 1;
  }
  addRunLabel(run);
  if (run.type === 'referral' && !warming) announce(`Urgent referral ${run.id} flagged near ${run.to.name}`);
});
sim.on('run:step', ({ run, index }) => {
  if (view) {
    if (index === 1 && !warming) {
      const c = sim.centres.get(run.from);
      view.actors.ping(c.gate.x, c.gate.z, run.type === 'referral' ? accents.error : accents.primary);
    }
    if ((run.type === 'medicine' && index === 3) || (run.type === 'restock' && index === 3) || (run.type === 'referral' && index === 2) || (run.type === 'prescription' && index >= 2 && index < 5)) {
      view.actors.trailFor(run.vehicleId, run.type === 'referral' ? accents.error : accents.primary);
    }
  }
  if (run.id === state.trackedRunId) trackerBinds.refresh();
});
sim.on('prescription:collect', ({ run, stop }) => {
  view?.actors.removeBeacon(`rxstop:${run.id}:${stop.id}`);
  removeLabel(`rxstop:${run.id}:${stop.id}`);
  const src = srcOf(stop.id);
  if (view && src && !stop.atBase) view.actors.ping(src.x, src.z, accents.success);
  if (!stop.atBase) announce(`${run.id}: collected from ${stop.name}`);
  if (run.id === state.trackedRunId) trackerBinds.refresh();
  if (state.selected?.type === 'run' && state.selected.id === run.id) renderDetail();
});
sim.on('prescription:done', async (run) => {
  clearRxStops(run);
  const f = run.vehicleId ? sim.fleet.get(run.vehicleId) : null;
  const who = run.patientName || 'the patient';
  showNotice({ iconName: 'check_circle', title: 'Medicines delivered', sub: `${f ? f.name : 'The bike'} (${run.id}) reached ${who} at ${run.to.name}.`, actionText: run.caseId ? 'View case' : 'View run', action: () => select(run.caseId && realCase(run.caseId) ? { type: 'case', id: run.caseId } : { type: 'run', id: run.id }) });
  announce(`Medicines delivered to ${who}`);
  if (!run.caseId || !queueClient?.signedIn) return;
  const updated = await queueClient.delivered(run.caseId).catch(() => null);
  if (updated) {
    const e = realCases.get(run.caseId) || {};
    e.record = updated;
    realCases.set(run.caseId, e);
    redrawRealCase(run.caseId);
  }
});
sim.on('pickup', (run) => view?.actors.removePin(run.id));
sim.on('run:done', (run) => {
  view?.actors.removePin(run.id);
  if (run.vehicleId) view?.actors.removeTrail(run.vehicleId);
  removeLabel(`run:${run.id}`);
  pinLabels.delete(run.id);
  if (state.selected?.type === 'run' && state.selected.id === run.id) view?.actors.setRoute(null);
});
sim.on('burst', ({ run, x, y, z }) => {
  if (!warming) view?.actors.burst(x, (y || 1) + 0.6, z, run.type === 'referral' ? accents.primary : accents.success);
});
sim.on('alert', (alert) => {
  updateAlertsBadge();
  if (alert.level === 'error' && !warming) announce(alert.text);
});
sim.on('season', (season) => {
  $('#weather-text').textContent = `${season.tempC} °C · ${season.condition}`;
  setIcon($('#season-icon'), season.icon);
});
// Homes take the colour of their open case: red for urgent (refer now), yellow for review today.
// Every place with open cases from the ASHA app gets a red location pin ("needs attention"), which pulses
// while a case there has not been opened yet; opened cases are remembered for this browser tab.
const SEEN_KEY = 'av_live_seen_cases';
const seen = new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]'));
const pinned = new Set(); // village ids with a pin and pin label

function markSeen(c) {
  if (!c) return;
  if (!seen.has(c.id)) {
    seen.add(c.id);
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  }
  if (toastCase?.id === c.id) hideToast();
  syncAttention();
}

/** Pins on the map, their labels, and the Needs attention panel. */
function syncAttention() {
  const groups = attentionGroups();
  const live = new Set(groups.map(([id]) => id));
  for (const id of [...pinned]) {
    if (live.has(id)) continue;
    view?.actors.removeBeacon(`loc:${id}`);
    removeLabel(`attn:${id}`);
    pinned.delete(id);
  }
  for (const [id, cases] of groups) {
    const v = sim.villages.get(id);
    const fresh = cases.filter((c) => !seen.has(c.id)).length;
    view?.actors.addBeacon(`loc:${id}`, { x: v.x, z: v.z, top: 1.4, hex: accents.error, ref: { type: 'location', id }, pulse: fresh > 0 });
    removeLabel(`attn:${id}`);
    addLabel({
      key: `attn:${id}`,
      anchor: () => ({ x: v.x, y: 7.6, z: v.z }),
      onClick: () => select({ type: 'location', id }),
      build(node) {
        node.classList.add('map-label--urgent', 'map-label--attention');
        if (fresh) node.classList.add('map-label--new');
        node.append(icon('location_on'), el('span', { className: 'label__text' }, el('span', {}, v.name), el('span', { className: 'label__sub' }, `${cases.length} need${cases.length === 1 ? 's' : ''} attention${fresh ? ` · ${fresh} new` : ''}`)));
        node.setAttribute('aria-label', `${v.name}: ${cases.length} case${cases.length === 1 ? '' : 's'} need attention${fresh ? `, ${fresh} new` : ''}. Open`);
      }
    });
    pinned.add(id);
  }
  renderAttention(groups);
}

function renderAttention(groups = attentionGroups()) {
  const list = $('#attention-list');
  const total = groups.reduce((s, [, cases]) => s + cases.length, 0);
  $('#attention-count').hidden = !total;
  $('#attention-count').textContent = String(total);
  $('#attention').classList.toggle('has-cases', total > 0);
  if (!groups.length) {
    setChildren(
      list,
      el(
        'p',
        { className: 'attention__empty md-typescale-body-small' },
        queue.status === 'demo' || queue.status === 'expired' ? 'Sign in as a doctor to see places where rural health workers need help.' : 'No place needs attention right now. New cases from the ASHA app appear here and as red pins on the map.'
      )
    );
    return;
  }
  setChildren(
    list,
    ...groups.map(([id, cases]) => {
      const v = sim.villages.get(id);
      const fresh = cases.filter((c) => !seen.has(c.id)).length;
      const top = cases[0];
      const item = el(
        'button',
        { type: 'button', className: `attn attn--${top.level.toLowerCase()}`, dataset: { village: id } },
        el('span', { className: 'attn__pin' }, icon('location_on')),
        el(
          'span',
          { className: 'attn__text' },
          el('span', { className: 'md-typescale-title-small' }, v.name, fresh ? el('span', { className: 'pill urgent attn__new' }, `${fresh} new`) : null),
          el('span', { className: 'md-typescale-body-small' }, cases.map((c) => c.patient?.name || 'Patient').join(', ')),
          el('span', { className: 'muted md-typescale-label-small' }, `${cases.length} case${cases.length === 1 ? '' : 's'} · latest ${agoText(cases.reduce((m, c) => (c.flaggedAt > m ? c.flaggedAt : m), cases[0].flaggedAt))}`)
        ),
        pill(CASE_LEVELS[top.level].short, CASE_PILL[top.level])
      );
      item.addEventListener('click', () => select({ type: 'location', id }));
      return item;
    })
  );
}

/** Keep an open location panel in step with the queue (case panels update themselves). */
function refreshOpenPanel() {
  if (state.selected?.type === 'location') renderDetail();
}

sim.on('case:open', (c) => {
  view?.world.setSeverity(c.buildingId, c.level);
  labelBinds.refresh();
});
sim.on('case:close', (c) => {
  view?.world.setSeverity(c.buildingId, null);
  if (c.external && toastCase?.id === c.id) hideToast();
  labelBinds.refresh();
});
// Cases already open before these listeners were attached.
for (const c of sim.cases.values()) view?.world.setSeverity(c.buildingId, c.level);

// New-case toast: the most urgent unseen case from the ASHA app.
let toastCase = null;
let toastAction = null;
function showToast(c) {
  toastCase = c;
  toastAction = () => select({ type: 'location', id: c.zone });
  const village = sim.villages.get(c.zone)?.name || zoneName(c.zone);
  setIcon($('#new-case-toast .toast__icon md-icon'), 'person');
  $('#toast-view').textContent = 'View case';
  $('#toast-title').textContent = `${village} needs attention`;
  $('#toast-sub').textContent = `${CASE_LEVELS[c.level].short} case from ${firstName(c.asha.name)}: ${c.patient?.name ? `${c.patient.name}, ` : ''}${patientMeta(c.patient)}`;
  const t = $('#new-case-toast');
  t.classList.toggle('urgent', c.level === 'URGENT');
  t.hidden = false;
}
/** A non-case notice (for example, medicines delivered) in the same toast. */
function showNotice({ iconName, title, sub, actionText, action }) {
  toastCase = null;
  toastAction = action;
  setIcon($('#new-case-toast .toast__icon md-icon'), iconName);
  $('#toast-view').textContent = actionText;
  $('#toast-title').textContent = title;
  $('#toast-sub').textContent = sub;
  const t = $('#new-case-toast');
  t.classList.remove('urgent');
  t.hidden = false;
}
function hideToast() {
  toastCase = null;
  toastAction = null;
  $('#new-case-toast').hidden = true;
}
$('#toast-view').addEventListener('click', () => {
  const action = toastAction;
  hideToast();
  action?.();
});
$('#toast-close').addEventListener('click', hideToast);

// ---- Real doctor queue ------------------------------------------------------------------------------
function renderQueueChip() {
  const chip = $('#queue-chip');
  const [iconName, text] = QUEUE_STATUS[queue.status];
  const n = [...sim.cases.values()].filter((c) => c.external).length;
  chip.className = `queue-chip ${queue.status} md-typescale-label-medium`;
  setIcon(chip.querySelector('md-icon'), iconName);
  $('#queue-text').textContent = queue.status === 'live' ? `${text} · ${n} open` : text;
  const title =
    queue.status === 'demo'
      ? 'Simulated block only. Sign in as a doctor to show real cases from the ASHA app'
      : queue.status === 'expired'
        ? 'Your doctor session expired. Sign in again.'
        : `Real cases from the ASHA app: ${n} open. Show the places that need attention.`;
  chip.title = title;
  chip.setAttribute('aria-label', `${$('#queue-text').textContent}. ${title}`);
}

let queueLoaded = false;
queueClient = connectDoctorQueue({
  onCases(list) {
    const before = new Set([...sim.cases.values()].filter((c) => c.external).map((c) => c.id));
    sim.syncExternalCases(list);
    const added = list.filter((c) => !before.has(c.id));
    if (added.length && queueLoaded) announce(`${added.length} new case${added.length === 1 ? '' : 's'} from the ASHA app`);
    // Toast the most urgent case not yet opened here (new arrivals, or unseen ones on first load).
    const unseen = [...sim.cases.values()].filter((c) => c.external && !seen.has(c.id) && (!queueLoaded || added.some((a) => a.id === c.id)));
    unseen.sort((a, b) => ['URGENT', 'PRIORITY', 'ROUTINE'].indexOf(a.level) - ['URGENT', 'PRIORITY', 'ROUTINE'].indexOf(b.level));
    if (unseen[0] && !(toastCase && ['URGENT', 'PRIORITY', 'ROUTINE'].indexOf(toastCase.level) < ['URGENT', 'PRIORITY', 'ROUTINE'].indexOf(unseen[0].level))) showToast(unseen[0]);
    // Bring a newly arrived case's place into view if the doctor is not looking at something else.
    const arrived = queueLoaded && unseen[0];
    if (arrived && !state.selected && view) {
      const v = sim.villages.get(arrived.zone);
      view.controls.flyTo({ x: v.x, z: v.z, distance: Math.min(view.controls.distance, 70) });
    }
    const firstLoad = !queueLoaded;
    queueLoaded = true;
    if (firstLoad) {
      queueClient.pendingDispatches().then((list) => list.forEach((s) => resumeDispatch(s.id))).catch(() => {});
    }
    syncAttention();
    refreshOpenPanel();
    // Deep link: /live#case=<id> opens that case.
    const hash = /^#case=([^&]+)$/.exec(location.hash);
    if (firstLoad && hash && realCase(decodeURIComponent(hash[1]))) {
      history.replaceState(null, '', location.pathname + location.search);
      select({ type: 'case', id: decodeURIComponent(hash[1]) });
    }
    renderQueueChip();
    renderTables();
    renderKpis();
    detailBinds.refresh();
    labelBinds.refresh();
    updateAlertsBadge();
  },
  onStats(stats) {
    queue.stats = stats;
    detailBinds.refresh();
  },
  onAshas(ashas) {
    const changed = JSON.stringify(ashas) !== JSON.stringify(queue.ashas);
    queue.ashas = ashas;
    if (changed && (!state.selected || state.selected.type === 'worker')) renderDetail();
  },
  onEvent(type, data) {
    // Medicines sent from another screen (or before a reload): put the bike on this map too.
    if (type === 'case.dispatch' && data.caseId) {
      if (data.status === 'on_the_way') resumeDispatch(data.caseId);
      else if (realCases.has(data.caseId)) loadRealCase(data.caseId, { force: true }).then(() => redrawRealCase(data.caseId));
      return;
    }
    // The AI summary arrived for a case: refresh its full record if we hold it.
    if (data.caseId && realCases.has(data.caseId) && type !== 'case.created') {
      loadRealCase(data.caseId, { force: true }).then(() => {
        redrawRealCase(data.caseId);
        if (state.selected?.type === 'location') renderDetail();
      });
    }
  },
  onProfile(p) {
    const name = p?.doctor?.name || p?.user?.name;
    if (!name) return;
    queue.doctor = p.doctor || null;
    $('#user-headline').textContent = name;
    $('#user-role').textContent = p.doctor ? `${p.doctor.role}, ${p.doctor.facility}` : 'Doctor';
    const initials = name.replace(/^Dr\.?\s*/i, '').split(/[\s.]+/).filter(Boolean).slice(-2).map((w) => w[0].toUpperCase()).join('');
    $('#avatar').textContent = initials || 'DR';
  },
  onStatus(status) {
    queue.status = status;
    renderQueueChip();
    renderAttention();
    detailBinds.refresh();
  }
});

// Doctor sign-in from the 3D view (same access codes as the console).
function openSignIn() {
  $('#signin-error').hidden = true;
  $('#signin-dialog').show();
  requestAnimationFrame(() => $('#signin-code').focus());
}
async function submitSignIn() {
  const code = $('#signin-code').value;
  $('#signin-submit').disabled = true;
  const ok = await queueClient.signIn(code).catch(() => false);
  $('#signin-submit').disabled = false;
  if (!ok) {
    $('#signin-error').textContent = 'That code is not a doctor access code.';
    $('#signin-error').hidden = false;
    return;
  }
  $('#signin-code').value = '';
  $('#signin-dialog').close();
  announce('Signed in. Real cases from the ASHA app now appear on the map.');
}
$('#queue-chip').addEventListener('click', () => {
  if (queue.status === 'demo' || queue.status === 'expired') openSignIn();
  else {
    setCollapsed('attention', false);
    if (window.matchMedia('(max-width: 760px)').matches) setSheet('attention');
    $('#attention-list').querySelector('button')?.focus();
  }
});
$('#signin-submit').addEventListener('click', submitSignIn);
$('#signin-cancel').addEventListener('click', () => $('#signin-dialog').close());
$('#signin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitSignIn();
});
$('#signin-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitSignIn();
  }
});
$('#photo-close').addEventListener('click', () => $('#photo-dialog').close());

// ---- Collapsible panels ---------------------------------------------------------------------------
// Every panel folds to its header; the choice is remembered on this device.
const THEME_KEY = 'av_live_theme';
// v2: first start opens with every panel folded except the Active cases panel.
const COLLAPSE_KEY = 'av_live_collapsed_v2';
const FIRST_START_COLLAPSED = ['kpis', 'legend', 'attention', 'tracker', 'tables', 'active'];
const FOLDS_DOWN = new Set(['tracker', 'tables', 'active']);
const collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || JSON.stringify(FIRST_START_COLLAPSED)));
function setCollapsed(key, on) {
  if (on) collapsed.add(key);
  else collapsed.delete(key);
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  document.body.classList.toggle(`collapsed-${key}`, on);
  if (key === 'detail' && on) $('#detail-content').scrollTop = 0;
  for (const btn of document.querySelectorAll(`[data-collapse="${key}"]`)) {
    btn.setAttribute('aria-expanded', String(!on));
    // Material Web moves aria-label to data-aria-label once the element upgrades.
    const label = btn.getAttribute('aria-label') || btn.getAttribute('data-aria-label');
    if (label) btn.setAttribute('aria-label', label.replace(/^(Collapse|Expand)/, on ? 'Expand' : 'Collapse'));
    const ic = btn.querySelector('md-icon');
    if (ic) setIcon(ic, on === FOLDS_DOWN.has(key) ? 'keyboard_arrow_up' : 'keyboard_arrow_down');
  }
}
for (const btn of document.querySelectorAll('[data-collapse]')) {
  btn.addEventListener('click', () => setCollapsed(btn.dataset.collapse, !collapsed.has(btn.dataset.collapse)));
}
for (const key of new Set([...document.querySelectorAll('[data-collapse]')].map((b) => b.dataset.collapse))) setCollapsed(key, collapsed.has(key));

// ---- Full-screen cases: the right panel over the whole map (Esc or the button returns) ------------
function setCasesFull(on) {
  document.body.classList.toggle('cases-full', on);
  if (on) setCollapsed('detail', false);
  const btn = $('#cases-full');
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Back to the map' : 'Show cases full screen');
  setIcon(btn.querySelector('md-icon'), on ? 'close_fullscreen' : 'open_in_full');
  announce(on ? 'Cases shown full screen' : 'Back to the map');
}
$('#cases-full').addEventListener('click', () => setCasesFull(!document.body.classList.contains('cases-full')));

// ---- Rural worker app as a phone on the same screen (hackathon demo) ------------------------------
$('#phone-toggle').addEventListener('change', (e) => {
  // On a phone there is no room for a phone-in-a-phone: open the ASHA app as a full page, like a native app.
  if (window.matchMedia('(max-width: 760px)').matches) {
    e.target.selected = false;
    location.assign('/asha?from=live');
    return;
  }
  const open = e.target.selected;
  const frame = $('#phone-frame');
  if (open && !frame.getAttribute('src')) frame.setAttribute('src', '/asha');
  $('#phone').hidden = !open;
  document.body.classList.toggle('phone-open', open);
  e.target.setAttribute('aria-label', open ? 'Hide the rural worker app' : 'Show the rural worker app');
  announce(open ? 'Rural worker app shown as a phone' : 'Rural worker app hidden');
});

// ---- Top bar controls ---------------------------------------------------------------------------
function updateClock() {
  const now = new Date();
  $('#clock-date').textContent = dateFmt.format(now);
  $('#clock-time').textContent = timeFmt.format(now);
}

function setNight(on, { animate = true } = {}) {
  state.night = on;
  $('#night-toggle').selected = on;
  document.documentElement.dataset.theme = on ? 'dark' : 'light';
  view?.setEnvironment({ night: on ? 1 : 0 });
  if (!animate && view) Object.assign(view.env, { night: on ? 1 : 0 });
}

function setSeason(id) {
  sim.setSeason(id);
  view?.setEnvironment({ monsoon: id === 'monsoon' ? 1 : 0, festival: id === 'festival' ? 1 : 0 });
  if (id === 'festival' && !state.night) setNight(true);
  document.body.dataset.season = id;
  for (const item of $('#season-menu').querySelectorAll('md-menu-item')) item.selected = item.dataset.season === id;
  announce(`${SEASONS[id].name} view`);
}

function buildMenus() {
  const zoneMenu = $('#zone-menu');
  for (const z of sim.zones.values()) {
    const item = el('md-menu-item', { dataset: { zone: z.id } }, icon(z.id === 'all' ? 'view_in_ar' : 'location_on', { slot: 'start' }), el('div', { slot: 'headline' }, z.name));
    item.addEventListener('click', () => setZone(z.id));
    zoneMenu.append(item);
  }
  $('#zone-button').addEventListener('click', () => (zoneMenu.open = !zoneMenu.open));

  const seasonMenu = $('#season-menu');
  for (const s of Object.values(SEASONS)) {
    const item = el('md-menu-item', { dataset: { season: s.id } }, icon(s.icon, { slot: 'start' }), el('div', { slot: 'headline' }, s.name), el('div', { slot: 'supporting-text' }, `${s.tempC} °C · ${s.condition}`));
    item.addEventListener('click', () => setSeason(s.id));
    seasonMenu.append(item);
  }
  $('#season-button').addEventListener('click', () => (seasonMenu.open = !seasonMenu.open));

  const alertsMenu = $('#alerts-menu');
  $('#alerts-button').addEventListener('click', () => {
    const items = sim.alerts.slice(0, 12).map((a) => {
      const item = el(
        'md-menu-item',
        { dataset: { alert: a.id } },
        icon(a.icon, { slot: 'start', className: `alert-${a.level}` }),
        el('div', { slot: 'headline' }, `${a.level === 'error' ? 'Urgent' : a.level === 'warning' ? 'Attention' : 'Update'} · ${fmtTime(a.at)}`),
        el('div', { slot: 'supporting-text' }, a.text)
      );
      if (a.entity) item.addEventListener('click', () => select(a.entity));
      return item;
    });
    setChildren(alertsMenu, items.length ? items : el('md-menu-item', { disabled: true }, el('div', { slot: 'headline' }, 'No alerts')));
    alertsMenu.open = !alertsMenu.open;
    sim.markAlertsRead();
    updateAlertsBadge();
  });

  $('#user-button').addEventListener('click', () => ($('#user-menu').open = !$('#user-menu').open));
  $('#night-toggle').addEventListener('change', (e) => {
    setNight(e.target.selected);
    localStorage.setItem(THEME_KEY, e.target.selected ? 'dark' : 'light');
  });

  // Search.
  const field = $('#search');
  const menu = $('#search-menu');
  const toggle = $('#search-toggle');
  const setSearchOpen = (open) => {
    document.body.classList.toggle('search-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(() => field.focus());
  };
  toggle.addEventListener('click', () => setSearchOpen(!document.body.classList.contains('search-open')));
  let results = [];
  const choose = (r) => {
    select({ type: r.type, id: r.id });
    field.value = '';
    menu.open = false;
    setSearchOpen(false);
  };
  const runSearch = () => {
    results = sim.search(field.value || '');
    const q = String(field.value || '').trim().toLowerCase();
    if (q) {
      const workers = new Map();
      for (const v of villageList) for (const a of v.asha) workers.set(a.id, { name: a.name, village: v.name });
      for (const a of queue.ashas || []) workers.set(a.id, { name: a.name, village: a.village });
      const all = [...workers].filter(([, w]) => `${w.name} asha ${w.village}`.toLowerCase().includes(q)).map(([id, w]) => ({ type: 'worker', id, label: `${w.name}, ASHA`, sub: w.village, icon: 'badge' }));
      const byName = all.filter((h) => h.label.toLowerCase().includes(q));
      results = [...byName, ...results, ...all.filter((h) => !byName.includes(h))].slice(0, 8);
    }
    setChildren(
      menu,
      results.map((r) => {
        const item = el('md-menu-item', {}, icon(r.icon, { slot: 'start' }), el('div', { slot: 'headline' }, r.label), r.sub ? el('div', { slot: 'supporting-text' }, r.sub) : null);
        item.addEventListener('click', () => choose(r));
        return item;
      })
    );
    menu.open = results.length > 0;
  };
  field.addEventListener('input', runSearch);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && results[0]) {
      choose(results[0]);
    } else if (e.key === 'ArrowDown' && menu.open) {
      e.preventDefault();
      menu.items?.[0]?.focus();
    } else if (e.key === 'Escape') {
      menu.open = false;
      setSearchOpen(false);
    }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setSearchOpen(true);
      field.focus();
    } else if (e.key === 'Escape' && state.selected && !document.querySelector('md-menu[open]')) {
      clearSelection();
    } else if (e.key === 'Escape' && document.body.classList.contains('cases-full') && !document.querySelector('md-menu[open], md-dialog[open]')) {
      setCasesFull(false);
    }
  });

  // Tables.
  const tabs = $('#table-tabs');
  tabs.addEventListener('change', () => {
    state.tab = tabs.activeTab?.dataset.tab || 'centres';
    if (collapsed.has('tables')) setCollapsed('tables', false);
    renderTables(true);
  });
  $('#view-all-runs').addEventListener('click', () => {
    tabs.activeTabIndex = [...tabs.querySelectorAll('md-primary-tab')].findIndex((t) => t.dataset.tab === 'runs');
    state.tab = 'runs';
    setCollapsed('tables', false);
    renderTables(true);
  });

  // Map controls.
  $('#zoom-in').addEventListener('click', () => view?.controls.zoomBy(0.75));
  $('#zoom-out').addEventListener('click', () => view?.controls.zoomBy(1.33));
  $('#rotate-left').addEventListener('click', () => view?.controls.rotateBy(0.6));
  $('#rotate-right').addEventListener('click', () => view?.controls.rotateBy(-0.6));
  $('#recentre').addEventListener('click', () => {
    clearSelection();
    setZone('all');
  });
  $('#pause').addEventListener('change', (e) => {
    state.paused = e.target.selected;
    e.target.setAttribute('aria-label', state.paused ? 'Resume the simulation' : 'Pause the simulation');
    announce(state.paused ? 'Simulation paused' : 'Simulation running');
  });

  // Phone bottom sheet.
  const sheetTabs = $('#sheet-tabs');
  sheetTabs.addEventListener('change', () => setSheet(sheetTabs.activeTab?.dataset.sheet || 'attention', false));
}

function setSheet(name, syncTabs = true) {
  document.body.dataset.sheet = name;
  if (syncTabs) {
    const tabs = $('#sheet-tabs');
    const index = [...tabs.querySelectorAll('md-primary-tab')].findIndex((t) => t.dataset.sheet === name);
    if (index >= 0 && tabs.activeTabIndex !== index) tabs.activeTabIndex = index;
  }
}

function updateAlertsBadge() {
  const badge = $('#alerts-badge');
  const n = sim.unread;
  badge.hidden = n === 0;
  badge.textContent = n > 9 ? '9+' : String(n);
  $('#alerts-button').setAttribute('aria-label', n ? `Alerts, ${n} new` : 'Alerts');
}

// ---- Start ----------------------------------------------------------------------------------------
buildMenus();
const startSeason = SEASONS[params.get('season')] ? params.get('season') : 'summer';
const hour = new Date().getHours();
// Light on first open; night only when asked for in the URL or chosen before on this device.
const startNight = params.has('night') ? params.get('night') !== '0' : localStorage.getItem(THEME_KEY) === 'dark';
setNight(startNight, { animate: false });
setSeason(startSeason);
if (view) {
  view.env.monsoon = startSeason === 'monsoon' ? 1 : 0;
  view.env.festival = startSeason === 'festival' ? 1 : 0;
}
// Warm start: run the simulation briefly before the first frame so the map opens mid-shift, busy.
const warmup = Math.min(120, Math.max(0, Number(params.get('warmup') ?? 30)));
warming = true;
for (let t = 0; t < warmup; t += 1 / 30) sim.step(1 / 30);
warming = false;
sim.markAlertsRead();
updateAlertsBadge();
updateClock();
renderDetail();
renderTracker();
renderTables(true);
renderKpis();
labelBinds.refresh();
document.body.dataset.ready = 'true';

let last = performance.now();
let halfSecond = 0;
let oneSecond = 0;
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (!state.paused) sim.step(dt);
  if (view) {
    view.frame(dt, { trafficVehicles: traffic.vehicles, centres: sim.centres, fireworksAt: temple });
    positionLabels();
  }
  routeClock += dt;
  updateRoute();
  halfSecond += dt;
  oneSecond += dt;
  if (halfSecond >= 0.5) {
    halfSecond = 0;
    const tracked = state.trackedRunId ? runOf(state.trackedRunId) : null;
    const stale = !tracked || (!sim.runs.has(tracked.id) && sim.time - (tracked.doneT ?? 0) > 6);
    if (stale || $('#tracker-content').dataset.key !== trackerKey(tracked)) renderTracker();
    trackerBinds.refresh();
    detailBinds.refresh();
    labelBinds.refresh();
  }
  if (oneSecond >= 1) {
    oneSecond = 0;
    updateClock();
    renderKpis();
    renderTables();
    view?.actors.setQueues(sim.clinical);
  }
  requestAnimationFrame(frame);
}
view?.actors.setQueues(sim.clinical);
requestAnimationFrame(frame);
