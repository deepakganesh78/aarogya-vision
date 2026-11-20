// Renderer, lighting, day/night and season environment, picking and screen projection for the live view.
import {
  Box3,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer
} from '/vendor/three.js';
import { createActors } from './actors.js';
import { MapControls } from './controls.js';
import { buildWorld } from './world.js';
import { damp, lerp } from './util.js';

// Environment colours (world content, not UI chrome).
const ENV = {
  fog: { day: '#E3E9DA', monsoon: '#AEB8C1', night: '#141A2A', festival: '#1C1631', monsoonNight: '#10151E' },
  sky: { day: '#FFF8EC', monsoon: '#C9D2DA', night: '#3B4A74', festival: '#4D3E73' },
  ground: { day: '#BFC497', monsoon: '#8E989D', night: '#1E2232' },
  sun: { day: '#FFF0DA', monsoon: '#DCE4EA', night: '#9DB2FF' }
};

export function detectQuality() {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const cores = navigator.hardwareConcurrency || 4;
  return { low: Boolean((coarse && small) || cores <= 4) };
}

export function createScene({ canvas, layout, network, accents, reducedMotion, onPick, onInteract }) {
  const quality = detectQuality();
  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: !quality.low, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  if (!renderer.getContext()) return null;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.low ? 1.5 : 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  // Shadows are re-rendered every other frame (every third on low-end devices) to save GPU time.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.02;

  const scene = new Scene();
  const fogColor = new Color(ENV.fog.day);
  scene.background = fogColor;
  scene.fog = new Fog(fogColor, 150, 360);

  const camera = new PerspectiveCamera(32, 1, 1, 900);
  const hemi = new HemisphereLight(ENV.sky.day, ENV.ground.day, 1.15);
  scene.add(hemi);
  const sun = new DirectionalLight(ENV.sun.day, 2.3);
  sun.position.set(-46, 82, 38);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -86;
  sc.right = 86;
  sc.top = 86;
  sc.bottom = -86;
  sc.near = 10;
  sc.far = 220;
  sun.shadow.mapSize.set(quality.low ? 1024 : 2048, quality.low ? 1024 : 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  const world = buildWorld({ scene, layout, network, accents, quality });
  const actors = createActors({ scene, accents, quality });

  const pickBoxes = [];
  for (const c of layout.centres) {
    pickBoxes.push({ ref: { type: 'centre', id: c.id }, box: new Box3(new Vector3(c.cx - 8, 0, c.cz - 8), new Vector3(c.cx + 8, c.main.h + 0.4, c.cz + 8)) });
  }
  for (const b of layout.buildings) {
    if (b.kind === 'school') continue; // picked as its landmark, which has the description
    pickBoxes.push({ ref: { type: 'building', id: b.id }, box: new Box3(new Vector3(b.x - b.w / 2, 0, b.z - b.d / 2), new Vector3(b.x + b.w / 2, b.h + 0.3, b.z + b.d / 2)) });
  }
  for (const l of layout.landmarks) {
    pickBoxes.push({ ref: { type: 'landmark', id: l.id }, box: new Box3(new Vector3(l.x - l.w / 2, 0, l.z - l.d / 2), new Vector3(l.x + l.w / 2, (l.h || 2) + 0.5, l.z + l.d / 2)) });
  }

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const tmp = new Vector3();
  const hitPoint = new Vector3();
  let fleetIds = new Set();

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const ray = raycaster.ray;
    let best = null;
    const consider = (ref, dist) => {
      if (!best || dist < best.dist) best = { ref, dist };
    };
    // Vehicles and pins are small, so they win over the building behind them.
    for (const [id, entry] of actors.vehicles) {
      if (!fleetIds.has(id)) continue;
      tmp.set(entry.v.x, 0.8, entry.v.z);
      const r = entry.v.kind === 'scooter' ? 1.2 : 1.7;
      if (ray.distanceSqToPoint(tmp) < r * r) consider({ type: 'vehicle', id }, ray.origin.distanceTo(tmp) - 6);
    }
    // A beacon (new case from the ASHA app) is picked anywhere along its marker and column.
    for (const b of actors.beacons.values()) {
      if (!b.ref) continue;
      for (const y of [b.top + 2.6, b.top + 5, 1.5]) {
        tmp.set(b.x, y, b.z);
        if (ray.distanceSqToPoint(tmp) < 2.2) consider(b.ref, ray.origin.distanceTo(tmp) - 8);
      }
    }
    for (const pin of actors.pins.values()) {
      tmp.copy(pin.mesh.position).setY(pin.mesh.position.y + 1);
      if (ray.distanceSqToPoint(tmp) < 1.6) consider({ type: 'run', id: pin.runId }, ray.origin.distanceTo(tmp) - 6);
    }
    for (const item of pickBoxes) {
      if (ray.intersectBox(item.box, hitPoint)) consider(item.ref, ray.origin.distanceTo(hitPoint));
    }
    return best?.ref || null;
  }

  const controls = new MapControls(camera, canvas, {
    bounds: { x0: -network.halfW - 20, x1: network.halfW + 20, z0: -network.halfD - 20, z1: network.halfD + 20 },
    onTap: (x, y) => onPick(pick(x, y)),
    onInteract,
    reducedMotion
  });

  // ---- Environment ----------------------------------------------------------------------------
  const env = { night: 0, monsoon: 0, festival: 0, reducedMotion };
  const goal = { night: 0, monsoon: 0, festival: 0 };
  const c = (hex) => new Color(hex);
  const palette = {
    fog: { day: c(ENV.fog.day), monsoon: c(ENV.fog.monsoon), night: c(ENV.fog.night), festival: c(ENV.fog.festival), monsoonNight: c(ENV.fog.monsoonNight) },
    sky: { day: c(ENV.sky.day), monsoon: c(ENV.sky.monsoon), night: c(ENV.sky.night), festival: c(ENV.sky.festival) },
    ground: { day: c(ENV.ground.day), monsoon: c(ENV.ground.monsoon), night: c(ENV.ground.night) },
    sun: { day: c(ENV.sun.day), monsoon: c(ENV.sun.monsoon), night: c(ENV.sun.night) }
  };
  const mixA = new Color();
  const mixB = new Color();

  function applyEnvironment() {
    const { night, monsoon, festival } = env;
    mixA.copy(palette.fog.day).lerp(palette.fog.monsoon, monsoon);
    mixB.copy(palette.fog.night).lerp(palette.fog.festival, festival).lerp(palette.fog.monsoonNight, monsoon * (1 - festival));
    fogColor.copy(mixA).lerp(mixB, night);
    scene.fog.color.copy(fogColor);
    mixA.copy(palette.sky.day).lerp(palette.sky.monsoon, monsoon);
    mixB.copy(palette.sky.night).lerp(palette.sky.festival, festival);
    hemi.color.copy(mixA).lerp(mixB, night);
    mixA.copy(palette.ground.day).lerp(palette.ground.monsoon, monsoon);
    hemi.groundColor.copy(mixA).lerp(palette.ground.night, night);
    hemi.intensity = lerp(lerp(1.15, 0.92, monsoon), 0.78, night);
    mixA.copy(palette.sun.day).lerp(palette.sun.monsoon, monsoon);
    sun.color.copy(mixA).lerp(palette.sun.night, night);
    sun.intensity = lerp(lerp(2.3, 0.5, monsoon), 0.6, night);
    sun.position.set(lerp(-46, 40, night), lerp(82, 70, night), lerp(38, -30, night));
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(canvas);
  // Portrait screens see less of the block across, so start further out.
  controls.distance = Math.min(175, 128 / Math.min(1, camera.aspect * 1.15));
  controls.apply();

  const projected = new Vector3();
  let frameNo = 0;
  let slow = 0;
  let pixelRatio = renderer.getPixelRatio();
  return {
    renderer,
    camera,
    controls,
    world,
    actors,
    env,
    quality,
    setFleetIds(ids) {
      fleetIds = ids;
    },
    setEnvironment(next) {
      Object.assign(goal, next);
      if (reducedMotion) {
        Object.assign(env, goal);
        applyEnvironment();
      }
    },
    /** Screen position (CSS pixels) of a world point, or null when behind the camera. */
    project(x, y, z) {
      projected.set(x, y, z).project(camera);
      if (projected.z > 1) return null;
      return { x: ((projected.x + 1) / 2) * canvas.clientWidth, y: ((1 - projected.y) / 2) * canvas.clientHeight };
    },
    frame(dt, simState) {
      for (const k of ['night', 'monsoon', 'festival']) env[k] = damp(env[k], goal[k], 2.2, dt);
      applyEnvironment();
      controls.update(dt);
      // Monsoon brings the mist in closer.
      scene.fog.near = controls.distance * (0.9 - env.monsoon * 0.45) + 30 - env.monsoon * 18;
      scene.fog.far = controls.distance * (1.4 - env.monsoon * 0.3) + 230 - env.monsoon * 110;
      world.update(dt, env, simState);
      actors.update(dt, env, {
        trafficVehicles: simState.trafficVehicles,
        fleetIds,
        target: { x: controls.target.x, z: controls.target.z, azimuth: controls.azimuth },
        fireworksAt: simState.fireworksAt
      });
      frameNo += 1;
      if (frameNo % (quality.low ? 3 : 2) === 0) renderer.shadowMap.needsUpdate = true;
      // Drop the render resolution step by step if frames stay slow on this device.
      if (document.visibilityState === 'visible') {
        slow = dt > 0.034 ? slow + dt : Math.max(0, slow - dt);
        if (slow > 2.5 && pixelRatio > 1) {
          pixelRatio = Math.max(1, pixelRatio - 0.25);
          renderer.setPixelRatio(pixelRatio);
          resize();
          slow = 0;
        }
      }
      renderer.render(scene, camera);
    }
  };
}
