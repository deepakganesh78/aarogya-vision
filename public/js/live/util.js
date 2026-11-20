// Small deterministic helpers for the live view. No DOM and no Three.js, so they run in Node tests too.

/** Seeded pseudo-random generator (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential approach towards a target. */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

export const pick = (rng, list) => list[Math.floor(rng() * list.length)];
export const rangeInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
export const range = (rng, lo, hi) => lo + rng() * (hi - lo);

/** Pick from [[value, weight], ...]. */
export function weighted(rng, entries) {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

/** Poisson-distributed count for a small expected value (Knuth). */
export function poisson(rng, mean) {
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let k = 0;
  let p = rng();
  while (p > limit) {
    k += 1;
    p *= rng();
  }
  return k;
}

/** Shortest signed angle from a to b, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return total;
}

/** Point along a polyline [{x, z}, ...] at distance s, with heading (radians, 0 = +z) and segment index. */
export function samplePolyline(points, s) {
  let remaining = Math.max(0, s);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (remaining <= seg || i === points.length - 1) {
      const t = seg > 0 ? clamp(remaining / seg, 0, 1) : 1;
      return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), heading: seg > 0 ? Math.atan2(b.x - a.x, b.z - a.z) : null, index: i };
    }
    remaining -= seg;
  }
  const last = points[points.length - 1];
  return { x: last.x, z: last.z, heading: null, index: points.length - 1 };
}
