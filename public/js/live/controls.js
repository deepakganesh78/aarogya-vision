// Map-style camera controls for the live view.
// Drag to pan (the grabbed ground point stays under the pointer), right-drag or Shift+drag to rotate and
// tilt, wheel or pinch to zoom towards the pointer, two-finger twist to rotate. Arrow keys pan, + and -
// zoom, Q and E rotate. The camera can glide to a target and follow a moving vehicle.
import { Plane, Raycaster, Vector2, Vector3 } from '/vendor/three.js';
import { angleDelta, clamp } from './util.js';

const TAP_PX = 7;

export class MapControls {
  constructor(camera, dom, { bounds, onTap, onInteract, reducedMotion = false }) {
    this.camera = camera;
    this.dom = dom;
    this.bounds = bounds;
    this.onTap = onTap;
    this.onInteract = onInteract;
    this.reducedMotion = reducedMotion;
    this.target = new Vector3(0, 0, 0);
    this.distance = 128;
    this.azimuth = 0.55;
    this.polar = 0.93;
    this.minDistance = 12;
    this.maxDistance = 200;
    this.minPolar = 0.32;
    this.maxPolar = 1.18;
    this.goal = null;
    this.follow = null;
    this.velocity = new Vector2();
    this.pointers = new Map();
    this.mode = null;
    this.grab = null;
    this.ground = new Plane(new Vector3(0, 1, 0), 0);
    this.raycaster = new Raycaster();
    this.ndc = new Vector2();
    this.hit = new Vector3();
    this.lastMoveT = 0;
    this.apply();
    this.bind();
  }

  bind() {
    const d = this.dom;
    d.addEventListener('pointerdown', (e) => this.down(e));
    d.addEventListener('pointermove', (e) => this.move(e));
    d.addEventListener('pointerup', (e) => this.up(e));
    d.addEventListener('pointercancel', (e) => this.up(e, true));
    d.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    d.addEventListener('contextmenu', (e) => e.preventDefault());
    d.addEventListener('keydown', (e) => this.key(e));
  }

  groundPoint(clientX, clientY) {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const p = this.raycaster.ray.intersectPlane(this.ground, this.hit);
    return p ? p.clone() : null;
  }

  interacted() {
    this.goal = null;
    if (this.follow) {
      this.follow = null;
      this.onInteract?.('unfollow');
    }
    this.onInteract?.('move');
  }

  down(e) {
    this.dom.focus({ preventScroll: true });
    this.dom.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), button: e.button });
    this.velocity.set(0, 0);
    if (this.pointers.size === 1) {
      this.mode = e.button === 2 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey ? 'rotate' : 'pan';
      this.grab = this.mode === 'pan' ? this.groundPoint(e.clientX, e.clientY) : null;
    } else if (this.pointers.size === 2) {
      this.startPinch();
    }
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  startPinch() {
    this.mode = 'pinch';
    this.pinch = this.pinchState();
    this.grab = this.groundPoint(this.pinch.mx, this.pinch.my);
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > TAP_PX) p.moved = true;
    if (!p.moved && this.mode !== 'pinch') return;
    this.interacted();
    if (this.mode === 'pan' && this.grab) {
      const now = this.groundPoint(e.clientX, e.clientY);
      if (now) {
        const ox = this.grab.x - now.x;
        const oz = this.grab.z - now.z;
        this.target.x += ox;
        this.target.z += oz;
        const t = performance.now();
        const dt = Math.max(1, t - this.lastMoveT) / 1000;
        this.velocity.set((ox / dt) * 0.3 + this.velocity.x * 0.7, (oz / dt) * 0.3 + this.velocity.y * 0.7);
        this.lastMoveT = t;
        this.clampTarget();
        this.apply();
      }
    } else if (this.mode === 'rotate') {
      this.azimuth -= dx * 0.006;
      this.polar = clamp(this.polar - dy * 0.005, this.minPolar, this.maxPolar);
      this.apply();
    } else if (this.mode === 'pinch' && this.pointers.size === 2) {
      const now = this.pinchState();
      const ratio = now.dist / Math.max(1, this.pinch.dist);
      this.zoomAbout(now.mx, now.my, 1 / ratio);
      this.azimuth -= angleDelta(this.pinch.angle, now.angle);
      const g = this.groundPoint(now.mx, now.my);
      if (g && this.grab) {
        this.target.x += this.grab.x - g.x;
        this.target.z += this.grab.z - g.z;
        this.clampTarget();
      }
      this.pinch = now;
      this.apply();
    }
  }

  up(e, cancelled = false) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.dom.releasePointerCapture?.(e.pointerId);
    if (!p) return;
    const tap = !cancelled && !p.moved && this.mode !== 'pinch' && performance.now() - p.t < 600 && p.button === 0;
    if (this.pointers.size === 1) {
      const [rest] = this.pointers.values();
      this.mode = 'pan';
      this.grab = this.groundPoint(rest.x, rest.y);
      return;
    }
    if (this.pointers.size === 0) {
      if (this.mode !== 'pan' || performance.now() - this.lastMoveT > 80) this.velocity.set(0, 0);
      this.mode = null;
      this.grab = null;
    }
    if (tap) this.onTap?.(e.clientX, e.clientY);
  }

  wheel(e) {
    e.preventDefault();
    this.interacted();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this.zoomAbout(e.clientX, e.clientY, Math.exp(clamp(delta, -300, 300) * 0.0012));
    this.apply();
  }

  zoomAbout(clientX, clientY, factor) {
    const before = this.groundPoint(clientX, clientY);
    this.distance = clamp(this.distance * factor, this.minDistance, this.maxDistance);
    this.apply();
    const after = this.groundPoint(clientX, clientY);
    if (before && after) {
      this.target.x += before.x - after.x;
      this.target.z += before.z - after.z;
      this.clampTarget();
    }
  }

  key(e) {
    const step = this.distance * 0.08;
    const fx = -Math.sin(this.azimuth);
    const fz = -Math.cos(this.azimuth);
    const rx = Math.cos(this.azimuth);
    const rz = -Math.sin(this.azimuth);
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
        this.target.x += fx * step;
        this.target.z += fz * step;
        break;
      case 'ArrowDown':
        this.target.x -= fx * step;
        this.target.z -= fz * step;
        break;
      case 'ArrowLeft':
        this.target.x -= rx * step;
        this.target.z -= rz * step;
        break;
      case 'ArrowRight':
        this.target.x += rx * step;
        this.target.z += rz * step;
        break;
      case '+':
      case '=':
        this.distance = clamp(this.distance / 1.2, this.minDistance, this.maxDistance);
        break;
      case '-':
      case '_':
        this.distance = clamp(this.distance * 1.2, this.minDistance, this.maxDistance);
        break;
      case 'q':
      case 'Q':
        this.azimuth += 0.2;
        break;
      case 'e':
      case 'E':
        this.azimuth -= 0.2;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      this.interacted();
      this.clampTarget();
      this.apply();
    }
  }

  zoomBy(factor) {
    this.goal = { ...(this.goal || {}), distance: clamp(this.distance * factor, this.minDistance, this.maxDistance) };
  }

  rotateBy(radians) {
    this.goal = { ...(this.goal || {}), azimuth: this.azimuth + radians };
  }

  /** Glide to a view. `follow` is a function returning {x, z} each frame, or null. */
  flyTo({ x, z, distance, azimuth, polar }, { follow = null } = {}) {
    this.follow = follow;
    this.velocity.set(0, 0);
    this.goal = { x, z, distance: distance === undefined ? undefined : clamp(distance, this.minDistance, this.maxDistance), azimuth, polar };
    if (this.reducedMotion) {
      if (x !== undefined) this.target.x = x;
      if (z !== undefined) this.target.z = z;
      if (distance !== undefined) this.distance = this.goal.distance;
      if (azimuth !== undefined) this.azimuth = azimuth;
      if (polar !== undefined) this.polar = polar;
      if (!follow) this.goal = null;
      this.apply();
    }
  }

  clampTarget() {
    const b = this.bounds;
    this.target.x = clamp(this.target.x, b.x0, b.x1);
    this.target.z = clamp(this.target.z, b.z0, b.z1);
  }

  update(dt) {
    if (this.follow) {
      const p = this.follow();
      if (p) this.goal = { ...(this.goal || {}), x: p.x, z: p.z };
      else this.follow = null;
    }
    if (this.goal) {
      const g = this.goal;
      const k = 1 - Math.exp(-dt * (this.follow ? 5.5 : 3.4));
      let done = true;
      if (g.x !== undefined) {
        this.target.x += (g.x - this.target.x) * k;
        this.target.z += (g.z - this.target.z) * k;
        done &&= Math.hypot(g.x - this.target.x, g.z - this.target.z) < 0.05;
      }
      if (g.distance !== undefined) {
        this.distance += (g.distance - this.distance) * k;
        done &&= Math.abs(g.distance - this.distance) < 0.05;
      }
      if (g.azimuth !== undefined) {
        const d = angleDelta(this.azimuth, g.azimuth);
        this.azimuth += d * k;
        done &&= Math.abs(d) < 0.002;
      }
      if (g.polar !== undefined) {
        this.polar += (g.polar - this.polar) * k;
        done &&= Math.abs(g.polar - this.polar) < 0.002;
      }
      if (done && !this.follow) this.goal = null;
    } else if (!this.mode && this.velocity.lengthSq() > 0.01) {
      this.target.x += this.velocity.x * dt;
      this.target.z += this.velocity.y * dt;
      this.velocity.multiplyScalar(Math.exp(-dt * 5));
      this.clampTarget();
    }
    this.apply();
  }

  apply() {
    const sp = Math.sin(this.polar);
    const cp = Math.cos(this.polar);
    this.camera.position.set(
      this.target.x + this.distance * sp * Math.sin(this.azimuth),
      this.target.y + this.distance * cp,
      this.target.z + this.distance * sp * Math.cos(this.azimuth)
    );
    this.camera.lookAt(this.target);
  }
}
