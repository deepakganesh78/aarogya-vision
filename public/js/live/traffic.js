// Traffic for the live view: car-following on lanes, split-phase signals that respond to waiting vehicles
// and give ambulances priority, junction-box reservations so crossing movements never share the box, and
// kerbside stops. Pure logic (no DOM, no Three.js): the scene only reads each vehicle's x, z and heading.
import { MAX_HALF_WIDTH, ROAD, STOP_GAP } from './network.js';
import { angleDelta, clamp, polylineLength, samplePolyline, weighted } from './util.js';

export const VEHICLE_TYPES = {
  car: { length: 1.9, width: 0.95, vmax: 5.4, accel: 3.6, decel: 9 },
  auto: { length: 1.4, width: 0.85, vmax: 4.4, accel: 3.0, decel: 9 },
  bus: { length: 3.4, width: 1.0, vmax: 3.9, accel: 2.2, decel: 7 },
  scooter: { length: 0.95, width: 0.36, vmax: 5.2, accel: 4.5, decel: 10 },
  ambulance: { length: 2.2, width: 1.0, vmax: 6.4, accel: 4.0, decel: 9 },
  van: { length: 2.1, width: 1.0, vmax: 4.8, accel: 3.0, decel: 8 },
  tractor: { length: 2.6, width: 1.0, vmax: 3.0, accel: 2.0, decel: 7 },
  cart: { length: 2.4, width: 0.95, vmax: 1.7, accel: 1.2, decel: 6 }
};

export const MIN_GAP = 0.55;
export const SIGNAL_TIMING = { green: 5, minGreen: 1.6, amber: 1.4, allRed: 1.0 };
const COMMIT_DISTANCE = 4.5;
const TURN_SPEED = { straight: Infinity, left: 2.6, right: 3.2 };
const PULL_TIME = 0.6;
const PATH_SPEED = 2.6;

const ease = (t) => t * t * (3 - 2 * t);

export function createTraffic(network, { rng, signalNodes = null }) {
  const { lanes, nodes } = network;
  const vehicles = [];
  let speedFactor = 1;
  let frame = 0;
  let nextId = 1;
  let time = 0;
  const signalled = signalNodes ? new Set(signalNodes) : null;

  for (const node of nodes.values()) {
    if (node.in.length < 3 || (signalled && !signalled.has(node.id))) continue;
    const approaches = [...node.in].sort((a, b) => lanes.get(a).heading - lanes.get(b).heading);
    node.signal = {
      approaches,
      index: Math.floor(rng() * approaches.length),
      stage: 'green',
      timer: SIGNAL_TIMING.green * rng(),
      elapsed: SIGNAL_TIMING.minGreen,
      preempt: null
    };
  }

  function signalState(node, laneId) {
    const sig = node.signal;
    if (!sig) return 'green';
    if (sig.approaches[sig.index] !== laneId) return 'red';
    if (sig.stage === 'green') return 'green';
    return sig.stage === 'amber' ? 'amber' : 'red';
  }

  /** A vehicle is waiting (or about to wait) at this approach's stop line. */
  function demand(laneId, within = 10) {
    const lane = lanes.get(laneId);
    const front = lane.vehicles[0];
    return Boolean(front && !front.committed && lane.length - front.s < within + STOP_GAP + front.length);
  }

  function updateSignal(node, dt) {
    const sig = node.signal;
    sig.timer -= dt;
    sig.elapsed += dt;
    const current = sig.approaches[sig.index];
    const toAmber = () => {
      sig.stage = 'amber';
      sig.timer = SIGNAL_TIMING.amber;
    };
    if (sig.stage === 'green') {
      const others = sig.approaches.some((id) => id !== current && demand(id));
      const preempting = sig.preempt && sig.preempt !== current;
      if (preempting && sig.elapsed >= 1) toAmber();
      else if (sig.elapsed >= SIGNAL_TIMING.minGreen && others && !demand(current, 14)) toAmber();
      else if (sig.timer <= 0) {
        if (others || preempting) toAmber();
        else sig.timer = 1; // rest in green while nobody else is waiting
      }
      if (sig.preempt === current) sig.preempt = null;
      return;
    }
    if (sig.timer > 0) return;
    if (sig.stage === 'amber') {
      sig.stage = 'allred';
      sig.timer = SIGNAL_TIMING.allRed;
      return;
    }
    const n = sig.approaches.length;
    let next = (sig.index + 1) % n;
    if (sig.preempt) {
      next = sig.approaches.indexOf(sig.preempt);
      sig.preempt = null;
    } else {
      for (let k = 0; k < n; k++) {
        const idx = (sig.index + 1 + k) % n;
        if (demand(sig.approaches[idx], 16)) {
          next = idx;
          break;
        }
      }
    }
    sig.index = next;
    sig.stage = 'green';
    sig.timer = SIGNAL_TIMING.green;
    sig.elapsed = 0;
  }

  // ---- Vehicles -------------------------------------------------------------------------------

  function makeVehicle(kind, extra = {}) {
    const type = VEHICLE_TYPES[kind];
    if (!type) throw new Error(`Unknown vehicle kind ${kind}`);
    const v = {
      id: `v${nextId++}`,
      kind,
      ...type,
      fleet: false,
      emergency: false,
      mode: 'parked',
      lane: null,
      s: 0,
      lateral: 0,
      pull: null,
      move: null,
      boxS: 0,
      boxNode: null,
      boxFrom: null,
      boxKind: null,
      nextLane: null,
      committed: false,
      clearing: null,
      waitStart: null,
      route: [],
      target: null,
      arrivedAt: null,
      curbSpot: null,
      speed: 0,
      x: 0,
      z: 0,
      heading: 0,
      odometer: 0,
      tasks: [],
      task: null,
      stepped: -1,
      ...extra
    };
    vehicles.push(v);
    return v;
  }

  function insertByS(lane, v) {
    let i = 0;
    while (i < lane.vehicles.length && lane.vehicles[i].s > v.s) i++;
    lane.vehicles.splice(i, 0, v);
  }

  function laneHasRoom(lane, s, length) {
    return (
      s > length / 2 + 0.5 &&
      s < lane.length - STOP_GAP - length / 2 - 0.5 &&
      lane.vehicles.every((o) => Math.abs(o.s - s) >= (o.length + length) / 2 + MIN_GAP + 1)
    );
  }

  /** Place a free-roaming vehicle on a lane, if there is room. */
  function spawnOnLane(kind, laneId, s, extra = {}) {
    const lane = lanes.get(laneId);
    const length = VEHICLE_TYPES[kind].length;
    if (!laneHasRoom(lane, s, length)) return null;
    const v = makeVehicle(kind, extra);
    v.mode = 'drive';
    v.lane = lane;
    v.s = s;
    insertByS(lane, v);
    updatePose(v);
    return v;
  }

  /** A fleet vehicle parked off the road (a bay at its base). */
  function addParked(kind, pose, extra = {}) {
    const v = makeVehicle(kind, { fleet: true, ...extra });
    v.mode = 'parked';
    v.x = pose.x;
    v.z = pose.z;
    v.heading = pose.heading;
    return v;
  }

  // ---- Kerbside stops -------------------------------------------------------------------------

  const curbOffset = (v) => MAX_HALF_WIDTH + v.width / 2 + 0.08;

  function curbPose(laneId, s, v) {
    const lane = lanes.get(laneId);
    const p = network.pointOnLane(lane, s, curbOffset(v));
    return { x: p.x, z: p.z, heading: lane.heading };
  }

  /**
   * Off-road points between a kerb spot and the footpath. Turning happens only far enough from the lane
   * that the vehicle's whole turning sweep stays clear of traffic; the stretch next to the kerb is a slide
   * parallel to the lane. Arriving: footpath -> turn -> kerb (upstream of the spot). Leaving: kerb -> turn
   * -> footpath (downstream of the spot).
   */
  function kerbApproach(spot, v, { leaving = false } = {}) {
    const lane = lanes.get(spot.laneId);
    const kerb = curbPose(spot.laneId, spot.s, v);
    const clear = Math.hypot(v.length / 2, v.width / 2) + MAX_HALF_WIDTH + 0.12;
    const out = clear - curbOffset(v);
    const sign = leaving ? 1 : -1;
    const turn = { x: kerb.x + lane.dir.x * 0.7 * sign + lane.left.x * out, z: kerb.z + lane.dir.z * 0.7 * sign + lane.left.z * out };
    const footpath = { x: turn.x + lane.dir.x * 1.2 * sign, z: turn.z + lane.dir.z * 1.2 * sign };
    return { footpath, turn, kerb, heading: lane.heading };
  }

  function curbFree(lane, s, length, owner) {
    return lane.curb.every((c) => c.owner === owner || Math.abs(c.s - s) >= (c.length + length) / 2 + 0.35);
  }

  /** Reserve a kerbside stop near s on a lane, or exactly at s. Returns a spot or null. */
  function reserveCurb(laneId, s, v, { exact = false } = {}) {
    const lane = lanes.get(laneId);
    const lo = v.length / 2 + 1.2;
    const hi = lane.length - STOP_GAP - v.length / 2 - 0.8;
    const offsets = exact ? [0] : [0, 1.3, -1.3, 2.6, -2.6, 3.9, -3.9, 5.2, -5.2];
    for (const d of offsets) {
      const cs = clamp(s + d, lo, hi);
      if (!curbFree(lane, cs, v.length, v)) continue;
      const reservation = { s: cs, length: v.length, owner: v };
      lane.curb.push(reservation);
      return { laneId, s: cs, reservation };
    }
    return null;
  }

  function releaseCurb(spot) {
    if (!spot) return;
    const lane = lanes.get(spot.laneId);
    const i = lane.curb.indexOf(spot.reservation);
    if (i >= 0) lane.curb.splice(i, 1);
  }

  function computeRoute(laneId, s, target) {
    if (target.laneId === laneId && target.s > s + 0.5) return [];
    return network.route(laneId, target.laneId) || [];
  }

  /** Leave the kerb when the lane is clear enough for following traffic to stop. */
  function tryMerge(v) {
    const lane = v.lane;
    const s = v.s;
    for (const o of lane.vehicles) {
      if (o.s >= s) {
        if (o.s - o.length / 2 - (s + v.length / 2) < MIN_GAP + 0.4) return false;
      } else {
        const gap = s - v.length / 2 - (o.s + o.length / 2);
        const braking = (o.speed * o.speed) / (2 * o.decel);
        if (gap < MIN_GAP + braking + 0.8) return false;
      }
    }
    if (s < 9) {
      const upstream = nodes.get(lane.from);
      if (upstream.reserved.some((o) => o.nextLane === lane.id)) return false;
    }
    v.mode = 'drive';
    v.speed = 0;
    v.pull = { dir: 'in', t: 0 };
    insertByS(lane, v);
    return true;
  }

  // ---- Tasks (fleet vehicles) -----------------------------------------------------------------
  // { type: 'until', test } | { type: 'wait', seconds } | { type: 'call', fn }
  // { type: 'path', points, end }  off-road move (bay <-> kerb). points may set `reverse` for the segment
  //   ending there; end is { spot } (stop at a reserved kerb spot) or 'parked'. Both may be functions of v.
  // { type: 'drive', target: spot | () => spot, onMerged, skip }  kerb -> kerb along the road network;
  //   skip(v) returning true ends the task before it starts (already there)

  function assign(v, tasks) {
    v.tasks.push(...tasks);
  }

  function startTask(v, task) {
    if (task.type === 'wait') task.left = task.seconds;
    if (task.type === 'path') {
      v.mode = 'path';
      v.speed = PATH_SPEED;
      v.pathPts = typeof task.points === 'function' ? task.points(v) : task.points;
      v.pathLen = polylineLength(v.pathPts);
      v.pathS = 0;
      task.endSpot = typeof task.end === 'function' ? task.end(v) : task.end;
    }
    if (task.type === 'drive') task.phase = 'reserve';
  }

  function tickTask(v, task, dt) {
    switch (task.type) {
      case 'call':
        task.fn(v);
        return true;
      case 'until':
        return Boolean(task.test(v));
      case 'wait':
        task.left -= dt;
        return task.left <= 0;
      case 'path':
        v.pathS += PATH_SPEED * dt;
        if (v.pathS < v.pathLen) return false;
        if (task.endSpot?.spot) {
          v.mode = 'curb';
          v.lane = lanes.get(task.endSpot.spot.laneId);
          v.s = task.endSpot.spot.s;
          v.curbSpot = task.endSpot.spot;
        } else {
          v.mode = 'parked';
          releaseCurb(v.curbSpot);
          v.curbSpot = null;
          v.lane = null;
        }
        v.speed = 0;
        return true;
      case 'drive':
        if (task.phase === 'reserve') {
          if (task.skip?.(v)) return true;
          const spot = typeof task.target === 'function' ? task.target(v) : task.target;
          if (!spot) return false;
          task.spot = spot;
          v.target = spot;
          v.route = computeRoute(v.lane.id, v.s, spot);
          task.phase = 'merge';
        }
        if (task.phase === 'merge') {
          if (tryMerge(v)) task.phase = 'merging';
          return false;
        }
        if (task.phase === 'merging') {
          if (!v.pull) {
            task.phase = 'driving';
            task.onMerged?.(v);
          }
          return false;
        }
        return v.mode === 'curb' && v.arrivedAt === task.spot;
      default:
        throw new Error(`Unknown task ${task.type}`);
    }
  }

  function runTasks(v, dt) {
    let budget = dt;
    for (let guard = 0; guard < 16; guard++) {
      if (!v.task) {
        v.task = v.tasks.shift() || null;
        if (!v.task) return;
        startTask(v, v.task);
      }
      if (!tickTask(v, v.task, budget)) return;
      const finished = v.task;
      v.task = null;
      finished.done?.(v);
      budget = 0;
    }
  }

  // ---- Movement -------------------------------------------------------------------------------

  /** Distance the vehicle may cover this step, never past `limit` (the leader's tail or a stop line). */
  function advance(v, limit, dt, cap) {
    const room = Math.max(0, limit);
    const vmax = Math.min(v.vmax * speedFactor, cap);
    const safe = Math.sqrt(2 * v.decel * room * 0.9);
    const target = Math.min(vmax, safe);
    if (v.speed < target) v.speed = Math.min(target, v.speed + v.accel * dt);
    else v.speed = Math.max(target, v.speed - v.decel * 2 * dt);
    let ds = v.speed * dt;
    if (ds > room) {
      ds = room;
      v.speed = dt > 0 ? Math.min(v.speed, room / dt) : 0;
    }
    v.odometer += ds;
    return ds;
  }

  function chooseNext(v, lane) {
    if (v.route.length) return v.route[0];
    const options = network.successors(lane.id).map((id) => {
      const kind = network.movement(lane.id, id).kind;
      return [id, kind === 'straight' ? 5 : kind === 'left' ? 3 : 2];
    });
    return weighted(rng, options);
  }

  /** Enter the junction box only on green, when no other approach holds the box, and the exit has room. */
  function canCommit(v, lane, node) {
    if (signalState(node, lane.id) !== 'green') return false;
    // Follow a vehicle from the same approach into the box only when it goes straight. A turning leader
    // (above all a long, slow one) sweeps the corner, so wait until its rear has cleared.
    for (const o of node.reserved) if (o.boxFrom !== lane.id || o.boxKind !== 'straight') return false;
    if (!node.signal) {
      // Uncontrolled junction: first come, first served. Yield to anyone who has waited longer.
      for (const id of node.in) {
        if (id === lane.id) continue;
        const front = lanes.get(id).vehicles[0];
        if (front && !front.committed && front.waitStart !== null && (v.waitStart === null || front.waitStart < v.waitStart)) return false;
      }
    }
    const out = lanes.get(v.nextLane);
    const tail = out.vehicles[out.vehicles.length - 1];
    let free = tail ? tail.s - tail.length / 2 : out.length;
    for (const o of node.reserved) if (o.nextLane === out.id) free -= o.length + MIN_GAP;
    return free >= v.length + MIN_GAP + 0.8;
  }

  function releaseReservation(node, v) {
    const i = node.reserved.indexOf(v);
    if (i >= 0) node.reserved.splice(i, 1);
  }

  /** Returns true when the vehicle left this lane's list. */
  function updateDrive(v, lane, idx, dt) {
    if (v.stepped === frame) return false;
    v.stepped = frame;
    if (v.clearing && v.s >= v.length / 2 + 0.3) {
      releaseReservation(v.clearing, v);
      v.clearing = null;
      v.boxFrom = null;
      v.boxKind = null;
    }
    if (v.pull) {
      v.pull.t = Math.min(1, v.pull.t + dt / PULL_TIME);
      const e = ease(v.pull.t);
      v.lateral = curbOffset(v) * (v.pull.dir === 'out' ? e : 1 - e);
      v.speed = 0;
      if (v.pull.t < 1) return false;
      const dir = v.pull.dir;
      v.pull = null;
      if (dir === 'out') {
        lane.vehicles.splice(idx, 1);
        v.mode = 'curb';
        v.curbSpot = v.target;
        v.arrivedAt = v.target;
        v.target = null;
        v.lateral = 0;
        return true;
      }
      v.lateral = 0;
      releaseCurb(v.curbSpot);
      v.curbSpot = null;
      return false;
    }

    let limit = Infinity;
    if (idx > 0) {
      const lead = lane.vehicles[idx - 1];
      limit = lead.s - lead.length / 2 - v.s - v.length / 2 - MIN_GAP;
    }
    const stopHere = Boolean(v.target && v.target.laneId === lane.id && v.route.length === 0);
    if (stopHere) {
      limit = Math.min(limit, v.target.s - v.s);
      if (v.target.s - v.s < 0.04 && v.speed < 0.2) {
        v.speed = 0;
        v.pull = { dir: 'out', t: 0 };
        return false;
      }
    } else {
      const node = nodes.get(lane.to);
      if (!v.nextLane) v.nextLane = chooseNext(v, lane);
      for (let k = node.box.length - 1; k >= 0; k--) {
        const o = node.box[k];
        if (o.boxFrom === lane.id) {
          limit = Math.min(limit, lane.length + o.boxS - o.length / 2 - v.s - v.length / 2 - MIN_GAP);
          break;
        }
      }
      if (idx === 0 && !v.committed) {
        const stopAt = lane.length - STOP_GAP - v.length / 2;
        if (v.emergency && node.signal && signalState(node, lane.id) !== 'green' && stopAt - v.s < 18) {
          node.signal.preempt = node.signal.preempt || lane.id;
        }
        if (stopAt - v.s < 0.4 && v.speed < 0.15 && v.waitStart === null) v.waitStart = time;
        if (stopAt - v.s <= COMMIT_DISTANCE && canCommit(v, lane, node)) {
          v.committed = true;
          v.waitStart = null;
          v.boxFrom = lane.id;
          v.boxKind = network.movement(lane.id, v.nextLane).kind;
          node.reserved.push(v);
        }
        if (!v.committed) limit = Math.min(limit, stopAt - v.s);
      }
    }
    v.s += advance(v, limit, dt, Infinity);
    if (!stopHere && v.committed && v.s >= lane.length) {
      lane.vehicles.splice(idx, 1);
      const node = nodes.get(lane.to);
      v.mode = 'box';
      v.boxNode = node;
      v.move = network.movement(lane.id, v.nextLane);
      v.boxS = v.s - lane.length;
      v.lane = null;
      node.box.push(v);
      return true;
    }
    return false;
  }

  /** Returns true when the vehicle left the junction box. */
  function updateBox(v, node, idx, dt) {
    if (v.stepped === frame) return false;
    v.stepped = frame;
    let limit = Infinity;
    const sin = Math.sin(v.heading);
    const cos = Math.cos(v.heading);
    for (let k = 0; k < idx; k++) {
      const o = node.box[k];
      const dx = o.x - v.x;
      const dz = o.z - v.z;
      const ahead = dx * sin + dz * cos;
      const lateral = Math.abs(dx * cos - dz * sin);
      if (ahead <= 0 || lateral > (o.width + v.width) / 2 + 0.2) continue;
      limit = Math.min(limit, ahead - (o.length + v.length) / 2 - MIN_GAP);
    }
    const out = lanes.get(v.nextLane);
    const tail = out.vehicles[out.vehicles.length - 1];
    if (tail) limit = Math.min(limit, v.move.length - v.boxS + tail.s - tail.length / 2 - v.length / 2 - MIN_GAP);
    v.boxS += advance(v, limit, dt, TURN_SPEED[v.move.kind]);
    if (v.boxS < v.move.length) return false;
    node.box.splice(idx, 1);
    v.mode = 'drive';
    v.lane = out;
    v.s = v.boxS - v.move.length;
    out.vehicles.push(v);
    v.clearing = node;
    v.committed = false;
    v.move = null;
    v.boxNode = null;
    if (v.route.length && v.route[0] === out.id) v.route.shift();
    v.nextLane = null;
    return true;
  }

  function updatePose(v, dt = 0) {
    switch (v.mode) {
      case 'drive': {
        const p = network.pointOnLane(v.lane, v.s, v.lateral);
        v.x = p.x;
        v.z = p.z;
        let h = v.lane.heading;
        if (v.pull) h += Math.sin(Math.PI * v.pull.t) * 0.35 * (v.pull.dir === 'out' ? 1 : -1);
        v.heading = h;
        break;
      }
      case 'box': {
        const p = v.move.sample(v.boxS);
        v.x = p.x;
        v.z = p.z;
        v.heading = p.heading;
        break;
      }
      case 'curb': {
        const p = network.pointOnLane(v.lane, v.s, curbOffset(v));
        v.x = p.x;
        v.z = p.z;
        v.heading = v.lane.heading;
        break;
      }
      case 'path': {
        const p = samplePolyline(v.pathPts, v.pathS);
        v.x = p.x;
        v.z = p.z;
        if (p.heading !== null) {
          // A point may fix the heading of the segment ending there (sliding to or from the kerb), or
          // mark it as driven in reverse (backing into a bay).
          const point = v.pathPts[p.index];
          const want = point?.heading ?? (point?.reverse ? p.heading + Math.PI : p.heading);
          v.heading += angleDelta(v.heading, want) * Math.min(1, dt * 9);
        }
        break;
      }
      default:
        break;
    }
  }

  function step(dt) {
    frame += 1;
    time += dt;
    for (const node of nodes.values()) if (node.signal) updateSignal(node, dt);
    for (const v of vehicles) if (v.task || v.tasks.length) runTasks(v, dt);
    for (const lane of lanes.values()) {
      for (let i = 0; i < lane.vehicles.length; i++) {
        if (updateDrive(lane.vehicles[i], lane, i, dt)) i--;
      }
    }
    for (const node of nodes.values()) {
      for (let i = 0; i < node.box.length; i++) {
        if (updateBox(node.box[i], node, i, dt)) i--;
      }
    }
    for (const v of vehicles) updatePose(v, dt);
  }

  /** Road distance left to the vehicle's kerbside target, in map units (null when not heading anywhere). */
  function remainingDistance(v) {
    const target = v.target || (v.task?.type === 'drive' ? v.task.spot : null);
    if (!target) return null;
    let d = 0;
    if (v.mode === 'drive' || v.mode === 'curb') {
      if (v.route.length === 0 && v.lane.id === target.laneId && target.s >= v.s) return target.s - v.s;
      d += v.lane.length - v.s;
    } else if (v.mode === 'box') {
      d += v.move.length - v.boxS;
    } else {
      return null;
    }
    v.route.forEach((id, k) => {
      d += ROAD;
      d += k === v.route.length - 1 ? target.s : lanes.get(id).length;
    });
    return d;
  }

  /** Points along the vehicle's remaining route, for drawing the planned path. */
  function routePoints(v, spacing = 0.9) {
    const target = v.target || (v.task?.type === 'drive' ? v.task.spot : null);
    if (!target || !['drive', 'box', 'curb'].includes(v.mode)) return [];
    const pts = [];
    const along = (lane, from, to) => {
      for (let s = from; s < to; s += spacing) pts.push(network.pointOnLane(lane, s));
      pts.push(network.pointOnLane(lane, to));
    };
    let prev = null;
    if (v.mode === 'box') {
      for (let s = v.boxS; s < v.move.length; s += spacing) pts.push(v.move.sample(s));
    } else {
      const lastLane = v.route.length === 0 && v.lane.id === target.laneId;
      along(v.lane, v.s, lastLane ? target.s : v.lane.length);
      prev = v.lane.id;
    }
    v.route.forEach((id, k) => {
      if (prev) for (const p of network.movement(prev, id).points) pts.push(p);
      along(lanes.get(id), 0, k === v.route.length - 1 ? target.s : lanes.get(id).length);
      prev = id;
    });
    const kerb = curbPose(target.laneId, target.s, v);
    pts.push({ x: kerb.x, z: kerb.z });
    return pts;
  }

  return {
    vehicles,
    step,
    spawnOnLane,
    addParked,
    assign,
    reserveCurb,
    releaseCurb,
    curbPose,
    kerbApproach,
    signalState,
    remainingDistance,
    routePoints,
    setSpeedFactor(f) {
      speedFactor = f;
    },
    get speedFactor() {
      return speedFactor;
    }
  };
}

/** Pairs of vehicles whose footprints (oriented rectangles) intersect. Used by tests and debug checks. */
export function findOverlaps(vehicles, { shrink = 0.02 } = {}) {
  const corners = (v) => {
    const s = Math.sin(v.heading);
    const c = Math.cos(v.heading);
    const hl = v.length / 2 - shrink;
    const hw = v.width / 2 - shrink;
    return [
      [v.x + s * hl + c * hw, v.z + c * hl - s * hw],
      [v.x + s * hl - c * hw, v.z + c * hl + s * hw],
      [v.x - s * hl - c * hw, v.z - c * hl + s * hw],
      [v.x - s * hl + c * hw, v.z - c * hl - s * hw]
    ];
  };
  const separated = (a, b) => {
    for (const poly of [a, b]) {
      for (let i = 0; i < 4; i++) {
        const [x1, z1] = poly[i];
        const [x2, z2] = poly[(i + 1) % 4];
        const nx = z2 - z1;
        const nz = x1 - x2;
        let minA = Infinity;
        let maxA = -Infinity;
        let minB = Infinity;
        let maxB = -Infinity;
        for (const [x, z] of a) {
          const p = x * nx + z * nz;
          minA = Math.min(minA, p);
          maxA = Math.max(maxA, p);
        }
        for (const [x, z] of b) {
          const p = x * nx + z * nz;
          minB = Math.min(minB, p);
          maxB = Math.max(maxB, p);
        }
        if (maxA < minB || maxB < minA) return true;
      }
    }
    return false;
  };
  const hits = [];
  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      const a = vehicles[i];
      const b = vehicles[j];
      if (Math.abs(a.x - b.x) > 4 || Math.abs(a.z - b.z) > 4) continue;
      if (!separated(corners(a), corners(b))) hits.push([a, b]);
    }
  }
  return hits;
}
