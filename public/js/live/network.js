// Road network for the live view: a street grid with one lane each way, left-hand traffic (India),
// junction boxes and turn paths. Pure data and math (no DOM, no Three.js) so it can be unit-tested.
import { clamp } from './util.js';

export const ROAD = 3.6; // carriageway width, two lanes
export const LANE_OFFSET = 0.9; // lane centre from the road centreline
export const BLOCK = 16; // lot size between roads; also the lane length between junction boxes
export const PITCH = BLOCK + ROAD;
export const ZEBRA = 1.0; // zebra crossing depth, just outside each junction box
export const STOP_GAP = ZEBRA + 0.3; // vehicles stop this far before the junction box
export const FOOTPATH = 1.2;
export const MAX_HALF_WIDTH = 0.5; // widest lane vehicle (bus, van, ambulance) is 1.0 wide
export const METERS_PER_UNIT = 40; // map scale used for distances shown to people

const nodeId = (i, j) => `${i},${j}`;

function quadratic(p0, c, p2, t) {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, z: u * u * p0.z + 2 * u * t * c.z + t * t * p2.z };
}

/** Arc-length parameterised path through points (a polyline approximation of a curve). */
function makePath(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  const length = cumulative[cumulative.length - 1];
  return {
    length,
    sample(s) {
      const d = clamp(s, 0, length);
      let i = 1;
      while (i < cumulative.length - 1 && cumulative[i] < d) i++;
      const a = points[i - 1];
      const b = points[i];
      const seg = cumulative[i] - cumulative[i - 1] || 1;
      const t = (d - cumulative[i - 1]) / seg;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading: Math.atan2(b.x - a.x, b.z - a.z) };
    }
  };
}

export function createNetwork({ nx, nz }) {
  const halfW = (nx * PITCH) / 2;
  const halfD = (nz * PITCH) / 2;
  const roadX = (i) => -halfW + i * PITCH;
  const roadZ = (j) => -halfD + j * PITCH;
  const nodes = new Map();
  const lanes = new Map();
  const H = ROAD / 2;

  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      nodes.set(nodeId(i, j), { id: nodeId(i, j), i, j, x: roadX(i), z: roadZ(j), in: [], out: [], box: [], reserved: [], signal: null });
    }
  }

  for (const a of nodes.values()) {
    for (const [di, dj] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const b = nodes.get(nodeId(a.i + di, a.j + dj));
      if (!b) continue;
      const dir = { x: di, z: dj };
      // Left of the direction of travel; with left-hand traffic the kerb is on this side.
      const left = { x: dir.z, z: -dir.x };
      const lane = {
        id: `${a.id}>${b.id}`,
        from: a.id,
        to: b.id,
        dir,
        left,
        start: { x: a.x + dir.x * H + left.x * LANE_OFFSET, z: a.z + dir.z * H + left.z * LANE_OFFSET },
        end: { x: b.x - dir.x * H + left.x * LANE_OFFSET, z: b.z - dir.z * H + left.z * LANE_OFFSET },
        length: BLOCK,
        heading: Math.atan2(dir.x, dir.z),
        // Horizontal roads are indexed by j, vertical roads by i.
        road: dj === 0 ? { axis: 'h', index: a.j } : { axis: 'v', index: a.i },
        vehicles: [], // ordered front (largest s) to back
        curb: [] // kerbside stops: { s, length, owner }
      };
      lanes.set(lane.id, lane);
      a.out.push(lane.id);
      b.in.push(lane.id);
    }
  }

  const movements = new Map();
  /** Path through the junction box from the end of lane `inId` to the start of lane `outId`. */
  function movement(inId, outId) {
    const key = `${inId}|${outId}`;
    const cached = movements.get(key);
    if (cached) return cached;
    const a = lanes.get(inId);
    const b = lanes.get(outId);
    if (!a || !b || a.to !== b.from || b.to === a.from) throw new Error(`No movement from ${inId} to ${outId}`);
    const p0 = a.end;
    const p2 = b.start;
    let kind = 'straight';
    let points = [p0, p2];
    if (a.dir.x !== b.dir.x || a.dir.z !== b.dir.z) {
      kind = b.dir.x === a.left.x && b.dir.z === a.left.z ? 'left' : 'right';
      const t = (p2.x - p0.x) * a.dir.x + (p2.z - p0.z) * a.dir.z;
      const c = { x: p0.x + a.dir.x * t, z: p0.z + a.dir.z * t };
      points = [];
      const steps = kind === 'left' ? 10 : 14;
      for (let k = 0; k <= steps; k++) points.push(quadratic(p0, c, p2, k / steps));
    }
    const path = makePath(points);
    const m = { key, from: inId, to: outId, node: a.to, kind, length: path.length, sample: path.sample, points };
    movements.set(key, m);
    return m;
  }

  /** Lanes a vehicle may take after `laneId` (no U-turns). */
  function successors(laneId) {
    const lane = lanes.get(laneId);
    return nodes.get(lane.to).out.filter((id) => lanes.get(id).to !== lane.from);
  }

  /** Shortest lane sequence after `fromId` that ends with `toId` (breadth first; all lanes are equal length). */
  function route(fromId, toId) {
    const prev = new Map();
    const queue = [];
    for (const next of successors(fromId)) {
      prev.set(next, null);
      queue.push(next);
    }
    while (queue.length) {
      const current = queue.shift();
      if (current === toId) {
        const path = [];
        for (let c = current; c; c = prev.get(c)) path.unshift(c);
        return path;
      }
      for (const next of successors(current)) {
        if (!prev.has(next)) {
          prev.set(next, current);
          queue.push(next);
        }
      }
    }
    return null;
  }

  function pointOnLane(lane, s, lateral = 0) {
    return {
      x: lane.start.x + lane.dir.x * s + lane.left.x * lateral,
      z: lane.start.z + lane.dir.z * s + lane.left.z * lateral
    };
  }

  /** Lane whose kerb faces the point (x, z), and the distance along it. Used for kerbside stops. */
  function frontage(x, z) {
    let best = null;
    for (const lane of lanes.values()) {
      const rx = x - lane.start.x;
      const rz = z - lane.start.z;
      const along = rx * lane.dir.x + rz * lane.dir.z;
      const lateral = rx * lane.left.x + rz * lane.left.z;
      if (along < 0 || along > lane.length || lateral <= 0) continue;
      if (!best || lateral < best.lateral) best = { laneId: lane.id, s: clamp(along, 3, lane.length - 4.5), lateral };
    }
    return best;
  }

  return { nx, nz, halfW, halfD, roadX, roadZ, nodes, lanes, movement, successors, route, pointOnLane, frontage, nodeId };
}
