// Builds merged, flat-shaded, vertex-coloured geometry for the live view's clay look. Merging the static
// world into a few meshes keeps draw calls low enough for mid-range phones.
import { BufferGeometry, Color, Float32BufferAttribute } from '/vendor/three.js';

const cache = new Map();
/** Shared THREE.Color for a hex string (converted to the linear working colour space). */
export function color(hex) {
  let c = cache.get(hex);
  if (!c) {
    c = new Color(hex);
    cache.set(hex, c);
  }
  return c;
}

export function shade(c, k) {
  return new Color(c.r * k, c.g * k, c.b * k);
}

const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => {
    const l = Math.hypot(...p);
    return p.map((x) => x / l);
  });
  const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  return { v, f };
})();

export class GeoBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.colors = [];
  }

  get empty() {
    return this.positions.length === 0;
  }

  /** Triangle with a flat normal. If `outward` is given, the winding is flipped to face it. */
  tri(a, b, c, ca, cb = ca, cc = ca, outward = null) {
    let ux = b[0] - a[0];
    let uy = b[1] - a[1];
    let uz = b[2] - a[2];
    let vx = c[0] - a[0];
    let vy = c[1] - a[1];
    let vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    if (outward && nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) {
      [b, c] = [c, b];
      [cb, cc] = [cc, cb];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.colors.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
  }

  quad(a, b, c, d, ca, cb = ca, cc = ca, cd = ca, outward = null) {
    this.tri(a, b, c, ca, cb, cc, outward);
    this.tri(a, c, d, ca, cc, cd, outward);
  }

  /** Axis-aligned (or Y-rotated) box standing on y. Bottom edges are darkened for a soft contact shadow. */
  box(cx, y, cz, w, h, d, col, { rotY = 0, top = col, ao = 0.84, bottom = false, faces = 'all' } = {}) {
    const hw = w / 2;
    const hd = d / 2;
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const P = (lx, ly, lz) => [cx + lx * c + lz * s, y + ly, cz - lx * s + lz * c];
    const v = [P(-hw, 0, -hd), P(hw, 0, -hd), P(hw, 0, hd), P(-hw, 0, hd), P(-hw, h, -hd), P(hw, h, -hd), P(hw, h, hd), P(-hw, h, hd)];
    const lo = shade(col, ao);
    if (faces === 'all' || faces === 'top') this.quad(v[4], v[7], v[6], v[5], top);
    if (faces === 'all') {
      this.quad(v[3], v[2], v[6], v[7], lo, lo, col, col);
      this.quad(v[1], v[0], v[4], v[5], lo, lo, col, col);
      this.quad(v[2], v[1], v[5], v[6], lo, lo, col, col);
      this.quad(v[0], v[3], v[7], v[4], lo, lo, col, col);
    }
    if (bottom) this.quad(v[0], v[1], v[2], v[3], lo);
  }

  /** Box between two points along the ground (for walls, rails, arms). */
  beam(x0, z0, x1, z1, y, thickness, h, col, opts = {}) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    this.box((x0 + x1) / 2, y, (z0 + z1) / 2, thickness, h, len, col, { ...opts, rotY: Math.atan2(x1 - x0, z1 - z0) });
  }

  /** N-sided prism or frustum (cylinders, cones, tanks). */
  prism(cx, y, cz, rBottom, rTop, h, sides, col, { top = col, ao = 0.86, cap = true, start = 0 } = {}) {
    const lo = shade(col, ao);
    const ring = (r, yy) => Array.from({ length: sides }, (_, i) => {
      const a = start + (i / sides) * Math.PI * 2;
      return [cx + Math.cos(a) * r, yy, cz + Math.sin(a) * r];
    });
    const bot = ring(rBottom, y);
    const tp = ring(rTop, y + h);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const mid = (start + ((i + 0.5) / sides) * Math.PI * 2);
      const out = [Math.cos(mid), 0.2, Math.sin(mid)];
      if (rTop > 0.0001) this.quad(bot[i], bot[j], tp[j], tp[i], lo, lo, col, col, out);
      else this.tri(bot[i], bot[j], [cx, y + h, cz], lo, lo, col, out);
    }
    if (cap && rTop > 0.0001) {
      const centre = [cx, y + h, cz];
      for (let i = 0; i < sides; i++) this.tri(centre, tp[i], tp[(i + 1) % sides], top, top, top, [0, 1, 0]);
    }
  }

  /** Four-sided pyramid (hip roof, finial). */
  pyramid(cx, y, cz, w, d, h, col) {
    const hw = w / 2;
    const hd = d / 2;
    const apex = [cx, y + h, cz];
    const b = [[cx - hw, y, cz - hd], [cx + hw, y, cz - hd], [cx + hw, y, cz + hd], [cx - hw, y, cz + hd]];
    const outs = [[0, 0.5, -1], [1, 0.5, 0], [0, 0.5, 1], [-1, 0.5, 0]];
    for (let i = 0; i < 4; i++) this.tri(b[i], b[(i + 1) % 4], apex, col, col, col, outs[i]);
  }

  /** Gable roof with the ridge along local x (rotate with rotY). */
  gable(cx, y, cz, w, d, h, col, { rotY = 0, end = col } = {}) {
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const P = (lx, ly, lz) => [cx + lx * c + lz * s, y + ly, cz - lx * s + lz * c];
    const hw = w / 2;
    const hd = d / 2;
    const a = P(-hw, 0, -hd);
    const b = P(hw, 0, -hd);
    const cc = P(hw, 0, hd);
    const dd = P(-hw, 0, hd);
    const r0 = P(-hw, h, 0);
    const r1 = P(hw, h, 0);
    const n1 = [-s, 1, -c];
    const n2 = [s, 1, c];
    this.quad(a, b, r1, r0, col, col, col, col, n1);
    this.quad(cc, dd, r0, r1, shade(col, 0.92), shade(col, 0.92), shade(col, 0.92), shade(col, 0.92), n2);
    this.tri(a, r0, dd, end, end, end, [-c, 0, s]);
    this.tri(b, cc, r1, end, end, end, [c, 0, -s]);
  }

  /** Low-poly ball (icosahedron) with lighter upper faces: tree canopies, heads, domes. */
  blob(cx, cy, cz, rx, ry, rz, col, { light = 1.12, dark = 0.86 } = {}) {
    const hi = shade(col, light);
    const lo = shade(col, dark);
    for (const [i, j, k] of ICO.f) {
      const pts = [ICO.v[i], ICO.v[j], ICO.v[k]].map((p) => [cx + p[0] * rx, cy + p[1] * ry, cz + p[2] * rz]);
      const ny = (ICO.v[i][1] + ICO.v[j][1] + ICO.v[k][1]) / 3;
      const cl = ny > 0.35 ? hi : ny < -0.3 ? lo : col;
      const out = [(ICO.v[i][0] + ICO.v[j][0] + ICO.v[k][0]) / 3, ny, (ICO.v[i][2] + ICO.v[j][2] + ICO.v[k][2]) / 3];
      this.tri(pts[0], pts[1], pts[2], cl, cl, cl, out);
    }
  }

  /** Horizontal rectangle facing up. */
  rect(x0, z0, x1, z1, y, col) {
    this.quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], col, col, col, col, [0, 1, 0]);
  }

  /** Horizontal rectangle centred on (cx, cz), rotated about Y. */
  rectRot(cx, cz, w, d, y, rotY, col) {
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const P = (lx, lz) => [cx + lx * c + lz * s, y, cz - lx * s + lz * c];
    this.quad(P(-w / 2, -d / 2), P(-w / 2, d / 2), P(w / 2, d / 2), P(w / 2, -d / 2), col, col, col, col, [0, 1, 0]);
  }

  /** Flat disc facing up. */
  disc(cx, y, cz, r, segments, col) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      this.tri([cx, y, cz], [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r], [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], col, col, col, [0, 1, 0]);
    }
  }

  /** Flat ring facing up. */
  ring(cx, y, cz, r0, r1, segments, col) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p = (r, a) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      this.quad(p(r0, a0), p(r1, a0), p(r1, a1), p(r0, a1), col, col, col, col, [0, 1, 0]);
    }
  }

  /** Vertical panel (window, sign) centred at (cx, cy, cz), facing heading `face` (0 = +z). */
  panel(cx, cy, cz, w, h, face, col, depth = 0) {
    const fx = Math.sin(face);
    const fz = Math.cos(face);
    const rx = Math.cos(face);
    const rz = -Math.sin(face);
    const ox = cx + fx * depth;
    const oz = cz + fz * depth;
    const P = (u, v) => [ox + rx * u, cy + v, oz + rz * u];
    this.quad(P(-w / 2, -h / 2), P(w / 2, -h / 2), P(w / 2, h / 2), P(-w / 2, h / 2), col, col, col, col, [fx, 0, fz]);
  }

  build() {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    g.computeBoundingSphere();
    return g;
  }
}
