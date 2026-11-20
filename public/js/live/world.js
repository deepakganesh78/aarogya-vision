// Static 3D world for the live view (rural block), built once from the layout: farmland and hills, roads,
// villages, the block town, health facilities, landmarks, trees, street lights and signals, merged into a
// few meshes. Houses sit in their own mesh so each one can be recoloured by the severity of its open case.
// Returns handles for the animated parts (signals, fans, night lighting, festival lights, puddles, rings).
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RingGeometry,
  SRGBColorSpace
} from '/vendor/three.js';
import { GeoBuilder, color, shade } from './geometry.js';
import { BLOCK, PITCH, ROAD, ZEBRA } from './network.js';
import { mulberry32, pick, range } from './util.js';

// World content colours: white buildings on farmland. Health facilities are white with red trim; houses
// turn red (urgent) or yellow (review today) while they have an open case.
export const PALETTE = {
  ground: '#B5C28C',
  earth: '#DCCDA9',
  paved: '#D9D3C8',
  verge: '#C9B88E',
  road: '#8E8B85',
  marking: '#F4F1EA',
  field: '#FFFFFF',
  bund: '#B49D74',
  sugarcane: '#6C9E53',
  sugarcaneTop: '#8CBC68',
  banana: '#7FB05D',
  grass: '#A8C47C',
  fallow: '#B97B52',
  water: '#7DB6C4',
  houseWall: '#F7F6F2',
  houseRoof: '#E2E0DA',
  tile: '#D6D3CC',
  door: '#8E7A66',
  windowDay: '#9EB1BD',
  white: '#FFFFFF',
  facilityRed: '#CF3B31',
  roof: '#E3E0D8',
  tank: '#59616A',
  concrete: '#D7D3CC',
  pole: '#8E959B',
  signalHead: '#3A3F44',
  trunk: '#A38867',
  palm: ['#78A673', '#86B27F', '#6E9D69'],
  tree: ['#8DB47F', '#9CBE8A', '#82AA75', '#97B786'],
  // Shop awnings and stall tarps stay in off-white canvas: the map keeps red and yellow for cases.
  awnings: ['#EFEBE3', '#E4DFD5', '#F3F0EA', '#DCD6CB'],
  shutter: '#A3A8AD',
  stone: '#E6DCC8',
  ochre: '#C98A4B',
  temple: ['#F4EFE6', '#EFE6D6', '#F6F1E8'],
  gold: '#E5B84C',
  hay: '#E3C66C',
  tarp: ['#E6E1D8', '#D9D3C7', '#ECE8E0'],
  hill: ['#9FB291', '#93A987', '#A7B898'],
  bench: '#9C8467',
  solar: '#3F5B7A'
};

/** Severity colours for houses with an open case (world content, kept in step with the map legend). */
export const SEVERITY_COLORS = { URGENT: '#E04A3C', PRIORITY: '#F2BE3B' };

const FESTIVE = ['#FFD36B', '#FF9F6B', '#FF7A9A', '#8FD3FF', '#B6F08A', '#FFFFFF'];
const CROP = { summer: new Color('#D7C978'), monsoon: new Color('#86C866'), festival: new Color('#E2C46A') };

/** Radial white-to-transparent texture (light pools, glows, string-light dots). */
export function radialTexture(inner = 'rgba(255,255,255,1)', size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function signTexture(text, { background, foreground, sub = null }) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 208;
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const draw = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 1024, 208);
    ctx.fillStyle = background;
    ctx.beginPath();
    ctx.roundRect(4, 4, 1016, 200, 36);
    ctx.fill();
    // White medical plus on red (the inverse of the protected Red Cross emblem).
    ctx.fillStyle = foreground;
    ctx.beginPath();
    ctx.roundRect(56, 84, 96, 40, 10);
    ctx.roundRect(84, 56, 40, 96, 10);
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${sub ? 76 : 84}px Roboto, system-ui, sans-serif`;
    ctx.fillText(text, 196, sub ? 80 : 106, 790);
    if (sub) {
      ctx.globalAlpha = 0.88;
      ctx.font = '500 44px Roboto, system-ui, sans-serif';
      ctx.fillText(sub, 198, 152, 790);
      ctx.globalAlpha = 1;
    }
    tex.needsUpdate = true;
  };
  draw();
  document.fonts?.ready.then(draw);
  return tex;
}

export function buildWorld({ scene, layout, network, accents, quality }) {
  const rng = mulberry32(99);
  const C = color;
  const clay = new GeoBuilder();
  const roads = new GeoBuilder();
  const fieldsGeo = new GeoBuilder(); // paddy, tinted by season through the material colour
  const homes = new GeoBuilder(); // houses, recoloured by case severity
  const winDark = new GeoBuilder();
  const winLit = new GeoBuilder();
  const bulbs = new GeoBuilder();
  const water = new GeoBuilder();
  const H = ROAD / 2;
  const LOT_Y = 0.1;
  const { roadX, roadZ, nx, nz } = network;
  const EXT = 3;
  const RED = C(PALETTE.facilityRed);
  const WHITE = C(PALETTE.white);

  // ---- Ground, distant hills, roads and markings ----------------------------------------------
  clay.rect(-480, -480, 480, 480, -0.02, C(PALETTE.ground));
  for (let a = 0; a < Math.PI * 2; a += 0.16) {
    const d = range(rng, 255, 330);
    const r = range(rng, 26, 46);
    clay.prism(Math.cos(a) * d, -0.5, Math.sin(a) * d, r, r * 0.18, range(rng, 16, 40), 7, C(pick(rng, PALETTE.hill)), { ao: 0.9, start: rng() * 3 });
  }
  const x0 = roadX(-EXT) - H;
  const x1 = roadX(nx + EXT) + H;
  const z0 = roadZ(-EXT) - H;
  const z1 = roadZ(nz + EXT) + H;
  const roadCol = C(PALETTE.road);
  const mark = C(PALETTE.marking);
  for (let j = -EXT; j <= nz + EXT; j++) roads.rect(x0 - 60, roadZ(j) - H, x1 + 60, roadZ(j) + H, 0, roadCol);
  for (let i = -EXT; i <= nx + EXT; i++) roads.rect(roadX(i) - H, z0 - 60, roadX(i) + H, z1 + 60, 0, roadCol);

  const dashes = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    for (let s = 0.4; s < len - 0.8; s += 2.2) roads.rectRot(ax + ux * (s + 0.5), az + uz * (s + 0.5), 0.09, 1.0, 0.012, Math.atan2(ux, uz), mark);
  };
  const gap = H + 0.8;
  for (let j = -EXT; j <= nz + EXT; j++) for (let i = -EXT; i < nx + EXT; i++) dashes(roadX(i) + gap, roadZ(j), roadX(i + 1) - gap, roadZ(j));
  for (let i = -EXT; i <= nx + EXT; i++) for (let j = -EXT; j < nz + EXT; j++) dashes(roadX(i), roadZ(j) + gap, roadX(i), roadZ(j + 1) - gap);

  // Zebra crossings in the town only; stop lines only where there are signals.
  for (const id of layout.townNodes) {
    const node = network.nodes.get(id);
    if (!node) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rot = Math.atan2(dx, dz);
      for (let u = -1.5; u <= 1.51; u += 0.6) roads.rectRot(node.x + dx * (H + ZEBRA / 2) + dz * u, node.z + dz * (H + ZEBRA / 2) - dx * u, 0.34, ZEBRA - 0.1, 0.013, rot, mark);
    }
  }
  for (const lane of network.lanes.values()) {
    if (!network.nodes.get(lane.to).signal) continue;
    const p = network.pointOnLane(lane, lane.length - ZEBRA - 0.25, 0);
    roads.rectRot(p.x, p.z, 1.6, 0.14, 0.013, lane.heading, mark);
  }

  // ---- Blocks: settled ground and farmland ----------------------------------------------------
  const half = BLOCK / 2;
  const settledGround = { earth: PALETTE.earth, paved: PALETTE.paved };
  for (const block of layout.blocks) {
    const isField = ['paddy', 'sugarcane', 'banana', 'grove', 'lake'].includes(block.kind);
    if (isField) {
      verge(block.cx, block.cz);
      if (block.kind === 'lake') clay.rect(block.cx - half + 0.9, block.cz - half + 0.9, block.cx + half - 0.9, block.cz + half - 0.9, 0.02, C(PALETTE.grass));
      continue;
    }
    clay.box(block.cx, 0, block.cz, BLOCK, LOT_Y, BLOCK, C(settledGround[block.ground] || PALETTE.earth), { ao: 0.86 });
  }
  for (const f of layout.fields) field(f.cx, f.cz, f.kind);
  for (const f of layout.filler) {
    verge(f.cx, f.cz);
    if (f.kind === 'farm') {
      field(f.cx, f.cz, 'paddy', { skipCorner: true });
      farmhouse(f.cx + 4.6, f.cz + 4.6);
    } else if (f.kind === 'lake') {
      clay.rect(f.cx - half + 0.9, f.cz - half + 0.9, f.cx + half - 0.9, f.cz + half - 0.9, 0.02, C(PALETTE.grass));
      ellipse(water, f.cx, f.cz, range(rng, 4.6, 6.2), range(rng, 4, 5.8), 0.04, C(PALETTE.water));
    } else {
      field(f.cx, f.cz, f.kind);
    }
  }

  function verge(cx, cz) {
    const o = half;
    const w = 0.9;
    clay.rect(cx - o, cz - o, cx + o, cz - o + w, 0.015, C(PALETTE.verge));
    clay.rect(cx - o, cz + o - w, cx + o, cz + o, 0.015, C(PALETTE.verge));
    clay.rect(cx - o, cz - o + w, cx - o + w, cz + o - w, 0.015, C(PALETTE.verge));
    clay.rect(cx + o - w, cz - o + w, cx + o, cz + o - w, 0.015, C(PALETTE.verge));
  }

  function ellipse(builder, cx, cz, rx, rz, y, col, segments = 28) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      builder.tri([cx, y, cz], [cx + Math.cos(a0) * rx, y, cz + Math.sin(a0) * rz], [cx + Math.cos(a1) * rx, y, cz + Math.sin(a1) * rz], col, col, col, [0, 1, 0]);
    }
  }

  function field(cx, cz, kind, { skipCorner = false } = {}) {
    const inner = half - 1.0;
    switch (kind) {
      case 'paddy': {
        // Plots separated by earth bunds, with crop rows.
        const cols = rng() < 0.5 ? 2 : 3;
        const rows = 2;
        const pw = (inner * 2) / cols;
        const pd = (inner * 2) / rows;
        for (let i = 0; i < cols; i++) {
          for (let j = 0; j < rows; j++) {
            if (skipCorner && i === cols - 1 && j === rows - 1) continue;
            const px0 = cx - inner + i * pw + 0.12;
            const pz0 = cz - inner + j * pd + 0.12;
            const px1 = px0 + pw - 0.24;
            const pz1 = pz0 + pd - 0.24;
            const tone = C(PALETTE.field);
            fieldsGeo.rect(px0, pz0, px1, pz1, 0.03, shade(tone, range(rng, 0.9, 1)));
            const alongX = rng() < 0.5;
            const rowCol = shade(tone, 0.78);
            for (let s = 0.3; s < (alongX ? pd : pw) - 0.4; s += 0.5) {
              if (alongX) fieldsGeo.rect(px0 + 0.1, pz0 + s, px1 - 0.1, pz0 + s + 0.12, 0.035, rowCol);
              else fieldsGeo.rect(px0 + s, pz0 + 0.1, px0 + s + 0.12, pz1 - 0.1, 0.035, rowCol);
            }
          }
        }
        for (let i = 0; i <= cols; i++) clay.box(cx - inner + i * pw, 0, cz, 0.22, 0.12, inner * 2, C(PALETTE.bund), { ao: 0.9 });
        for (let j = 0; j <= rows; j++) clay.box(cx, 0, cz - inner + j * pd, inner * 2, 0.12, 0.22, C(PALETTE.bund), { ao: 0.9 });
        if (rng() < 0.5) tree(cx + range(rng, -inner, inner), cz - inner, 'palm', range(rng, 0.9, 1.15));
        break;
      }
      case 'sugarcane': {
        clay.rect(cx - inner, cz - inner, cx + inner, cz + inner, 0.02, C(PALETTE.fallow));
        for (let x = -inner + 0.4; x < inner - 0.2; x += 0.75) {
          clay.box(cx + x, 0, cz, 0.36, range(rng, 0.9, 1.2), inner * 2 - 0.6, C(PALETTE.sugarcane), { top: C(PALETTE.sugarcaneTop), ao: 0.8 });
        }
        break;
      }
      case 'banana': {
        clay.rect(cx - inner, cz - inner, cx + inner, cz + inner, 0.02, C(PALETTE.grass));
        for (let x = -inner + 0.9; x < inner; x += 1.8) {
          for (let z = -inner + 0.9; z < inner; z += 1.8) banana(cx + x + range(rng, -0.2, 0.2), cz + z + range(rng, -0.2, 0.2));
        }
        break;
      }
      case 'grove': {
        clay.rect(cx - inner, cz - inner, cx + inner, cz + inner, 0.02, C(PALETTE.grass));
        for (let x = -inner + 1.4; x < inner; x += 3.0) {
          for (let z = -inner + 1.4; z < inner; z += 3.0) tree(cx + x + range(rng, -0.5, 0.5), cz + z + range(rng, -0.5, 0.5), 'palm', range(rng, 1.0, 1.35));
        }
        break;
      }
      case 'fallow': {
        clay.rect(cx - inner, cz - inner, cx + inner, cz + inner, 0.02, C(PALETTE.fallow));
        for (let x = -inner + 0.6; x < inner; x += 0.9) clay.rect(cx + x, cz - inner + 0.3, cx + x + 0.18, cz + inner - 0.3, 0.025, shade(C(PALETTE.fallow), 0.85));
        break;
      }
      default:
        break;
    }
  }

  function banana(x, z) {
    clay.prism(x, 0, z, 0.1, 0.08, 0.9, 6, C('#8F9A5C'), { ao: 0.9 });
    const leaf = C(PALETTE.banana);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + range(rng, -0.3, 0.3);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const base = [x, 0.92, z];
      const tip = [x + ca * 0.85, 0.75, z + sa * 0.85];
      clay.tri(base, [x + ca * 0.4 - sa * 0.2, 1.05, z + sa * 0.4 + ca * 0.2], tip, leaf, leaf, shade(leaf, 0.9), [0, 1, 0]);
      clay.tri(base, tip, [x + ca * 0.4 + sa * 0.2, 1.05, z + sa * 0.4 - ca * 0.2], leaf, shade(leaf, 0.9), leaf, [0, 1, 0]);
    }
  }

  function haystack(x, z, s = 1) {
    clay.prism(x, LOT_Y, z, 0.55 * s, 0.0, 1.0 * s, 9, C(PALETTE.hay), { ao: 0.85 });
    clay.prism(x, LOT_Y + 0.95 * s, z, 0.05, 0.05, 0.3 * s, 4, C(PALETTE.trunk));
  }

  function farmhouse(x, z) {
    clay.box(x, 0, z, 2.6, 0.9, 2.2, C(PALETTE.houseWall), { top: C(PALETTE.houseRoof) });
    clay.gable(x, 0.9, z, 2.9, 2.5, 0.65, C(PALETTE.tile), { end: C(PALETTE.houseWall) });
    haystack(x - 2.1, z + 0.4, 0.9);
  }

  // ---- Shared building parts ------------------------------------------------------------------
  function parapet(builder, x, z, w, d, y, col) {
    const t = 0.1;
    builder.box(x, y, z - d / 2 + t / 2, w, 0.16, t, col);
    builder.box(x, y, z + d / 2 - t / 2, w, 0.16, t, col);
    builder.box(x - w / 2 + t / 2, y, z, t, 0.16, d - 2 * t, col);
    builder.box(x + w / 2 - t / 2, y, z, t, 0.16, d - 2 * t, col);
  }

  function windowsGrid(b, { litRatio = 0.4, startFloor = 0, width = 0.42, height = 0.38, spacing = 1.05, floorH = 0.9 } = {}) {
    for (const face of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const along = face === 0 || face === Math.PI ? b.w : b.d;
      const halfD = face === 0 || face === Math.PI ? b.d / 2 : b.w / 2;
      const cols = Math.max(1, Math.floor((along - 0.5) / spacing));
      const rx = Math.cos(face);
      const rz = -Math.sin(face);
      for (let f = startFloor; f < b.floors; f++) {
        for (let k = 0; k < cols; k++) {
          const u = (k - (cols - 1) / 2) * spacing;
          (rng() < litRatio ? winLit : winDark).panel(b.x + Math.sin(face) * halfD + rx * u, LOT_Y + f * floorH + 0.5, b.z + Math.cos(face) * halfD + rz * u, width, height, face, C(PALETTE.windowDay), 0.012);
        }
      }
    }
  }

  const frontOf = (b) => {
    const lane = network.lanes.get(b.frontage.laneId);
    return Math.atan2(-lane.left.x, -lane.left.z);
  };
  const faceHalf = (b, face) => (Math.abs(Math.sin(face)) > 0.5 ? b.w / 2 : b.d / 2);
  const faceAlong = (b, face) => (Math.abs(Math.sin(face)) > 0.5 ? b.d : b.w);

  // ---- Houses (recolourable) and other buildings ----------------------------------------------
  const houseRanges = new Map();
  for (const b of layout.buildings) {
    const face = frontOf(b);
    const top = LOT_Y + b.h;
    const half2 = faceHalf(b, face);
    const fx = b.x + Math.sin(face) * half2;
    const fz = b.z + Math.cos(face) * half2;
    switch (b.kind) {
      case 'house': {
        const start = homes.positions.length / 3;
        homes.box(b.x, LOT_Y, b.z, b.w, b.h, b.d, C(PALETTE.houseWall), { top: C(PALETTE.houseRoof) });
        if (b.roof === 'tile') homes.gable(b.x, top, b.z, b.w + 0.34, b.d + 0.34, 0.66, C(PALETTE.tile), { end: C(PALETTE.houseWall) });
        else parapet(homes, b.x, b.z, b.w, b.d, top, C(PALETTE.houseWall));
        // Front verandah step (thinnai).
        homes.box(fx + Math.sin(face) * 0.25, LOT_Y, fz + Math.cos(face) * 0.25, faceAlong(b, face) * 0.7, 0.22, 0.5, C(PALETTE.houseWall), { rotY: face });
        houseRanges.set(b.id, { start, end: homes.positions.length / 3 });
        clay.panel(fx, LOT_Y + 0.42, fz, 0.5, 0.78, face, C(PALETTE.door), 0.014);
        windowsGrid(b, { spacing: 1.25, litRatio: 0.5 });
        if (b.roof !== 'tile' && rng() < 0.4) clay.prism(b.x - b.w * 0.2, top, b.z + b.d * 0.15, 0.2, 0.2, 0.34, 8, C(PALETTE.tank));
        break;
      }
      case 'hwc': {
        clay.box(b.x, LOT_Y, b.z, b.w, b.h, b.d, WHITE, { top: C(PALETTE.roof) });
        parapet(clay, b.x, b.z, b.w, b.d, top, RED);
        const along = faceAlong(b, face);
        clay.panel(fx, LOT_Y + 0.95, fz, along, 0.12, face, RED, 0.015);
        clay.panel(fx, LOT_Y + 1.38, fz, 0.72, 0.62, face, RED, 0.03);
        clay.panel(fx, LOT_Y + 1.38, fz, 0.46, 0.13, face, WHITE, 0.04);
        clay.panel(fx, LOT_Y + 1.38, fz, 0.13, 0.46, face, WHITE, 0.04);
        clay.panel(fx, LOT_Y + 0.42, fz, 0.6, 0.8, face, C(PALETTE.door), 0.014);
        windowsGrid(b, { spacing: 1.3, litRatio: 0.6 });
        break;
      }
      case 'shop': {
        clay.box(b.x, LOT_Y, b.z, b.w, b.h, b.d, C(PALETTE.houseWall), { top: C(PALETTE.roof) });
        parapet(clay, b.x, b.z, b.w, b.d, top, C(PALETTE.houseWall));
        const awFace = b.awning === 'south' ? 0 : Math.PI;
        const sz = b.z + Math.cos(awFace) * (b.d / 2);
        clay.panel(b.x, LOT_Y + 0.42, sz, b.w - 0.5, 0.78, awFace, C(PALETTE.shutter), 0.012);
        const awn = C(PALETTE.awnings[b.awningColor % PALETTE.awnings.length]);
        const dir = Math.cos(awFace);
        for (let k = 0; k < 6; k++) {
          const u0 = -b.w / 2 + 0.15 + (k * (b.w - 0.3)) / 6;
          const u1 = u0 + (b.w - 0.3) / 6;
          const col = k % 2 ? WHITE : awn;
          const yTop = LOT_Y + 1.0;
          clay.quad([b.x + u0, yTop, sz], [b.x + u1, yTop, sz], [b.x + u1, yTop - 0.28, sz + dir * 0.95], [b.x + u0, yTop - 0.28, sz + dir * 0.95], col, col, col, col, [0, 1, dir]);
        }
        clay.panel(b.x, LOT_Y + 1.18, sz, b.w - 0.4, 0.26, awFace, awn, 0.02);
        if (b.floors > 1) windowsGrid(b, { startFloor: 1, spacing: 1.1 });
        break;
      }
      case 'school': {
        clay.box(b.x, LOT_Y, b.z, b.w, b.h, b.d, C(PALETTE.houseWall), { top: C(PALETTE.roof) });
        parapet(clay, b.x, b.z, b.w, b.d, top, C(PALETTE.houseWall));
        clay.box(b.x, LOT_Y + 0.88, b.z + b.d / 2 + 0.45, b.w, 0.08, 0.9, C(PALETTE.roof), { ao: 1 });
        windowsGrid(b, { spacing: 0.9, litRatio: 0.2 });
        // Playground with goalposts.
        clay.rect(b.x - b.w / 2, b.z + b.d / 2 + 1.2, b.x + b.w / 2, b.z + b.d / 2 + 6.6, LOT_Y + 0.004, C('#D2BE93'));
        for (const gx of [b.x - b.w / 2 + 0.5, b.x + b.w / 2 - 0.5]) {
          clay.box(gx, LOT_Y, b.z + b.d / 2 + 3.4, 0.06, 0.8, 0.06, WHITE);
          clay.box(gx, LOT_Y, b.z + b.d / 2 + 4.6, 0.06, 0.8, 0.06, WHITE);
          clay.box(gx, LOT_Y + 0.8, b.z + b.d / 2 + 4.0, 0.06, 0.06, 1.26, WHITE);
        }
        break;
      }
      default:
        clay.box(b.x, LOT_Y, b.z, b.w, b.h, b.d, C(PALETTE.houseWall));
    }
  }

  // Village extras: ponds, haystacks and market stalls.
  for (const v of layout.villages) {
    if (!v.pond) continue;
    clay.ring(v.pond.x, LOT_Y + 0.004, v.pond.z, v.pond.r, v.pond.r + 0.28, 24, C(PALETTE.stone));
    water.disc(v.pond.x, LOT_Y + 0.02, v.pond.z, v.pond.r, 24, C(PALETTE.water));
  }
  for (const d of layout.decorations) {
    if (d.kind === 'haystack') haystack(d.x, d.z, range(rng, 0.8, 1.1));
    if (d.kind === 'stall') {
      const tarp = C(pick(rng, PALETTE.tarp));
      for (const [sx, sz] of [[-0.6, -0.5], [0.6, -0.5], [-0.6, 0.5], [0.6, 0.5]]) clay.box(d.x + sx, LOT_Y, d.z + sz, 0.06, 0.9, 0.06, C(PALETTE.concrete));
      clay.gable(d.x, LOT_Y + 0.9, d.z, 1.4, 1.2, 0.3, tarp, { end: tarp });
      clay.box(d.x, LOT_Y, d.z, 1.0, 0.36, 0.7, C('#C9A97E'));
      for (let k = 0; k < 3; k++) clay.blob(d.x - 0.3 + k * 0.3, LOT_Y + 0.44, d.z, 0.1, 0.08, 0.1, C(['#E7A04D', '#9CC46A', '#E4D36B'][k]));
    }
  }

  // ---- Health facilities: white with red trim and signage --------------------------------------
  const signs = [];
  const fans = [];
  const fanGeo = (() => {
    const g = new GeoBuilder();
    g.box(0, 0, 0, 0.66, 0.04, 0.1, C(PALETTE.concrete));
    g.box(0, 0, 0, 0.1, 0.04, 0.66, C(PALETTE.concrete));
    return g.build();
  })();
  const matClay = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });

  for (const c of layout.centres) {
    const isStore = c.kind === 'warehouse';
    const m = c.main;
    const top = LOT_Y + m.h;
    clay.box(m.x, LOT_Y, m.z, m.w, m.h, m.d, WHITE, { top: C(PALETTE.roof) });
    if (isStore) {
      // Light roof with a red band, like the other facilities: solid red is kept for urgent homes.
      clay.box(m.x, top - 0.3, m.z, m.w + 0.08, 0.3, m.d + 0.08, RED, { ao: 1 });
      clay.gable(m.x, top, m.z, m.w + 0.4, m.d + 0.4, 1.2, C(PALETTE.tile), { end: WHITE });
      for (let k = 0; k < 3; k++) clay.panel(m.x - m.w / 2 + 1.4 + k * 2.4, LOT_Y + 1.0, m.z + Math.cos(c.rot) * (m.d / 2), 1.8, 1.8, c.rot, C(PALETTE.shutter), 0.015);
      clay.box(c.canopy.x, LOT_Y, c.canopy.z, c.canopy.w, 0.55, c.canopy.d, C(PALETTE.concrete));
      for (let k = 0; k < 4; k++) clay.box(m.x + m.w / 2 + 0.6, LOT_Y + (k % 2) * 0.4, m.z - 1.6 + Math.floor(k / 2) * 0.9, 0.8, 0.38, 0.8, C('#C9A97E'));
    } else {
      parapet(clay, m.x, m.z, m.w, m.d, top, RED);
      const a = c.annex;
      clay.box(a.x, LOT_Y, a.z, a.w, a.h, a.d, WHITE, { top: C(PALETTE.roof) });
      parapet(clay, a.x, a.z, a.w, a.d, LOT_Y + a.h, RED);
      for (let f = 1; f < c.floors; f++) clay.box(m.x, LOT_Y + f * 0.95 - 0.05, m.z, m.w + 0.08, 0.1, m.d + 0.08, RED, { ao: 1 });
      windowsGrid({ x: m.x, z: m.z, w: m.w, d: m.d, floors: c.floors }, { litRatio: 0.7, startFloor: 1, floorH: 0.95 });
      windowsGrid({ x: a.x, z: a.z, w: a.w, d: a.d, floors: c.floors - 1 }, { litRatio: 0.6, floorH: 0.95 });
      const cp = c.canopy;
      clay.box(cp.x, LOT_Y + cp.h, cp.z, cp.w, 0.1, cp.d, RED);
      for (const sx of [-1, 1]) clay.box(cp.x + sx * (cp.w / 2 - 0.15), LOT_Y, cp.z + Math.cos(c.rot) * (cp.d / 2 - 0.15), 0.12, cp.h, 0.12, WHITE);
      for (let k = 0; k < 4; k++) clay.box(a.x - a.w / 2 + 1.0 + k * 1.3, LOT_Y + a.h, a.z, 1.1, 0.12, 1.6, C(PALETTE.solar), { ao: 1 });
      clay.prism(m.x + m.w / 4, top, m.z + m.d / 4, 0.3, 0.3, 0.5, 8, C(PALETTE.tank));
      for (const fan of c.fans) {
        clay.prism(fan.x, top, fan.z, 0.4, 0.36, 0.28, 10, C(PALETTE.concrete));
        const blades = new Mesh(fanGeo, matClay);
        blades.position.set(fan.x, top + 0.3, fan.z);
        blades.castShadow = true;
        fans.push({ mesh: blades, centreId: c.id });
      }
    }
    for (const bay of c.bays) {
      const len = bay.kind === 'scooter' ? 1.0 : 2.4;
      const wid = bay.kind === 'scooter' ? 0.7 : 1.3;
      for (const side of [-1, 1]) clay.rectRot(bay.x + Math.cos(bay.heading) * side * wid / 2, bay.z - Math.sin(bay.heading) * side * wid / 2, 0.05, len, LOT_Y + 0.006, bay.heading, WHITE);
    }
    const sign = new Mesh(
      new PlaneGeometry(c.signage.w, c.signage.h),
      new MeshStandardMaterial({ map: signTexture(c.name, { background: PALETTE.facilityRed, foreground: '#ffffff', sub: isStore ? 'Medicines and vaccines' : c.kind === 'chc' ? 'Open 24 hours' : 'Primary health centre' }), emissive: new Color('#ffffff'), roughness: 0.5 })
    );
    sign.material.emissiveMap = sign.material.map;
    sign.material.emissiveIntensity = 0.2;
    sign.position.set(c.signage.x + Math.sin(c.signage.heading) * 0.07, LOT_Y + c.signage.y, c.signage.z + Math.cos(c.signage.heading) * 0.07);
    sign.rotation.y = c.signage.heading;
    signs.push({ mesh: sign, centreId: c.id });
  }
  for (const s of layout.shelters) {
    clay.box(s.x, LOT_Y + s.h, s.z, s.w, 0.08, s.d, WHITE, { ao: 1 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) clay.box(s.x + sx * (s.w / 2 - 0.08), LOT_Y, s.z + sz * (s.d / 2 - 0.08), 0.1, s.h, 0.1, C(PALETTE.concrete));
  }

  // ---- Landmarks ------------------------------------------------------------------------------
  for (const l of layout.landmarks) {
    if (l.kind === 'temple') temple(l);
    if (l.kind === 'lake') {
      ellipse(clay, l.water.x, l.water.z, l.water.rx + 0.45, l.water.rz + 0.45, 0.03, C(PALETTE.bund));
      ellipse(water, l.water.x, l.water.z, l.water.rx, l.water.rz, 0.05, C(PALETTE.water), 36);
      for (let k = 0; k < 10; k++) {
        const a = range(rng, 0, Math.PI * 2);
        clay.prism(l.water.x + Math.cos(a) * (l.water.rx - 0.2), 0.04, l.water.z + Math.sin(a) * (l.water.rz - 0.2), 0.05, 0.02, 0.5, 4, C('#7E9B55'));
      }
    }
    if (l.kind === 'busstand') {
      // White roof: red on the map means a health facility or an urgent home.
      clay.box(l.x, LOT_Y + 1.5, l.z, 5.4, 0.12, 2.2, C(PALETTE.roof), { ao: 1 });
      for (const [sx, sz] of [[-2.5, -0.9], [2.5, -0.9], [-2.5, 0.9], [2.5, 0.9]]) clay.box(l.x + sx, LOT_Y, l.z + sz, 0.12, 1.5, 0.12, WHITE);
      clay.box(l.x, LOT_Y, l.z - 0.7, 4.2, 0.4, 0.4, C(PALETTE.bench));
    }
  }

  function temple(l) {
    const g = l.gopuram;
    const x0t = l.x - l.w / 2;
    const x1t = l.x + l.w / 2;
    const z0t = l.z - l.d / 2;
    const z1t = l.z + l.d / 2;
    const stripe = (xa, za, xb, zb) => {
      const len = Math.hypot(xb - xa, zb - za);
      const n = Math.max(2, Math.round(len / 0.5));
      for (let k = 0; k < n; k++) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        clay.beam(xa + (xb - xa) * t0, za + (zb - za) * t0, xa + (xb - xa) * t1, za + (zb - za) * t1, LOT_Y, 0.2, 0.65, C(k % 2 ? PALETTE.white : PALETTE.ochre), { ao: 0.9 });
      }
    };
    stripe(x0t, z0t, x1t, z0t);
    stripe(x0t, z0t, x0t, z1t);
    stripe(x1t, z0t, x1t, z1t);
    stripe(x0t, z1t, g.x - 1.7, z1t);
    stripe(g.x + 1.7, z1t, x1t, z1t);
    // Small village gopuram: white-washed tiers with gold finials.
    const gz = z1t - 0.2;
    clay.box(g.x, LOT_Y, gz, 3.2, 1.4, 2.0, C(PALETTE.stone));
    let y = LOT_Y + 1.4;
    for (let k = 0; k < 5; k++) {
      const w = 3.0 - k * 0.42;
      const d = 1.8 - k * 0.18;
      const col = C(PALETTE.temple[k % PALETTE.temple.length]);
      clay.box(g.x, y, gz, w, 0.66, d, col, { ao: 0.88 });
      clay.box(g.x, y + 0.6, gz, w + 0.1, 0.06, d + 0.1, C(PALETTE.ochre), { ao: 1 });
      y += 0.66;
    }
    for (let k = 0; k < 3; k++) clay.prism(g.x - 0.5 + k * 0.5, y, gz, 0.08, 0.0, 0.38, 6, C(PALETTE.gold));
    clay.box(g.x, LOT_Y, l.z - 1.0, 2.2, 1.2, 2.2, C(PALETTE.stone));
    clay.pyramid(g.x, LOT_Y + 1.2, l.z - 1.0, 2.0, 2.0, 1.2, C(PALETTE.temple[1]));
    clay.prism(g.x, LOT_Y + 2.4, l.z - 1.0, 0.1, 0.0, 0.4, 6, C(PALETTE.gold));
    const p = l.pond;
    for (let k = 0; k < 3; k++) {
      const inset = k * 0.25;
      const col = shade(C(PALETTE.stone), 1 - k * 0.05);
      clay.box(p.x, LOT_Y, p.z - p.d / 2 + inset + 0.12, p.w - inset * 2, 0.3 - k * 0.07, 0.24, col, { ao: 0.92 });
      clay.box(p.x, LOT_Y, p.z + p.d / 2 - inset - 0.12, p.w - inset * 2, 0.3 - k * 0.07, 0.24, col, { ao: 0.92 });
      clay.box(p.x - p.w / 2 + inset + 0.12, LOT_Y, p.z, 0.24, 0.3 - k * 0.07, p.d - inset * 2 - 0.48, col, { ao: 0.92 });
      clay.box(p.x + p.w / 2 - inset - 0.12, LOT_Y, p.z, 0.24, 0.3 - k * 0.07, p.d - inset * 2 - 0.48, col, { ao: 0.92 });
    }
    water.rect(p.x - p.w / 2 + 0.8, p.z - p.d / 2 + 0.8, p.x + p.w / 2 - 0.8, p.z + p.d / 2 - 0.8, LOT_Y + 0.08, C(PALETTE.water));
  }

  // ---- Trees ----------------------------------------------------------------------------------
  function tree(x, z, kind, scale) {
    const y0 = 0.02;
    if (kind === 'palm') {
      const h = 2.7 * scale;
      const lean = range(rng, -0.25, 0.25);
      const leanZ = range(rng, -0.25, 0.25);
      let px = x;
      let pz = z;
      let py = y0;
      for (let k = 0; k < 5; k++) {
        const nx2 = x + lean * ((k + 1) / 5) ** 2;
        const nz2 = z + leanZ * ((k + 1) / 5) ** 2;
        clay.prism((px + nx2) / 2, py, (pz + nz2) / 2, 0.1 - k * 0.008, 0.09 - k * 0.008, h / 5 + 0.02, 6, C(PALETTE.trunk), { ao: 0.95 });
        px = nx2;
        pz = nz2;
        py += h / 5;
      }
      const leaf = C(pick(rng, PALETTE.palm));
      for (let f = 0; f < 8; f++) {
        const a = (f / 8) * Math.PI * 2 + range(rng, -0.2, 0.2);
        const len = (1.15 + range(rng, -0.15, 0.15)) * scale;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const base = [px, py, pz];
        const mid = (t, side) => [px + ca * len * t - sa * side, py + 0.28 * scale - 0.1 * t, pz + sa * len * t + ca * side];
        const tip = [px + ca * len, py - 0.42 * scale, pz + sa * len];
        const lc = shade(leaf, 1.06);
        clay.tri(base, mid(0.45, 0.2 * scale), tip, lc, lc, leaf, [0, 1, 0]);
        clay.tri(base, tip, mid(0.45, -0.2 * scale), leaf, leaf, shade(leaf, 0.9), [0, 1, 0]);
      }
      clay.blob(px, py - 0.05, pz, 0.16, 0.12, 0.16, C('#8A6E4B'));
      return;
    }
    const h = 1.1 * scale;
    clay.prism(x, y0, z, 0.13 * scale, 0.1 * scale, h, 6, C(PALETTE.trunk), { ao: 0.95 });
    const leaf = C(pick(rng, PALETTE.tree));
    clay.blob(x, y0 + h + 0.6 * scale, z, 0.95 * scale, 0.75 * scale, 0.95 * scale, leaf);
    clay.blob(x + 0.35 * scale, y0 + h + 1.1 * scale, z - 0.2 * scale, 0.6 * scale, 0.5 * scale, 0.6 * scale, shade(leaf, 1.05));
  }
  for (const t of layout.trees) tree(t.x, t.z, t.kind, t.scale);

  // ---- Street lights --------------------------------------------------------------------------
  const poolPositions = [];
  for (const l of layout.lights) {
    clay.prism(l.x, LOT_Y, l.z, 0.06, 0.05, 2.5, 6, C(PALETTE.pole), { ao: 1 });
    const hx = l.x + l.nx * 0.75;
    const hz = l.z + l.nz * 0.75;
    clay.beam(l.x, l.z, hx, hz, LOT_Y + 2.42, 0.06, 0.06, C(PALETTE.pole), { ao: 1 });
    clay.box(hx, LOT_Y + 2.36, hz, 0.34, 0.08, 0.34, C(PALETTE.pole), { ao: 1 });
    bulbs.box(hx, LOT_Y + 2.3, hz, 0.24, 0.06, 0.24, WHITE, { ao: 1 });
    poolPositions.push([hx + l.nx * 0.5, hz + l.nz * 0.5]);
  }

  // ---- Traffic signals (town junctions only) --------------------------------------------------
  const signalHeads = [];
  for (const node of network.nodes.values()) {
    if (!node.signal) continue;
    for (const laneId of node.signal.approaches) {
      const lane = network.lanes.get(laneId);
      // Pole on the left kerb before the zebra crossing (left-hand traffic), facing oncoming vehicles.
      const back = H + ZEBRA + 0.45;
      const px = node.x - lane.dir.x * back + lane.left.x * (H + 0.4);
      const pz = node.z - lane.dir.z * back + lane.left.z * (H + 0.4);
      clay.prism(px, LOT_Y, pz, 0.05, 0.05, 2.1, 6, C(PALETTE.pole), { ao: 1 });
      const face = lane.heading + Math.PI;
      clay.box(px, LOT_Y + 1.6, pz, 0.24, 0.66, 0.16, C(PALETTE.signalHead), { rotY: face, ao: 1 });
      const fx = Math.sin(face) * 0.09;
      const fz = Math.cos(face) * 0.09;
      signalHeads.push({ node, laneId, lamps: [0.5, 0.29, 0.08].map((dy) => [px + fx, LOT_Y + 1.6 + 0.04 + dy, pz + fz]), state: null });
    }
  }

  // ---- Assemble meshes ------------------------------------------------------------------------
  const group = new Group();
  const matRoad = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  const matFields = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, color: CROP.summer.clone() });
  const matHomes = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  const matWinDark = new MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.15 });
  const matWinLit = new MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.15, emissive: new Color('#FFC46B'), emissiveIntensity: 0 });
  const matBulb = new MeshStandardMaterial({ vertexColors: true, emissive: new Color('#FFD28A'), emissiveIntensity: 0, roughness: 0.4 });
  const matWater = new MeshStandardMaterial({ vertexColors: true, roughness: 0.1, metalness: 0.2 });
  const add = (builder, material, { cast = false, receive = true } = {}) => {
    if (builder.empty) return null;
    const mesh = new Mesh(builder.build(), material);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    return mesh;
  };
  add(roads, matRoad);
  add(fieldsGeo, matFields);
  add(clay, matClay, { cast: true });
  const homesMesh = add(homes, matHomes, { cast: true });
  add(winDark, matWinDark, { receive: false });
  add(winLit, matWinLit, { receive: false });
  add(bulbs, matBulb, { receive: false });
  add(water, matWater);
  for (const f of fans) group.add(f.mesh);
  for (const s of signs) group.add(s.mesh);

  // Houses keep their base colours so a case can be cleared back to white.
  const homesColor = homesMesh.geometry.attributes.color;
  homesColor.setUsage(DynamicDrawUsage);
  const homesBase = Float32Array.from(homesColor.array);
  const baseWhite = C(PALETTE.houseWall);
  const severity = Object.fromEntries(Object.entries(SEVERITY_COLORS).map(([k, hex]) => [k, new Color(hex)]));
  const houseLevels = new Map();

  // Homes with an open case glow in their case colour at night, so red and yellow stay readable.
  const caseGlow = new BufferAttribute(new Float32Array(homesColor.count), 1);
  caseGlow.setUsage(DynamicDrawUsage);
  homesMesh.geometry.setAttribute('caseGlow', caseGlow);
  const glowUniform = { value: 0 };
  matHomes.onBeforeCompile = (shader) => {
    shader.uniforms.uCaseGlow = glowUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float caseGlow;\nvarying float vCaseGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCaseGlow = caseGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uCaseGlow;\nvarying float vCaseGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vCaseGlow * uCaseGlow;');
  };

  function setSeverity(buildingId, level) {
    const r = houseRanges.get(buildingId);
    if (!r) return;
    const next = level || null;
    if ((houseLevels.get(buildingId) || null) === next) return;
    if (next) houseLevels.set(buildingId, next);
    else houseLevels.delete(buildingId);
    const arr = homesColor.array;
    const tint = next ? severity[next] : null;
    for (let i = r.start; i < r.end; i++) {
      const o = i * 3;
      if (!tint) {
        arr[o] = homesBase[o];
        arr[o + 1] = homesBase[o + 1];
        arr[o + 2] = homesBase[o + 2];
      } else {
        // Keep the clay shading (contact darkening, lighter roofs) by scaling the tint by the base tone.
        const k = Math.min(1.05, homesBase[o] / baseWhite.r);
        arr[o] = tint.r * k;
        arr[o + 1] = tint.g * k;
        arr[o + 2] = tint.b * k;
      }
    }
    caseGlow.array.fill(tint ? 1 : 0, r.start, r.end);
    caseGlow.addUpdateRange(r.start, r.end - r.start);
    caseGlow.needsUpdate = true;
    homesColor.addUpdateRange(r.start * 3, (r.end - r.start) * 3);
    homesColor.needsUpdate = true;
  }

  // Pulsing rings under houses with an urgent case.
  const housePos = new Map(layout.buildings.filter((b) => b.kind === 'house').map((b) => [b.id, b]));
  const urgentRings = new InstancedMesh(new RingGeometry(0.82, 1, 40), new MeshBasicMaterial({ color: SEVERITY_COLORS.URGENT, transparent: true, opacity: 0.85, depthWrite: false, side: DoubleSide }), 24);
  urgentRings.count = 0;
  urgentRings.renderOrder = 2;
  group.add(urgentRings);

  // Signal lamps: one instanced mesh, colours updated when a signal changes.
  const lampGeo = (() => {
    const g = new GeoBuilder();
    g.box(0, -0.065, 0, 0.13, 0.13, 0.05, WHITE, { ao: 1 });
    return g.build();
  })();
  const lamps = new InstancedMesh(lampGeo, new MeshBasicMaterial({ color: '#ffffff' }), Math.max(1, signalHeads.length * 3));
  const dummy = new Object3D();
  signalHeads.forEach((head, i) => {
    const lane = network.lanes.get(head.laneId);
    head.lamps.forEach((p, k) => {
      dummy.position.set(p[0], p[1], p[2]);
      dummy.rotation.set(0, lane.heading + Math.PI, 0);
      dummy.updateMatrix();
      lamps.setMatrixAt(i * 3 + k, dummy.matrix);
      lamps.setColorAt(i * 3 + k, new Color('#2B3035'));
    });
  });
  lamps.count = signalHeads.length * 3;
  group.add(lamps);
  const LAMP_ON = [new Color('#FF4A3D'), new Color('#FFB627'), new Color('#36D67C')];
  const LAMP_OFF = new Color('#2B3035');

  // Night light pools under street lights.
  const glowTex = radialTexture();
  const poolMat = new MeshBasicMaterial({ map: glowTex, color: new Color('#FFCF8A'), transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending });
  const pools = new InstancedMesh(new PlaneGeometry(1, 1), poolMat, Math.max(1, poolPositions.length));
  poolPositions.forEach(([x, z], i) => {
    dummy.position.set(x, 0.03, z);
    dummy.rotation.set(-Math.PI / 2, 0, 0);
    dummy.scale.set(4.6, 4.6, 1);
    dummy.updateMatrix();
    pools.setMatrixAt(i, dummy.matrix);
  });
  pools.count = poolPositions.length;
  pools.renderOrder = 2;
  pools.visible = false;
  group.add(pools);

  // Festival string lights: temple, market shops, village rooftops and across nearby streets.
  const festivePts = [];
  const strand = (ax, ay, az, bx, by, bz, sag = 0) => {
    const len = Math.hypot(bx - ax, bz - az, by - ay);
    const n = Math.max(2, Math.round(len / 0.4));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      festivePts.push([ax + (bx - ax) * t, ay + (by - ay) * t - Math.sin(Math.PI * t) * sag, az + (bz - az) * t]);
    }
  };
  for (const b of layout.buildings) {
    if (b.kind === 'shop' || (b.kind === 'house' && (b.zone === 'nallur' || rng() < 0.25))) {
      const y = LOT_Y + b.h + (b.roof === 'tile' ? 0.05 : 0.2);
      strand(b.x - b.w / 2, y, b.z + b.d / 2, b.x + b.w / 2, y, b.z + b.d / 2);
      strand(b.x - b.w / 2, y, b.z - b.d / 2, b.x + b.w / 2, y, b.z - b.d / 2);
    }
  }
  const templeMark = layout.landmarks.find((l) => l.kind === 'temple');
  if (templeMark) {
    const g = templeMark.gopuram;
    const gz = templeMark.z + templeMark.d / 2 - 0.2;
    let gy = LOT_Y + 1.4;
    for (let k = 0; k < 5; k++) {
      const w = 3.0 - k * 0.42;
      strand(g.x - w / 2 - 0.05, gy + 0.66, gz + (1.8 - k * 0.18) / 2 + 0.08, g.x + w / 2 + 0.05, gy + 0.66, gz + (1.8 - k * 0.18) / 2 + 0.08);
      gy += 0.66;
    }
    strand(g.x - 1.6, LOT_Y + 1.4, gz + 1.05, g.x, gy + 0.3, gz + 0.2);
    strand(g.x + 1.6, LOT_Y + 1.4, gz + 1.05, g.x, gy + 0.3, gz + 0.2);
    const x0t = templeMark.x - templeMark.w / 2;
    const x1t = templeMark.x + templeMark.w / 2;
    const z0t = templeMark.z - templeMark.d / 2;
    const z1t = templeMark.z + templeMark.d / 2;
    strand(x0t, LOT_Y + 0.75, z0t, x1t, LOT_Y + 0.75, z0t);
    strand(x0t, LOT_Y + 0.75, z0t, x0t, LOT_Y + 0.75, z1t);
    strand(x1t, LOT_Y + 0.75, z0t, x1t, LOT_Y + 0.75, z1t);
    const near = network.nodes.get('4,1');
    if (near) for (let x = roadX(3) + 2; x < roadX(4) - 1; x += 3.2) strand(x, 3.4, near.z - 2.4, x + 1.6, 3.4, near.z + 2.4, 0.5);
  }
  const festiveGeo = new BufferGeometry();
  festiveGeo.setAttribute('position', new Float32BufferAttribute(festivePts.flat(), 3));
  const festiveColors = new Float32BufferAttribute(new Float32Array(festivePts.length * 3), 3);
  festiveColors.setUsage(DynamicDrawUsage);
  festiveGeo.setAttribute('color', festiveColors);
  const festiveMat = new PointsMaterial({ size: 0.62, sizeAttenuation: true, vertexColors: true, map: glowTex, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending });
  const festive = new Points(festiveGeo, festiveMat);
  festive.visible = false;
  group.add(festive);
  const festivePalette = FESTIVE.map((h) => new Color(h));
  const paintFestive = (offset) => {
    const arr = festiveColors.array;
    for (let i = 0; i < festivePts.length; i++) {
      const c = festivePalette[(i + offset) % festivePalette.length];
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    festiveColors.needsUpdate = true;
  };
  paintFestive(0);

  // Monsoon puddles and ripples on the roads.
  const puddleCount = quality.low ? 40 : 70;
  const puddleMat = new MeshStandardMaterial({ color: new Color('#55626D'), roughness: 0.04, metalness: 0.75, transparent: true, opacity: 0, depthWrite: false });
  const puddles = new InstancedMesh(new CircleGeometry(1, 18), puddleMat, puddleCount);
  const puddleSpots = [];
  const laneList = [...network.lanes.values()];
  for (let i = 0; i < puddleCount; i++) {
    const lane = pick(rng, laneList);
    const p = network.pointOnLane(lane, range(rng, 2, lane.length - 2), range(rng, -0.6, 1.2));
    const sx = range(rng, 0.5, 1.3);
    const sz = range(rng, 0.3, 0.7);
    puddleSpots.push({ x: p.x, z: p.z, r: Math.min(sx, sz) });
    dummy.position.set(p.x, 0.016, p.z);
    dummy.rotation.set(-Math.PI / 2, 0, lane.heading + range(rng, -0.3, 0.3));
    dummy.scale.set(sx, sz, 1);
    dummy.updateMatrix();
    puddles.setMatrixAt(i, dummy.matrix);
  }
  puddles.visible = false;
  puddles.receiveShadow = true;
  group.add(puddles);
  const rippleCount = quality.low ? 18 : 36;
  const ripples = new InstancedMesh(new RingGeometry(0.82, 1, 24), new MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: AdditiveBlending }), rippleCount);
  const rippleState = Array.from({ length: rippleCount }, () => ({ spot: pick(rng, puddleSpots), phase: rng() }));
  for (let i = 0; i < rippleCount; i++) ripples.setColorAt(i, new Color(0, 0, 0));
  ripples.visible = false;
  group.add(ripples);

  scene.add(group);

  let festiveClock = 0;
  let festiveOffset = 0;
  let pulse = 0;
  const tmpColor = new Color();
  const cropColor = new Color();

  return {
    group,
    signs,
    fans,
    setSeverity,
    materials: { clay: matClay, road: matRoad, winLit: matWinLit, bulb: matBulb },
    bounds: { x0, x1, z0, z1 },
    update(dt, env, { centres }) {
      // Signals.
      let changed = false;
      signalHeads.forEach((head, i) => {
        const state = head.node.signal.approaches[head.node.signal.index] === head.laneId ? head.node.signal.stage : 'red';
        if (state === head.state) return;
        head.state = state;
        changed = true;
        lamps.setColorAt(i * 3, state === 'red' || state === 'allred' ? LAMP_ON[0] : LAMP_OFF);
        lamps.setColorAt(i * 3 + 1, state === 'amber' ? LAMP_ON[1] : LAMP_OFF);
        lamps.setColorAt(i * 3 + 2, state === 'green' ? LAMP_ON[2] : LAMP_OFF);
      });
      if (changed && lamps.instanceColor) lamps.instanceColor.needsUpdate = true;

      // Rooftop fans spin faster when a centre is busy; signs glow at night and when a centre lights up.
      for (const f of fans) {
        const c = centres.get(f.centreId);
        f.mesh.rotation.y += dt * (6 + Math.min(10, (c?.waiting || 0) / 3));
      }
      for (const s of signs) {
        const c = centres.get(s.centreId);
        s.mesh.material.emissiveIntensity = 0.2 + env.night * 0.85 + (c?.glow || 0) * 0.9;
      }

      // Urgent houses pulse.
      pulse += dt;
      let n = 0;
      for (const [id, level] of houseLevels) {
        if (level !== 'URGENT' || n >= 24) continue;
        const b = housePos.get(id);
        const phase = (pulse * 0.9 + n * 0.17) % 1;
        dummy.position.set(b.x, LOT_Y + 0.03, b.z);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        const s = Math.max(b.w, b.d) * (0.75 + phase * 0.9);
        dummy.scale.set(s, s, 1);
        dummy.updateMatrix();
        urgentRings.setMatrixAt(n, dummy.matrix);
        n += 1;
      }
      urgentRings.count = n;
      urgentRings.instanceMatrix.needsUpdate = true;
      urgentRings.material.opacity = 0.35 + 0.45 * (1 - ((pulse * 0.9) % 1));

      // Crops: golden in summer and at the festival harvest, lush green in the monsoon.
      cropColor.copy(CROP.summer).lerp(CROP.monsoon, env.monsoon).lerp(CROP.festival, env.festival * (1 - env.monsoon));
      matFields.color.copy(cropColor);

      // Night lighting.
      matWinLit.emissiveIntensity = env.night * 0.8;
      matBulb.emissiveIntensity = env.night * 3;
      glowUniform.value = env.night * 0.75;
      pools.visible = env.night > 0.02;
      poolMat.opacity = env.night * 0.5;

      // Festival lights chase along the strands.
      festive.visible = env.festival > 0.01;
      if (festive.visible) {
        festiveMat.opacity = env.festival * (0.35 + 0.65 * env.night);
        festiveClock += dt;
        if (festiveClock > 0.35) {
          festiveClock = 0;
          festiveOffset = (festiveOffset + 1) % FESTIVE.length;
          paintFestive(festiveOffset);
        }
      }

      // Monsoon: wet roads, puddles and ripples.
      const wet = env.monsoon;
      matRoad.color.setRGB(1 - wet * 0.22, 1 - wet * 0.2, 1 - wet * 0.15);
      matRoad.roughness = 0.88 - wet * 0.5;
      matRoad.metalness = wet * 0.12;
      puddles.visible = wet > 0.02;
      puddleMat.opacity = wet * 0.85;
      ripples.visible = wet > 0.05;
      if (ripples.visible) {
        rippleState.forEach((r, i) => {
          r.phase += dt * 0.9;
          if (r.phase > 1) {
            r.phase = 0;
            r.spot = pick(rng, puddleSpots);
          }
          dummy.position.set(r.spot.x, 0.022, r.spot.z);
          dummy.rotation.set(-Math.PI / 2, 0, 0);
          const s = 0.05 + r.phase * r.spot.r * 0.8;
          dummy.scale.set(s, s, 1);
          dummy.updateMatrix();
          ripples.setMatrixAt(i, dummy.matrix);
          const a = (1 - r.phase) * 0.5 * wet;
          ripples.setColorAt(i, tmpColor.setRGB(a, a, a));
        });
        ripples.instanceMatrix.needsUpdate = true;
        if (ripples.instanceColor) ripples.instanceColor.needsUpdate = true;
      }
    }
  };
}
