// Moving and transient things in the live view: vehicles (with night headlights, rain gear and sirens),
// request pins, selection ring, trails, planned route, delivery bursts, fireworks, patient queues and rain.
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RingGeometry
} from '/vendor/three.js';
import { GeoBuilder, color, shade } from './geometry.js';
import { radialTexture } from './world.js';
import { mulberry32, pick, range } from './util.js';

const CAR_COLORS = ['#E9E4DB', '#C8D3DD', '#D9C4B1', '#A0AAB4', '#E3CFA4', '#B9CAB5', '#D3B9B9', '#8C98A4'];
const PEOPLE = ['#D9826B', '#7FA8C9', '#E0B85E', '#9DBF8A', '#B58DB5', '#E8A0A0', '#6F8FB0', '#C9A27E'];
const TYRE = '#3A3C40';
const GLASS = '#5E6E7B';
const RAINCOAT = '#F2C744';

function vehicleParts(kind, variant, accents) {
  // Lamps are baked into the body (one draw call per vehicle); night glow comes from headlight pools.
  const body = new GeoBuilder();
  const lamps = body;
  const C = color;
  const wheel = (x, z, w = 0.14, r = 0.28) => body.box(x, 0, z, w, r, r, C(TYRE), { ao: 1 });
  const head = (x, y, z, w = 0.16) => lamps.box(x, y, z, w, 0.08, 0.03, C('#FFF3C4'), { ao: 1 });
  const tail = (x, y, z, w = 0.14) => lamps.box(x, y, z, w, 0.07, 0.03, C('#FF5A4E'), { ao: 1 });
  switch (kind) {
    case 'car': {
      const paint = C(CAR_COLORS[variant % CAR_COLORS.length]);
      body.box(0, 0.13, 0, 0.92, 0.36, 1.86, paint, { top: shade(paint, 1.05), ao: 0.82 });
      body.box(0, 0.49, -0.1, 0.8, 0.3, 1.0, C(GLASS), { top: paint, ao: 1 });
      body.box(0, 0.79, -0.1, 0.82, 0.05, 0.94, paint, { ao: 1 });
      for (const sx of [-0.42, 0.42]) for (const sz of [-0.6, 0.6]) wheel(sx, sz);
      head(-0.3, 0.33, 0.935);
      head(0.3, 0.33, 0.935);
      tail(-0.32, 0.35, -0.935);
      tail(0.32, 0.35, -0.935);
      break;
    }
    case 'auto': {
      const yellow = C('#E9C24F');
      const dark = C('#33373C');
      body.box(0, 0.13, 0.02, 0.82, 0.42, 1.0, yellow, { ao: 0.85 });
      body.box(0, 0.13, 0.58, 0.4, 0.5, 0.22, yellow, { ao: 0.85 });
      body.box(0, 0.55, -0.04, 0.86, 0.44, 1.02, dark, { top: dark, ao: 1 });
      body.box(0, 0.6, 0.47, 0.6, 0.3, 0.04, C(GLASS), { ao: 1 });
      wheel(0, 0.6, 0.1, 0.26);
      wheel(-0.38, -0.34, 0.1, 0.26);
      wheel(0.38, -0.34, 0.1, 0.26);
      head(0, 0.5, 0.71, 0.14);
      tail(-0.3, 0.3, -0.5);
      tail(0.3, 0.3, -0.5);
      break;
    }
    case 'bus': {
      const teal = C('#7FB1AA');
      body.box(0, 0.16, 0, 1.0, 0.55, 3.4, teal, { ao: 0.82 });
      body.box(0, 0.71, 0, 1.0, 0.42, 3.4, C(GLASS), { ao: 1 });
      body.box(0, 1.13, 0, 1.0, 0.12, 3.4, C('#F4F4F2'), { ao: 1 });
      for (const sx of [-0.45, 0.45]) for (const sz of [-1.1, 1.1]) wheel(sx, sz, 0.14, 0.32);
      head(-0.32, 0.36, 1.705);
      head(0.32, 0.36, 1.705);
      tail(-0.36, 0.4, -1.705);
      tail(0.36, 0.4, -1.705);
      break;
    }
    case 'scooter': {
      const fleet = variant === 1;
      const shell = C(fleet ? '#F1F1EE' : CAR_COLORS[(variant + 3) % CAR_COLORS.length]);
      const dark = C('#3A3E44');
      body.box(0, 0.13, 0, 0.22, 0.12, 0.66, shell, { ao: 0.9 });
      body.box(0, 0.13, 0.32, 0.24, 0.5, 0.1, shell, { ao: 0.9 });
      body.box(0, 0.6, 0.3, 0.42, 0.04, 0.05, dark, { ao: 1 });
      body.box(0, 0.33, -0.12, 0.2, 0.1, 0.36, dark, { ao: 1 });
      body.box(0, 0, 0.36, 0.08, 0.28, 0.28, C(TYRE), { ao: 1 });
      body.box(0, 0, -0.34, 0.08, 0.28, 0.28, C(TYRE), { ao: 1 });
      const jacket = C(fleet ? '#E8EDF3' : pick(mulberry32(variant + 7), PEOPLE));
      body.box(0, 0.42, -0.06, 0.3, 0.44, 0.22, jacket, { ao: 0.9 });
      body.beam(-0.14, 0.02, -0.2, 0.28, 0.66, 0.06, 0.06, jacket, { ao: 1 });
      body.beam(0.14, 0.02, 0.2, 0.28, 0.66, 0.06, 0.06, jacket, { ao: 1 });
      body.blob(0, 1.0, -0.04, 0.14, 0.15, 0.15, fleet ? C(accents.primary) : C('#4A4F55'));
      if (fleet) {
        // Insulated medicine box with the brand band.
        body.box(0, 0.34, -0.43, 0.36, 0.34, 0.32, C('#FFFFFF'), { ao: 0.92 });
        body.box(0, 0.5, -0.43, 0.37, 0.09, 0.33, C(accents.primary), { ao: 1 });
      }
      head(0, 0.5, 0.375, 0.1);
      tail(0, 0.3, -0.6, 0.1);
      break;
    }
    case 'ambulance': {
      const white = C('#FBFBF9');
      body.box(0, 0.16, 0, 1.0, 0.86, 2.2, white, { ao: 0.85 });
      body.box(0, 0.5, -0.1, 1.02, 0.12, 1.9, C(accents.error), { ao: 1 });
      body.panel(0, 0.78, 1.101, 0.84, 0.3, 0, C(GLASS));
      body.panel(-0.501, 0.78, 0.8, 0.4, 0.26, -Math.PI / 2, C(GLASS));
      body.panel(0.501, 0.78, 0.8, 0.4, 0.26, Math.PI / 2, C(GLASS));
      body.box(0, 1.02, 0.55, 0.7, 0.06, 0.24, C('#DADDE0'), { ao: 1 });
      for (const sx of [-0.45, 0.45]) for (const sz of [-0.7, 0.7]) wheel(sx, sz, 0.14, 0.3);
      head(-0.32, 0.36, 1.105);
      head(0.32, 0.36, 1.105);
      tail(-0.36, 0.42, -1.105);
      tail(0.36, 0.42, -1.105);
      break;
    }
    case 'van': {
      const white = C('#F6F6F3');
      body.box(0, 0.16, 0, 1.0, 0.8, 2.1, white, { ao: 0.85 });
      body.box(0, 0.42, -0.25, 1.02, 0.2, 1.5, C(accents.primary), { ao: 1 });
      body.panel(0, 0.72, 1.051, 0.84, 0.28, 0, C(GLASS));
      for (const sx of [-0.45, 0.45]) for (const sz of [-0.68, 0.68]) wheel(sx, sz, 0.14, 0.3);
      head(-0.32, 0.36, 1.055);
      head(0.32, 0.36, 1.055);
      tail(-0.36, 0.4, -1.055);
      tail(0.36, 0.4, -1.055);
      break;
    }
    case 'tractor': {
      // Tractor up front, open trolley with a load behind.
      const paint = C(variant % 2 ? '#4F86B8' : '#5E9150');
      body.box(0, 0.3, 0.75, 0.5, 0.42, 0.9, paint, { ao: 0.85 });
      body.box(0, 0.3, 0.18, 0.78, 0.36, 0.42, paint, { ao: 0.85 });
      body.box(0, 0.66, 0.18, 0.12, 0.42, 0.12, C('#3A3E44'), { ao: 1 });
      body.blob(0, 1.12, 0.12, 0.12, 0.13, 0.12, C('#C9A27E'));
      body.box(0, 0.7, 0.12, 0.28, 0.36, 0.2, C('#E9EDF3'), { ao: 1 });
      body.box(-0.42, 0, 0.18, 0.14, 0.62, 0.62, C(TYRE), { ao: 1 });
      body.box(0.42, 0, 0.18, 0.14, 0.62, 0.62, C(TYRE), { ao: 1 });
      wheel(-0.26, 1.05, 0.1, 0.34);
      wheel(0.26, 1.05, 0.1, 0.34);
      body.box(0, 0.32, -0.32, 0.12, 0.08, 0.5, C('#3A3E44'), { ao: 1 });
      body.box(0, 0.3, -0.85, 0.98, 0.42, 0.9, C('#A88A63'), { ao: 0.85 });
      body.box(0, 0.72, -0.85, 0.86, 0.18, 0.78, C(variant % 3 ? '#E3C66C' : '#8DB46A'), { ao: 1 });
      wheel(-0.47, -0.85, 0.1, 0.36);
      wheel(0.47, -0.85, 0.1, 0.36);
      head(0, 0.52, 1.205, 0.2);
      tail(-0.4, 0.4, -1.305);
      tail(0.4, 0.4, -1.305);
      break;
    }
    case 'cart': {
      // Bullock cart: two white bullocks and a covered wooden cart with big wheels.
      const ox = C('#F1EEE6');
      for (const sx of [-0.24, 0.24]) {
        body.box(sx, 0.32, 0.82, 0.26, 0.36, 0.62, ox, { ao: 0.9 });
        body.box(sx, 0.52, 1.16, 0.16, 0.2, 0.22, ox, { ao: 0.9 });
        body.box(sx - 0.05, 0.72, 1.18, 0.03, 0.12, 0.03, C('#5A4632'), { ao: 1 });
        body.box(sx + 0.05, 0.72, 1.18, 0.03, 0.12, 0.03, C('#5A4632'), { ao: 1 });
        for (const lx of [-0.08, 0.08]) for (const lz of [0.6, 1.02]) body.box(sx + lx, 0, lz, 0.06, 0.32, 0.06, ox, { ao: 0.9 });
      }
      body.box(0, 0.5, 0.42, 0.06, 0.06, 0.5, C('#7A5B3C'), { ao: 1 });
      body.box(0, 0.42, -0.5, 0.86, 0.14, 1.3, C('#9A7650'), { ao: 0.9 });
      for (let k = 0; k < 5; k++) {
        const a0 = (k / 5) * Math.PI;
        const a1 = ((k + 1) / 5) * Math.PI;
        const p = (a, zz) => [Math.cos(a) * 0.45, 0.56 + Math.sin(a) * 0.42, zz];
        const hood = C('#C9B38A');
        body.quad(p(a0, -1.1), p(a1, -1.1), p(a1, 0.05), p(a0, 0.05), hood, hood, hood, hood, [Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2), 0]);
      }
      body.box(-0.47, 0, -0.5, 0.06, 0.7, 0.7, C('#6B5139'), { ao: 1 });
      body.box(0.47, 0, -0.5, 0.06, 0.7, 0.7, C('#6B5139'), { ao: 1 });
      break;
    }
    default:
      body.box(0, 0, 0, 0.9, 0.6, 1.8, C('#CCCCCC'));
  }
  return { body: body.build() };
}

/** Teardrop map pin pointing down at the origin. */
function pinGeometry(hex) {
  const g = new GeoBuilder();
  const c = color(hex);
  g.prism(0, 0, 0, 0.02, 0.38, 0.85, 10, c, { ao: 0.8, cap: false });
  g.blob(0, 1.08, 0, 0.52, 0.52, 0.52, c, { light: 1.15, dark: 0.85 });
  g.blob(0, 1.1, 0.42, 0.2, 0.2, 0.12, color('#FFFFFF'), { light: 1, dark: 1 });
  return g.build();
}

export function createActors({ scene, accents, quality }) {
  const rng = mulberry32(5);
  const group = new Group();
  scene.add(group);
  const dummy = new Object3D();

  const matBody = new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.04 });
  const matRain = new MeshStandardMaterial({ color: RAINCOAT, roughness: 0.45 });
  const matSirenRed = new MeshBasicMaterial({ color: accents.error });
  const matSirenBlue = new MeshBasicMaterial({ color: '#3D7BFF' });
  const glowTex = radialTexture();

  const partsCache = new Map();
  const partsFor = (kind, variant) => {
    const key = `${kind}:${variant}`;
    if (!partsCache.has(key)) partsCache.set(key, vehicleParts(kind, variant, accents));
    return partsCache.get(key);
  };
  const raincoatGeo = (() => {
    const g = new GeoBuilder();
    g.prism(0, 0.34, -0.08, 0.3, 0.16, 0.66, 8, color(RAINCOAT), { ao: 0.9 });
    g.blob(0, 1.02, -0.05, 0.17, 0.17, 0.17, color(RAINCOAT));
    return g.build();
  })();
  const sirenGeo = (() => {
    const g = new GeoBuilder();
    g.box(0, 0, 0, 0.26, 0.1, 0.2, color('#FFFFFF'), { ao: 1 });
    return g.build();
  })();

  // ---- Vehicles -------------------------------------------------------------------------------
  const vehicles = new Map(); // traffic vehicle id -> { v, group, raincoat, sirens }
  const headPools = new InstancedMesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({ map: glowTex, color: new Color('#FFE3A8'), transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }),
    96
  );
  headPools.count = 0;
  headPools.renderOrder = 2;
  group.add(headPools);

  function ensureVehicle(v) {
    let entry = vehicles.get(v.id);
    if (entry) return entry;
    const variant = v.fleet ? 1 : Math.floor(rng() * 8) + (v.kind === 'scooter' ? 2 : 0);
    const parts = partsFor(v.kind, v.kind === 'scooter' ? variant : variant % 8);
    const g = new Group();
    const body = new Mesh(parts.body, matBody);
    body.castShadow = true;
    g.add(body);
    let raincoat = null;
    let sirens = null;
    if (v.kind === 'scooter') {
      raincoat = new Mesh(raincoatGeo, matRain);
      raincoat.visible = false;
      g.add(raincoat);
    }
    if (v.kind === 'ambulance') {
      const red = new Mesh(sirenGeo, matSirenRed);
      red.position.set(-0.17, 1.08, 0.55);
      const blue = new Mesh(sirenGeo, matSirenBlue);
      blue.position.set(0.17, 1.08, 0.55);
      g.add(red, blue);
      sirens = [red, blue];
    }
    group.add(g);
    entry = { v, group: g, raincoat, sirens };
    vehicles.set(v.id, entry);
    return entry;
  }

  // ---- Pins, rings, trails, route, bursts -----------------------------------------------------
  const pinGeos = { primary: pinGeometry(accents.primary), error: pinGeometry(accents.error) };
  const pins = new Map(); // run id -> pin
  const ringGeo = new RingGeometry(0.62, 0.78, 40);

  function addPin(run, { x, z, y }) {
    const kind = run.type === 'referral' ? 'error' : 'primary';
    const mesh = new Mesh(pinGeos[kind], matBody);
    mesh.castShadow = true;
    const ping = new Mesh(ringGeo, new MeshBasicMaterial({ color: kind === 'error' ? accents.error : accents.primary, transparent: true, opacity: 0.8, depthWrite: false, side: DoubleSide }));
    ping.rotation.x = -Math.PI / 2;
    ping.position.set(x, 0.16, z);
    const pin = { runId: run.id, mesh, ping, x, z, base: y + 0.5, t: 0 };
    mesh.position.set(x, pin.base + 14, z);
    group.add(mesh, ping);
    pins.set(run.id, pin);
    return pin;
  }

  function removePin(runId) {
    const pin = pins.get(runId);
    if (!pin) return;
    group.remove(pin.mesh, pin.ping);
    pin.ping.material.dispose();
    pins.delete(runId);
  }

  const selectRing = new Mesh(new RingGeometry(1, 1.16, 64), new MeshBasicMaterial({ color: accents.primary, transparent: true, opacity: 0.95, depthWrite: false, side: DoubleSide }));
  selectRing.rotation.x = -Math.PI / 2;
  selectRing.visible = false;
  selectRing.renderOrder = 3;
  const selectDisc = new Mesh(new RingGeometry(0, 1, 48), new MeshBasicMaterial({ color: accents.primary, transparent: true, opacity: 0.12, depthWrite: false, side: DoubleSide }));
  selectDisc.rotation.x = -Math.PI / 2;
  selectDisc.visible = false;
  group.add(selectRing, selectDisc);
  let selection = null;

  // Glowing ground pings (a centre lighting up when it approves a request).
  const pings = [];
  function ping(x, z, hex, size = 6) {
    const mesh = new Mesh(new RingGeometry(0.8, 1, 48), new MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide, blending: AdditiveBlending }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.2, z);
    group.add(mesh);
    pings.push({ mesh, t: 0, size });
  }

  // Medicine scan: a radar sweep spreading out from the patient's home across the map.
  const scans = [];
  function scan(x, z, radius, hex) {
    const mat = (opacity) => new MeshBasicMaterial({ color: hex, transparent: true, opacity, depthWrite: false, side: DoubleSide, blending: AdditiveBlending });
    const ring = new Mesh(new RingGeometry(0.97, 1, 96), mat(0.9));
    const fill = new Mesh(new RingGeometry(0, 1, 96), mat(0.1));
    const sweep = new Mesh(new RingGeometry(0, 1, 32, 1, 0, Math.PI / 4), mat(0.3));
    for (const [m, y] of [[fill, 0.21], [sweep, 0.22], [ring, 0.23]]) {
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      m.renderOrder = 4;
      group.add(m);
    }
    scans.push({ ring, fill, sweep, radius, t: 0, life: 2.6 });
  }
  function updateScans(dt) {
    for (let i = scans.length - 1; i >= 0; i--) {
      const s = scans[i];
      s.t += dt;
      const k = Math.min(1, s.t / s.life);
      const r = s.radius * (1 - (1 - k) ** 3);
      s.ring.scale.setScalar(Math.max(0.01, r));
      s.fill.scale.setScalar(Math.max(0.01, r));
      s.sweep.scale.setScalar(Math.max(0.01, r));
      s.sweep.rotation.set(-Math.PI / 2, 0, s.t * 4.2);
      const fade = k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
      s.ring.material.opacity = 0.9 * fade;
      s.fill.material.opacity = 0.1 * fade;
      s.sweep.material.opacity = 0.3 * fade;
      if (k >= 1) {
        for (const m of [s.ring, s.fill, s.sweep]) {
          group.remove(m);
          m.geometry.dispose();
          m.material.dispose();
        }
        scans.splice(i, 1);
      }
    }
  }

  // Attention pins: a big red map pin over a place where a case from the ASHA app needs a doctor. While a
  // case there is still unopened the pin bobs, its light column pulses and rings spread on the ground.
  const beaconGeo = (() => {
    const seg = 20;
    const pos = [];
    const col = [];
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2;
      const a1 = ((k + 1) / seg) * Math.PI * 2;
      const p = (a, y) => [Math.cos(a), y, Math.sin(a)];
      const quad = [p(a0, 0), p(a1, 0), p(a1, 1), p(a0, 0), p(a1, 1), p(a0, 1)];
      for (const v of quad) {
        pos.push(...v);
        const c = v[1] === 0 ? 1 : 0;
        col.push(c, c, c);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    return g;
  })();
  const beaconPinGeos = new Map(); // hex -> pin geometry
  const beacons = new Map(); // id -> beacon
  function addBeacon(id, { x, z, top = 1, hex, ref = null, pulse = true }) {
    const existing = beacons.get(id);
    if (existing && existing.hex === hex && existing.x === x && existing.z === z) {
      existing.ref = ref;
      existing.pulse = pulse;
      return existing;
    }
    removeBeacon(id);
    if (!beaconPinGeos.has(hex)) beaconPinGeos.set(hex, pinGeometry(hex));
    const beam = new Mesh(beaconGeo, new MeshBasicMaterial({ vertexColors: true, color: hex, transparent: true, opacity: 0.6, depthWrite: false, side: DoubleSide, blending: AdditiveBlending }));
    beam.position.set(x, 0.1, z);
    beam.scale.set(1.2, 16, 1.2);
    beam.renderOrder = 4;
    const marker = new Mesh(beaconPinGeos.get(hex), matBody);
    marker.scale.setScalar(2.0);
    marker.castShadow = true;
    const rings = [0, 0.5].map((phase) => {
      const ring = new Mesh(new RingGeometry(0.86, 1, 48), new MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide, blending: AdditiveBlending }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.18, z);
      ring.renderOrder = 4;
      return { mesh: ring, phase };
    });
    group.add(beam, marker, ...rings.map((r) => r.mesh));
    const beacon = { id, ref, hex, x, z, top, beam, marker, rings, pulse, t: 0 };
    beacons.set(id, beacon);
    return beacon;
  }
  function removeBeacon(id) {
    const b = beacons.get(id);
    if (!b) return;
    group.remove(b.beam, b.marker, ...b.rings.map((r) => r.mesh));
    b.beam.material.dispose();
    for (const r of b.rings) {
      r.mesh.geometry.dispose();
      r.mesh.material.dispose();
    }
    beacons.delete(id);
  }
  function updateBeacons(dt, calm, azimuth) {
    for (const b of beacons.values()) {
      b.t += dt;
      const live = b.pulse && !calm;
      const bob = live ? Math.abs(Math.sin(b.t * 3)) * 0.8 : 0;
      b.marker.position.set(b.x, b.top + bob, b.z);
      b.marker.rotation.y = azimuth;
      b.beam.material.opacity = live ? 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(b.t * 4)) : 0.3;
      for (const r of b.rings) {
        r.mesh.visible = b.pulse;
        const k = live ? (b.t * 0.7 + r.phase) % 1 : 0.35;
        r.mesh.scale.setScalar(1.6 + k * 6);
        r.mesh.material.opacity = (1 - k) * 0.9;
      }
    }
  }
  // Trails: fading ribbons behind fleet vehicles on a run.
  const trails = new Map();
  const TRAIL_POINTS = quality.low ? 36 : 60;
  function trailFor(id, hex) {
    let trail = trails.get(id);
    if (trail) {
      trail.color.set(hex);
      return trail;
    }
    const geo = new BufferGeometry();
    const max = (TRAIL_POINTS - 1) * 6;
    const pos = new Float32BufferAttribute(new Float32Array(max * 3), 3);
    const col = new Float32BufferAttribute(new Float32Array(max * 4), 4);
    pos.setUsage(DynamicDrawUsage);
    col.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('color', col);
    geo.setDrawRange(0, 0);
    const mesh = new Mesh(geo, new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    group.add(mesh);
    trail = { mesh, points: [], color: new Color(hex), fade: 1 };
    trails.set(id, trail);
    return trail;
  }

  function rebuildTrail(trail) {
    const pts = trail.points;
    const pos = trail.mesh.geometry.attributes.position.array;
    const col = trail.mesh.geometry.attributes.color.array;
    let n = 0;
    const width = 0.22;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const ox = (-dz / len) * width;
      const oz = (dx / len) * width;
      const ta = ((i - 1) / pts.length) * 0.85 * trail.fade;
      const tb = (i / pts.length) * 0.85 * trail.fade;
      const verts = [
        [a.x + ox, a.z + oz, ta],
        [a.x - ox, a.z - oz, ta],
        [b.x - ox, b.z - oz, tb],
        [a.x + ox, a.z + oz, ta],
        [b.x - ox, b.z - oz, tb],
        [b.x + ox, b.z + oz, tb]
      ];
      for (const [x, z, alpha] of verts) {
        pos[n * 3] = x;
        pos[n * 3 + 1] = 0.06;
        pos[n * 3 + 2] = z;
        col[n * 4] = trail.color.r;
        col[n * 4 + 1] = trail.color.g;
        col[n * 4 + 2] = trail.color.b;
        col[n * 4 + 3] = alpha;
        n += 1;
      }
    }
    trail.mesh.geometry.setDrawRange(0, n);
    trail.mesh.geometry.attributes.position.needsUpdate = true;
    trail.mesh.geometry.attributes.color.needsUpdate = true;
  }

  // Planned route of the selected vehicle, drawn as dashes on the road.
  const routeMat = new MeshBasicMaterial({ color: accents.primary, transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide });
  let routeMesh = null;
  function setRoute(points, hex = accents.primary) {
    if (routeMesh) {
      group.remove(routeMesh);
      routeMesh.geometry.dispose();
      routeMesh = null;
    }
    if (!points || points.length < 2) return;
    routeMat.color.set(hex);
    const g = new GeoBuilder();
    const white = color('#FFFFFF');
    let carry = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-4) continue;
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      for (let s = carry; s < len; s += 1.0) {
        const e = Math.min(len, s + 0.55);
        const cx = a.x + ux * (s + e) / 2;
        const cz = a.z + uz * (s + e) / 2;
        g.rectRot(cx, cz, 0.2, e - s, 0.07, Math.atan2(ux, uz), white);
        carry = s + 1.0 - len;
      }
    }
    if (g.empty) return;
    routeMesh = new Mesh(g.build(), routeMat);
    routeMesh.renderOrder = 2;
    group.add(routeMesh);
  }

  // Bursts: a ring and a puff of particles when a delivery completes.
  const bursts = [];
  const BURST_N = 26;
  function burst(x, y, z, hex, { fireworks = false } = {}) {
    const n = fireworks ? 70 : BURST_N;
    const geo = new BufferGeometry();
    const pos = new Float32Array(n * 3);
    const vel = [];
    for (let i = 0; i < n; i++) {
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      const a = rng() * Math.PI * 2;
      const up = fireworks ? range(rng, -1, 1) : range(rng, 0.4, 1);
      const sp = fireworks ? range(rng, 4, 6.5) : range(rng, 2.2, 4);
      const flat = Math.sqrt(Math.max(0, 1 - up * up));
      vel.push([Math.cos(a) * flat * sp, up * sp + (fireworks ? 0 : 2), Math.sin(a) * flat * sp]);
    }
    const attr = new Float32BufferAttribute(pos, 3);
    attr.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', attr);
    const pts = new Points(geo, new PointsMaterial({ color: hex, size: fireworks ? 0.5 : 0.36, map: glowTex, transparent: true, depthWrite: false, blending: AdditiveBlending }));
    pts.frustumCulled = false;
    group.add(pts);
    let ring = null;
    if (!fireworks) {
      ring = new Mesh(new RingGeometry(0.85, 1, 48), new MeshBasicMaterial({ color: hex, transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.2, z);
      group.add(ring);
    }
    bursts.push({ pts, ring, vel, t: 0, life: fireworks ? 1.9 : 1.2, gravity: fireworks ? 2.2 : 6 });
  }

  // ---- Patient queues at centre entrances -----------------------------------------------------
  const personGeo = (() => {
    const g = new GeoBuilder();
    g.prism(0, 0.12, 0, 0.13, 0.1, 0.42, 7, color('#FFFFFF'), { ao: 0.9 });
    g.blob(0, 0.66, 0, 0.1, 0.11, 0.1, color('#F4E3D3'), { light: 1, dark: 0.9 });
    return g.build();
  })();
  const QUEUE_MAX = 18;
  let queueSlots = [];
  const people = new InstancedMesh(personGeo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), 3 * QUEUE_MAX);
  people.castShadow = true;
  people.count = 0;
  for (let i = 0; i < 3 * QUEUE_MAX; i++) people.setColorAt(i, color(PEOPLE[i % PEOPLE.length]));
  group.add(people);

  function setQueues(centres) {
    queueSlots = [];
    for (const c of centres) {
      const n = Math.min(QUEUE_MAX, Math.round((c.waiting || 0) * 0.6));
      for (let k = 0; k < n; k++) queueSlots.push({ ...c.queue[k], heading: c.rot + Math.PI });
    }
    queueSlots.forEach((p, i) => {
      dummy.position.set(p.x + Math.sin(i * 12.9) * 0.08, 0.12, p.z + Math.cos(i * 7.3) * 0.08);
      dummy.rotation.set(0, p.heading + Math.sin(i) * 0.4, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      people.setMatrixAt(i, dummy.matrix);
    });
    people.count = queueSlots.length;
    people.instanceMatrix.needsUpdate = true;
  }

  // ---- Rain -----------------------------------------------------------------------------------
  const DROPS = quality.low ? 700 : 1800;
  const rainPos = new Float32Array(DROPS * 6);
  const rainGeo = new BufferGeometry();
  const rainAttr = new Float32BufferAttribute(rainPos, 3);
  rainAttr.setUsage(DynamicDrawUsage);
  rainGeo.setAttribute('position', rainAttr);
  const rain = new LineSegments(rainGeo, new LineBasicMaterial({ color: '#F2F6FA', transparent: true, opacity: 0, depthWrite: false }));
  rain.frustumCulled = false;
  rain.visible = false;
  group.add(rain);
  // Denser near the middle of the view, where the camera looks.
  const spread = () => range(rng, -1, 1) * Math.abs(range(rng, -1, 1)) * 60;
  const drops = Array.from({ length: DROPS }, () => ({ x: spread(), y: range(rng, 0, 30), z: spread(), s: range(rng, 26, 36) }));

  let sirenClock = 0;
  let fireworkClock = 2;
  const tmpColor = new Color();

  return {
    vehicles,
    pins,
    beacons,
    addBeacon,
    removeBeacon,
    addPin,
    removePin,
    ping,
    scan,
    burst,
    setRoute,
    setQueues,
    trailFor,
    removeTrail(id) {
      const trail = trails.get(id);
      if (trail) trail.dying = true;
    },
    setSelection(sel) {
      selection = sel;
      selectRing.visible = Boolean(sel);
      selectDisc.visible = Boolean(sel);
    },
    update(dt, env, { trafficVehicles, target, fleetIds, fireworksAt }) {
      // Vehicles follow the traffic simulation.
      let pools = 0;
      sirenClock += dt;
      const flash = Math.floor(sirenClock * 6) % 2 === 0;
      for (const v of trafficVehicles) {
        const entry = ensureVehicle(v);
        const g = entry.group;
        g.position.set(v.x, 0.12 + (v.kind === 'scooter' && v.speed > 0.5 ? Math.sin(sirenClock * 14 + v.x) * 0.012 : 0), v.z);
        g.rotation.y = v.heading;
        if (entry.raincoat) entry.raincoat.visible = env.monsoon > 0.5 && fleetIds.has(v.id);
        if (entry.sirens) {
          entry.sirens[0].visible = !v.emergency || flash;
          entry.sirens[1].visible = !v.emergency || !flash;
        }
        if (env.night > 0.05 && pools < headPools.instanceMatrix.count && v.mode !== 'parked') {
          const fx = Math.sin(v.heading);
          const fz = Math.cos(v.heading);
          const reach = v.length / 2 + (v.kind === 'scooter' ? 0.8 : 1.3);
          dummy.position.set(v.x + fx * reach, 0.05, v.z + fz * reach);
          dummy.rotation.set(-Math.PI / 2, 0, v.heading);
          const w = v.kind === 'scooter' ? 0.9 : 1.5;
          dummy.scale.set(w, w * 1.9, 1);
          dummy.updateMatrix();
          headPools.setMatrixAt(pools++, dummy.matrix);
        }
      }
      headPools.count = pools;
      headPools.instanceMatrix.needsUpdate = true;
      headPools.material.opacity = env.night * 0.42;

      // Pins drop in, bob, and ping the ground.
      for (const pin of pins.values()) {
        pin.t += dt;
        const drop = Math.min(1, pin.t / 0.7);
        const bounce = drop < 1 ? (1 - drop) ** 2 * 14 : Math.abs(Math.sin(pin.t * 2.2)) * 0.25;
        pin.mesh.position.y = pin.base + bounce;
        pin.mesh.rotation.y = target.azimuth;
        const phase = (pin.t * 0.8) % 1;
        pin.ping.scale.setScalar(1 + phase * 2.4);
        pin.ping.material.opacity = (1 - phase) * 0.8;
      }

      // Selection ring follows its entity.
      updateBeacons(dt, env.reducedMotion, target.azimuth);
      updateScans(dt);
      if (selection) {
        const p = selection.position();
        if (p) {
          const pulse = 1 + Math.sin(sirenClock * 3.2) * 0.06;
          const r = selection.radius * pulse;
          selectRing.position.set(p.x, 0.17, p.z);
          selectRing.scale.set(r, r, 1);
          selectDisc.position.set(p.x, 0.165, p.z);
          selectDisc.scale.set(r, r, 1);
        }
      }

      for (let i = pings.length - 1; i >= 0; i--) {
        const pg = pings[i];
        pg.t += dt;
        const k = pg.t / 1.4;
        pg.mesh.scale.setScalar(1 + k * pg.size);
        pg.mesh.material.opacity = Math.max(0, 1 - k) * 0.9;
        if (k >= 1) {
          group.remove(pg.mesh);
          pg.mesh.geometry.dispose();
          pg.mesh.material.dispose();
          pings.splice(i, 1);
        }
      }

      // Trails record recent positions of fleet vehicles on a run.
      for (const [id, trail] of trails) {
        const entry = vehicles.get(id);
        if (trail.dying) {
          trail.fade -= dt * 1.2;
          if (trail.fade <= 0) {
            group.remove(trail.mesh);
            trail.mesh.geometry.dispose();
            trail.mesh.material.dispose();
            trails.delete(id);
            continue;
          }
        } else if (entry) {
          const last = trail.points[trail.points.length - 1];
          const { x, z } = entry.v;
          if (!last || Math.hypot(last.x - x, last.z - z) > 0.3) {
            trail.points.push({ x, z });
            if (trail.points.length > TRAIL_POINTS) trail.points.shift();
          } else {
            last.x = x;
            last.z = z;
          }
        }
        rebuildTrail(trail);
      }

      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        b.t += dt;
        const arr = b.pts.geometry.attributes.position.array;
        b.vel.forEach((v, k) => {
          v[1] -= b.gravity * dt;
          arr[k * 3] += v[0] * dt;
          arr[k * 3 + 1] = Math.max(0.15, arr[k * 3 + 1] + v[1] * dt);
          arr[k * 3 + 2] += v[2] * dt;
        });
        b.pts.geometry.attributes.position.needsUpdate = true;
        const k = b.t / b.life;
        b.pts.material.opacity = Math.max(0, 1 - k);
        if (b.ring) {
          b.ring.scale.setScalar(0.4 + k * 3);
          b.ring.material.opacity = Math.max(0, 1 - k);
        }
        if (k >= 1) {
          group.remove(b.pts);
          b.pts.geometry.dispose();
          b.pts.material.dispose();
          if (b.ring) {
            group.remove(b.ring);
            b.ring.geometry.dispose();
            b.ring.material.dispose();
          }
          bursts.splice(i, 1);
        }
      }

      // Festival night fireworks over the temple.
      if (env.festival > 0.6 && env.night > 0.6 && fireworksAt && !env.reducedMotion) {
        fireworkClock -= dt;
        if (fireworkClock <= 0) {
          fireworkClock = range(rng, 1.2, 2.8);
          tmpColor.set(pick(rng, ['#FFD36B', '#FF8FA3', '#8FD3FF', '#B6F08A', '#FFB86B']));
          burst(fireworksAt.x + range(rng, -10, 10), range(rng, 13, 18), fireworksAt.z + range(rng, -8, 8), tmpColor.getHex(), { fireworks: true });
        }
      }

      // Rain falls around the camera target.
      rain.visible = env.monsoon > 0.02;
      if (rain.visible) {
        rain.material.opacity = env.monsoon * 0.8;
        drops.forEach((d, i) => {
          d.y -= d.s * dt;
          if (d.y < 0) {
            d.y = range(rng, 22, 30);
            d.x = target.x + spread();
            d.z = target.z + spread();
          }
          const o = i * 6;
          rainPos[o] = d.x;
          rainPos[o + 1] = d.y;
          rainPos[o + 2] = d.z;
          rainPos[o + 3] = d.x - 0.2;
          rainPos[o + 4] = d.y + 1.7;
          rainPos[o + 5] = d.z - 0.08;
        });
        rainAttr.needsUpdate = true;
      }
    }
  };
}
