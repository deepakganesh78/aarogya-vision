// World layout for the live view: Jawadhu Hills block (Tiruvannamalai district), with hill villages around
// the block-headquarters town Jamunamarathur, paddy fields, groves and a tank, on the road grid. Village
// names match the demo people in src/people.json; the layout itself is invented. Deterministic (seeded),
// pure data (no DOM, no Three.js).
import { BLOCK, PITCH } from './network.js';
import { mulberry32, pick, range, rangeInt, weighted } from './util.js';

export const GRID = { nx: 5, nz: 4 };
export const BLOCK_NAME = 'Jawadhu Hills block';
export const DISTRICT_NAME = 'Tiruvannamalai';

export const AREAS = [
  { id: 'arasur', name: 'Jamunamarathur' },
  { id: 'nallur', name: 'Pudurnadu' },
  { id: 'kattur', name: 'Nammiyampattu' },
  { id: 'siruvakkam', name: 'Kovilur' },
  { id: 'mettur', name: 'Kanamalai' },
  { id: 'pudupakkam', name: 'Melpattu' },
  { id: 'vallam', name: 'Athipattu' }
];

const PLAN = [
  ['village', 'paddy', 'grove', 'village', 'centre:phc-nallur'],
  ['paddy', 'lake', 'town:market', 'centre:store', 'sugarcane'],
  ['village', 'paddy', 'centre:chc-arasur', 'town:school', 'village'],
  ['centre:phc-pudupakkam', 'village', 'banana', 'village', 'paddy']
];
const AREA_PLAN = [
  ['kattur', 'kattur', 'nallur', 'nallur', 'nallur'],
  ['kattur', 'arasur', 'arasur', 'arasur', 'nallur'],
  ['siruvakkam', 'siruvakkam', 'arasur', 'arasur', 'mettur'],
  ['pudupakkam', 'pudupakkam', 'vallam', 'vallam', 'mettur']
];

export const ROAD_NAMES = {
  h: ['Nammiyampattu Road', 'Pudurnadu Road', 'Jamunamarathur Main Road', 'Lake Road', 'Athipattu Road'],
  v: ['Kovilur Road', 'Melpattu Road', 'Temple Street', 'Market Road', 'Kanamalai Road', 'Ghat Road']
};

// ASHA workers, one or two per village. Parvati (asha-001) and Meena (asha-002) are the demo workers in
// src/people.json, so their real cases from the ASHA app land in their own villages; the rest are synthetic.
export const ASHAS = {
  arasur: [{ id: 'ASHA-01', name: 'Selvi M' }, { id: 'ASHA-02', name: 'Revathi K' }],
  nallur: [{ id: 'ASHA-05', name: 'Kalaivani S' }],
  kattur: [{ id: 'asha-001', name: 'Parvati' }],
  siruvakkam: [{ id: 'asha-002', name: 'Meena' }],
  mettur: [{ id: 'ASHA-14', name: 'Shanthi V' }],
  pudupakkam: [{ id: 'ASHA-17', name: 'Anitha J' }],
  vallam: [{ id: 'ASHA-20', name: 'Jayanthi R' }]
};

const CENTRES = {
  'phc-nallur': { kind: 'phc', name: 'PHC Pudurnadu', type: 'Primary health centre', floors: 2, front: 'south', bays: { scooter: 3 } },
  'phc-pudupakkam': { kind: 'phc', name: 'PHC Melpattu', type: 'Primary health centre', floors: 2, front: 'north', bays: { scooter: 3 } },
  'chc-arasur': { kind: 'chc', name: 'PHC Jamunamarathur', type: 'Upgraded block PHC (24x7, newborn care, 108 base)', floors: 3, front: 'north', bays: { scooter: 3, ambulance: 2 } },
  store: { kind: 'warehouse', name: 'Block drug store', type: 'Medicine and vaccine store', floors: 1, front: 'south', bays: { van: 2 } }
};

// Sub-centres (Health and Wellness Centres) in villages without a PHC.
const HWC_VILLAGES = new Set(['kattur', 'siruvakkam', 'mettur', 'vallam']);
// Private medical shops in the town market, by shop owner (the medicine finder's retail sources).
const MEDICAL_SHOPS = { Murugan: 'Murugan Medicals', Lakshmi: 'Lakshmi Pharmacy', Sakthi: 'Sakthi Medicals' };

export function buildLayout({ seed = 7 } = {}, network) {
  const rng = mulberry32(seed);
  const { roadX, roadZ, nx, nz } = network;
  const half = BLOCK / 2;
  const areaName = (id) => AREAS.find((a) => a.id === id)?.name || id;

  const blocks = [];
  const buildings = [];
  const centres = [];
  const landmarks = [];
  const trees = [];
  const lights = [];
  const shelters = [];
  const fields = []; // farmland blocks: { cx, cz, kind }
  const villages = [];
  const keepClear = []; // {x, z, r}: no roadside trees here (gates, kerbside stops)
  let seq = 0;

  const roadNameFor = (frontage) => {
    if (!frontage) return null;
    const lane = network.lanes.get(frontage.laneId);
    return lane.road.axis === 'h' ? ROAD_NAMES.h[lane.road.index] : ROAD_NAMES.v[lane.road.index];
  };

  function addBuilding(b) {
    seq += 1;
    const building = { id: `b${seq}`, ...b };
    building.floors = Math.max(1, Math.round(building.h / 0.9));
    building.frontage = network.frontage(building.x, building.z);
    building.roadName = roadNameFor(building.frontage);
    if (building.kind === 'house' || building.kind === 'hwc') {
      const ashas = ASHAS[building.zone] || ASHAS.arasur;
      building.asha = ashas[seq % ashas.length];
      building.households = building.kind === 'house' ? rangeInt(rng, 1, 2) : 0;
      building.visitsDue = building.kind === 'house' && rng() < 0.3 ? 1 : 0;
    }
    if (building.frontage) {
      const lane = network.lanes.get(building.frontage.laneId);
      const p = network.pointOnLane(lane, building.frontage.s, 2.2);
      keepClear.push({ x: p.x, z: p.z, r: 1.8 });
    }
    buildings.push(building);
    return building;
  }

  function buildCentre(id, block) {
    const def = CENTRES[id];
    const rot = def.front === 'north' ? Math.PI : 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // Local frame: origin at the block centre, +z towards the front road. Rotations are 0 or 180 degrees,
    // so local widths and depths stay aligned with the world axes.
    const toWorld = (lx, lz) => ({ x: block.cx + lx * cos + lz * sin, z: block.cz - lx * sin + lz * cos });
    const box = (lx, lz, w, d, h) => ({ ...toWorld(lx, lz), w, d, h });
    const isWarehouse = def.kind === 'warehouse';
    const height = isWarehouse ? 3.2 : def.floors * 0.95 + 0.3;

    const bays = [];
    const addBays = (kind, xs, z) => {
      for (const lx of xs) bays.push({ kind, local: { x: lx, z }, ...toWorld(lx, z), heading: rot });
    };
    if (def.bays.ambulance) addBays('ambulance', [2.0, 3.6], -1.9);
    if (def.bays.van) addBays('van', [3.0, 5.1], -1.9);
    if (def.bays.scooter) addBays('scooter', def.bays.ambulance ? [4.9, 5.6, 6.3] : [2.4, 3.25, 4.1, 4.95].slice(0, def.bays.scooter), -1.3);
    bays.forEach((bay, index) => (bay.index = index));

    if (def.bays.ambulance) {
      shelters.push(box(2.8, -1.9, 3.4, 3.0, 1.75));
      shelters.push(box(5.6, -1.3, 2.4, 2.4, 1.5));
    } else if (def.bays.scooter) {
      shelters.push(box(3.7, -1.3, 3.6, 2.4, 1.5));
    }

    const gate = toWorld(1.0, 7.0);
    const frontage = network.frontage(gate.x, gate.z);
    const lane = network.lanes.get(frontage.laneId);
    // Returning vehicles wait at this kerb, one junction before the gate, while the gate kerb is taken.
    const feeders = network.nodes.get(lane.from).in.filter((id) => network.successors(id).includes(frontage.laneId));
    const feeder = feeders.find((id) => network.movement(id, frontage.laneId).kind === 'straight') || feeders[0];
    keepClear.push({ x: gate.x, z: gate.z, r: 4.6 });
    for (const [lx, lz] of [[-5.6, 5.6], [6.0, 5.4], [-6.0, -6.0], [6.2, -6.2]]) {
      const p = toWorld(lx, lz);
      trees.push({ x: p.x, z: p.z, kind: lz > 0 ? 'round' : 'palm', scale: 0.9 });
    }

    return {
      id,
      ...def,
      zone: block.zone,
      block: { bi: block.bi, bj: block.bj },
      cx: block.cx,
      cz: block.cz,
      rot,
      main: isWarehouse ? box(-2.8, -3.0, 7.6, 7.2, height) : box(-3.4, -2.6, 6.4, 8.0, height),
      annex: isWarehouse ? null : box(3.2, -5.0, 6.8, 3.2, height - 0.95),
      canopy: isWarehouse ? box(-2.8, 1.2, 7.6, 1.2, 0.6) : box(-3.4, 2.2, 3.6, 1.6, 1.45),
      signage: { ...toWorld(isWarehouse ? -2.8 : -3.4, isWarehouse ? 0.62 : 1.43), y: isWarehouse ? 2.4 : 1.95, heading: rot, w: isWarehouse ? 5.6 : 4.4, h: 0.9 },
      fans: isWarehouse ? [] : [toWorld(-5.0, -4.6), toWorld(-1.8, -4.6)],
      gate,
      bays,
      // Departures pull out downstream of the gate; arrivals stop upstream of it; supply vans use the dock.
      depart: { laneId: frontage.laneId, s: Math.min(frontage.s + 1.6, lane.length - 3.4) },
      arrive: { laneId: frontage.laneId, s: Math.max(frontage.s - 2.8, 2.4) },
      dock: { laneId: frontage.laneId, s: Math.max(frontage.s - 6.4, 2.4) },
      stage: { laneId: feeder, s: network.lanes.get(feeder).length / 2 },
      // Off-road yard paths (world points) between a bay and the ground inside the gate. The simulation
      // adds the kerb approach (traffic.kerbApproach) at the road end.
      exitPath: (bay) => [{ x: bay.x, z: bay.z }, toWorld(bay.local.x, 3.0), toWorld(0.9, 5.4)],
      entryPath: (bay) => [toWorld(0.4, 5.4), toWorld(bay.local.x, 3.4), { ...toWorld(bay.local.x, bay.local.z), reverse: true }],
      queue: Array.from({ length: 18 }, (_, k) => toWorld(-6.0 + (k % 9) * 0.62, 3.6 + Math.floor(k / 9) * 0.7)),
      frontage,
      roadName: roadNameFor(frontage),
      labelY: height + 2.4
    };
  }

  function village(block) {
    const name = areaName(block.zone);
    const slots = [];
    for (const gz of [-5.2, -1.75, 1.75, 5.2]) for (const gx of [-5.2, -1.75, 1.75, 5.2]) slots.push({ gx, gz, used: false });
    const take = (gx, gz) => {
      const s = slots.find((t) => t.gx === gx && t.gz === gz);
      if (s) s.used = true;
    };
    const v = { id: block.zone, name, x: block.cx, z: block.cz, houses: [], hwc: null, asha: ASHAS[block.zone] || [] };
    if (block.zone === 'nallur') {
      // Village temple with a small gopuram and its pond, in the middle of the village.
      for (const [gx, gz] of [[-1.75, -1.75], [1.75, -1.75], [-1.75, 1.75], [1.75, 1.75]]) take(gx, gz);
      landmarks.push({
        id: 'temple',
        kind: 'temple',
        name: 'Pudurnadu village temple',
        zone: block.zone,
        x: block.cx - 1.2,
        z: block.cz + 1.6,
        w: 6.6,
        d: 6.6,
        h: 7,
        labelY: 8.6,
        info: 'Village temple and pond. Festival days bring visitors from nearby villages to PHC Pudurnadu.',
        gopuram: { x: block.cx - 1.2, z: block.cz + 1.6 },
        pond: { x: block.cx + 1.9, z: block.cz - 1.4, w: 2.6, d: 2.6 }
      });
    } else if (block.zone === 'kattur' || block.zone === 'vallam') {
      take(1.75, -1.75);
      v.pond = { x: block.cx + 1.75, z: block.cz - 1.75, r: 1.55 };
    }
    if (HWC_VILLAGES.has(block.zone)) {
      // The sub-centre sits on the slot nearest the busiest edge of the village.
      const slot = slots.find((s) => !s.used && s.gz === 5.2 && s.gx === -1.75) || slots.find((s) => !s.used);
      slot.used = true;
      v.hwc = addBuilding({ kind: 'hwc', name: `HWC ${name}`, zone: block.zone, x: block.cx + slot.gx, z: block.cz + slot.gz, w: 3.3, d: 2.9, h: 1.8 });
    }
    let door = 1;
    for (const s of slots) {
      if (s.used) continue;
      if (rng() < 0.16) {
        trees.push({ x: block.cx + s.gx + range(rng, -0.5, 0.5), z: block.cz + s.gz + range(rng, -0.5, 0.5), kind: rng() < 0.5 ? 'round' : 'palm', scale: range(rng, 0.9, 1.25) });
        if (rng() < 0.5) landmarksExtra.push({ kind: 'haystack', x: block.cx + s.gx + 0.9, z: block.cz + s.gz - 0.8 });
        continue;
      }
      const floors = rng() < 0.72 ? 1 : 2;
      const house = addBuilding({
        kind: 'house',
        name: `No. ${door}, ${name}`,
        zone: block.zone,
        x: block.cx + s.gx + range(rng, -0.35, 0.35),
        z: block.cz + s.gz + range(rng, -0.35, 0.35),
        w: range(rng, 2.3, 2.95),
        d: range(rng, 2.1, 2.7),
        h: floors * 0.9,
        roof: floors === 1 && rng() < 0.5 ? 'tile' : 'flat'
      });
      door += rangeInt(rng, 1, 3);
      v.houses.push(house.id);
    }
    villages.push(v);
  }

  const landmarksExtra = []; // small decorations: haystacks, market stalls
  const arasurHouses = [];

  for (let bj = 0; bj < GRID.nz; bj++) {
    for (let bi = 0; bi < GRID.nx; bi++) {
      const kind = PLAN[bj][bi];
      const zone = AREA_PLAN[bj][bi];
      const cx = (roadX(bi) + roadX(bi + 1)) / 2;
      const cz = (roadZ(bj) + roadZ(bj + 1)) / 2;
      const block = { bi, bj, kind, zone, cx, cz, ground: 'earth' };
      blocks.push(block);

      if (kind.startsWith('centre:')) {
        centres.push(buildCentre(kind.slice(7), block));
        continue;
      }
      switch (kind) {
        case 'village':
          village(block);
          break;
        case 'town:market': {
          block.ground = 'paved';
          for (const side of [-1, 1]) {
            for (let k = 0; k < 4; k++) {
              const owner = ['Murugan', 'Lakshmi', 'Anbu', 'Velan', 'Sakthi', 'Ganesh', 'Selvi', 'Kumar'][k + (side > 0 ? 4 : 0)];
              const trade = pick(rng, ['Stores', 'Medicals', 'Textiles', 'Tea Stall', 'Hardware', 'Bakery', 'Mobiles', 'Fertilisers']);
              // Three fixed medical shops (private pharmacies) for the medicine finder; the rest keep their trade.
              const medical = MEDICAL_SHOPS[owner];
              addBuilding({ kind: 'shop', name: medical || `${owner} ${trade === 'Medicals' ? 'Stores' : trade}`, medical: Boolean(medical), zone, x: cx - 5.1 + k * 3.4, z: cz + side * 5.0, w: 3.1, d: 3.4, h: rangeInt(rng, 1, 2) * 0.9, awning: side > 0 ? 'south' : 'north', awningColor: rangeInt(rng, 0, 3) });
            }
          }
          landmarks.push({ id: 'busstand', kind: 'busstand', name: 'Jamunamarathur bus stand', zone, x: cx - 3.2, z: cz, w: 6, d: 4, h: 2, labelY: 4.2, info: 'Town bus stand. Buses connect the villages to PHC Jamunamarathur every 30 minutes.' });
          for (let k = 0; k < 3; k++) landmarksExtra.push({ kind: 'stall', x: cx + 2.2 + k * 1.7, z: cz + (k % 2 ? 0.8 : -0.8) });
          break;
        }
        case 'town:school': {
          block.ground = 'paved';
          addBuilding({ kind: 'school', name: 'Government Tribal Residential School, Jamunamarathur', zone, x: cx - 2.6, z: cz - 3.4, w: 8.6, d: 3.2, h: 2 * 0.9 });
          landmarks.push({ id: 'school', kind: 'school', name: 'Government Tribal Residential School', zone, x: cx - 2.6, z: cz - 3.4, w: 8.6, d: 3.2, h: 2, labelY: 4.4, info: 'School health screening and adolescent IFA days are run from here with the block PHC team.' });
          let door = 40;
          for (const [gx, gz] of [[4.8, -4.6], [4.8, -0.6], [4.8, 3.4]]) {
            const floors = rng() < 0.5 ? 1 : 2;
            const house = addBuilding({ kind: 'house', name: `No. ${door}, Jamunamarathur`, zone, x: cx + gx, z: cz + gz, w: 2.8, d: 2.6, h: floors * 0.9, roof: floors === 1 ? 'tile' : 'flat' });
            door += 3;
            arasurHouses.push(house.id);
          }
          break;
        }
        case 'lake': {
          landmarks.push({ id: 'lake', kind: 'lake', name: 'Jamunamarathur tank', zone, x: cx, z: cz, w: 14, d: 13, h: 1, labelY: 2.6, info: 'Irrigation tank (eri) for the paddy fields. Water levels rise in the monsoon.', water: { x: cx + 0.2, z: cz - 0.2, rx: 6.2, rz: 5.4 } });
          for (let k = 0; k < 14; k++) {
            const a = (k / 14) * Math.PI * 2;
            trees.push({ x: cx + Math.cos(a) * 7.0, z: cz + Math.sin(a) * 6.3, kind: k % 3 ? 'palm' : 'round', scale: range(rng, 0.8, 1.05) });
          }
          break;
        }
        default:
          fields.push({ cx, cz, kind, bi, bj });
      }
    }
  }
  villages.push({ id: 'arasur', name: areaName('arasur'), x: (roadX(2) + roadX(4)) / 2, z: (roadZ(1) + roadZ(3)) / 2, houses: arasurHouses, hwc: null, asha: ASHAS.arasur });

  // Farmland beyond the simulated grid, out to the horizon.
  const filler = [];
  const EXT = 3;
  for (let bi = -EXT; bi < nx + EXT; bi++) {
    for (let bj = -EXT; bj < nz + EXT; bj++) {
      if (bi >= 0 && bi < nx && bj >= 0 && bj < nz) continue;
      const kind = weighted(rng, [['paddy', 5], ['sugarcane', 1.5], ['grove', 1.6], ['banana', 1], ['fallow', 1], ['farm', 1.2], ['lake', 0.35]]);
      filler.push({ bi, bj, cx: roadX(bi) + PITCH / 2, cz: roadZ(bj) + PITCH / 2, kind });
    }
  }

  // Roadside avenue trees and village street lights along block edges.
  for (const block of blocks) {
    const edges = [
      { x0: block.cx - half, z0: block.cz - half + 0.55, dx: 1, dz: 0, nx: 0, nz: -1 },
      { x0: block.cx - half, z0: block.cz + half - 0.55, dx: 1, dz: 0, nx: 0, nz: 1 },
      { x0: block.cx - half + 0.55, z0: block.cz - half, dx: 0, dz: 1, nx: -1, nz: 0 },
      { x0: block.cx + half - 0.55, z0: block.cz - half, dx: 0, dz: 1, nx: 1, nz: 0 }
    ];
    const settled = block.kind === 'village' || block.kind.startsWith('town') || block.kind.startsWith('centre');
    for (const edge of edges) {
      for (const t of [2.4, 8.0, 13.6]) {
        const x = edge.x0 + edge.dx * t;
        const z = edge.z0 + edge.dz * t;
        if (keepClear.some((k) => Math.hypot(k.x - x, k.z - z) < k.r)) continue;
        if (rng() < (settled ? 0.35 : 0.7)) trees.push({ x, z, kind: settled || rng() < 0.4 ? 'palm' : 'round', scale: range(rng, 0.85, 1.15) });
      }
      if (settled) for (const t of [5.2, 10.8]) lights.push({ x: edge.x0 + edge.dx * t + edge.nx * 0.28, z: edge.z0 + edge.dz * t + edge.nz * 0.28, nx: edge.nx, nz: edge.nz });
    }
  }

  const zoneCentre = (id) => {
    const list = blocks.filter((b) => b.zone === id);
    return { x: list.reduce((s, b) => s + b.cx, 0) / list.length, z: list.reduce((s, b) => s + b.cz, 0) / list.length };
  };
  const zones = [{ id: 'all', name: 'Whole block', x: 0, z: 0 }, ...AREAS.map((a) => ({ ...a, ...zoneCentre(a.id) }))];

  // Junctions in the town get traffic signals and zebra crossings; village junctions are uncontrolled.
  const townNodes = [];
  for (let i = 2; i <= 4; i++) for (let j = 1; j <= 3; j++) townNodes.push(`${i},${j}`);
  const signalNodes = ['2,2', '3,2', '3,1'];

  return { blocks, buildings, centres, landmarks, decorations: landmarksExtra, trees, lights, shelters, fields, filler, villages, zones, townNodes, signalNodes, pitch: PITCH, name: BLOCK_NAME };
}
