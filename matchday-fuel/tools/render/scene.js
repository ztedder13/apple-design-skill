// Studio, camera and two-layer compositing for the product renders.
//
// Why two layers: three.js transmission only sees opaque objects, so a transmissive liquid
// inside a transmissive bottle would vanish. Each frame is therefore rendered twice:
//   1. Layer A (into a half-float render target): white backdrop, floor with contact shadow,
//      the inside of the sleeve, the far wall of the bottle, the liquid and its bubbles.
//   2. Layer B (to the canvas): layer A becomes the scene background, so the clear plastic,
//      the condensation droplets and anything else transmissive refract and reflect the
//      finished interior. The sleeve and the aluminum can end are drawn on top.
// Tone mapping happens once, in layer B.

import * as THREE from 'three';
import { BOTTLE, buildBottle } from './bottle.js';
import { BACKDROP, FLOOR, FLOOR_Y, KEY_LIGHT, METAL_FLOOR_Y, PANELS, ROOM, direction } from './lights.js';

// BACKDROP is the linear radiance of the white backdrop. The tone curve below maps 1.0 to
// display white, so the backdrop (and the floor away from the shadow) come out exactly #FFFFFF.

export const LOOK = {
  exposure: 1.0,
  environmentIntensity: 1.0,
};

// ---------------------------------------------------------------------------------------------
// Tone mapping: Khronos PBR Neutral, rescaled so that linear 1.0 lands on display white.

let toneMappingInstalled = false;
function installToneMapping() {
  if (toneMappingInstalled) return;
  const neutralWhite = 1 - (0.24 * 0.24) / (0.96 + 0.24 - 0.76); // Neutral(1.0)
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
    'vec3 CustomToneMapping( vec3 color ) { return color; }',
    `vec3 CustomToneMapping( vec3 color ) {
	return clamp( NeutralToneMapping( color ) / ${neutralWhite.toFixed(6)}, 0.0, 1.0 );
}`,
  );
  toneMappingInstalled = true;
}

// ---------------------------------------------------------------------------------------------
// Environment: a dark studio with soft boxes, built as geometry and prefiltered with PMREM.

// Grayscale emission pattern for a panel; shade(x, y) gets coordinates in [-1, 1].
function panelTexture(shade) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const b = Math.round(255 * shade((x / (size - 1)) * 2 - 1, (y / (size - 1)) * 2 - 1));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  return t;
}

const smooth = THREE.MathUtils.smoothstep;
const PANEL_SHADES = {
  // Soft box: a diffuser with a hot center and a long, soft roll-off toward the edges.
  box: (x, y) => {
    const edge = (t) => 1 - smooth(Math.abs(t), 0.45, 1.0);
    return edge(x) * edge(y) * (0.85 + 0.15 * (1 - x * x));
  },
  // Strip box: brightest along its center line, falling off toward the long edges.
  strip: (x, y) => Math.exp(-Math.pow(Math.abs(x) / 0.55, 2.4)) * (1 - smooth(Math.abs(y), 0.8, 1.0)),
};

// Panel placed on a sphere around the subject. az: 0 = toward the camera, +90 = camera right,
// 180 = behind the subject. el: degrees above the horizon. w, h: angular size in degrees.
function panel(scene, { az, el, w, h, intensity, map = null, color = [1, 1, 1], dist = 8 }) {
  const a = THREE.MathUtils.degToRad(az);
  const e = THREE.MathUtils.degToRad(el);
  const pw = 2 * dist * Math.tan(THREE.MathUtils.degToRad(w) / 2);
  const ph = 2 * dist * Math.tan(THREE.MathUtils.degToRad(h) / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB(color[0] * intensity, color[1] * intensity, color[2] * intensity, THREE.LinearSRGBColorSpace),
    map,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), mat);
  mesh.position.set(Math.sin(a) * Math.cos(e) * dist, Math.sin(e) * dist, Math.cos(a) * Math.cos(e) * dist);
  mesh.lookAt(0, 0, 0);
  scene.add(mesh);
  return mesh;
}

function buildEnvironment(renderer, floorY) {
  const env = new THREE.Scene();
  const textures = { box: panelTexture(PANEL_SHADES.box), strip: panelTexture(PANEL_SHADES.strip) };

  // Studio walls and ceiling.
  env.add(new THREE.Mesh(
    new THREE.SphereGeometry(20, 64, 32),
    new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(ROOM, ROOM, ROOM * 1.05, THREE.LinearSRGBColorSpace), side: THREE.BackSide }),
  ));
  // White floor.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(19.5, 64),
    new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(FLOOR, FLOOR, FLOOR, THREE.LinearSRGBColorSpace) }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = floorY;
  env.add(floor);

  for (const p of PANELS) panel(env, { ...p, map: p.texture ? textures[p.texture] : null });

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0, 0.1, 100, { size: 512 });
  pmrem.dispose();
  return rt.texture;
}

// ---------------------------------------------------------------------------------------------
// Floor with a soft contact shadow, drawn per shot on a canvas in floor millimeters.

function srgbMix(hexOrRgb, amount) {
  // Mix white toward a color by `amount` (0 = white), returns a CSS rgb() string.
  const c = typeof hexOrRgb === 'string' ? new THREE.Color(hexOrRgb) : hexOrRgb;
  const s = c.clone().convertLinearToSRGB();
  const m = (v) => Math.round(255 * (1 - amount + amount * v));
  return `rgb(${m(s.r)}, ${m(s.g)}, ${m(s.b)})`;
}

function buildFloor(bottles) {
  const margin = 140;
  const xs = bottles.map((b) => b.x), zs = bottles.map((b) => b.z);
  const x0 = Math.min(...xs) - margin, x1 = Math.max(...xs) + margin;
  const z0 = Math.min(...zs) - margin, z1 = Math.max(...zs) + margin;
  const pxPerMM = Math.min(4, 4096 / (x1 - x0), 4096 / (z1 - z0));
  const c = document.createElement('canvas');
  c.width = Math.ceil((x1 - x0) * pxPerMM);
  c.height = Math.ceil((z1 - z0) * pxPerMM);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'multiply';

  const neutral = new THREE.Color().setRGB(0.30, 0.285, 0.27, THREE.LinearSRGBColorSpace);
  for (const b of bottles) {
    const cx = (b.x - x0) * pxPerMM;
    const cy = (b.z - z0) * pxPerMM; // canvas y grows toward the camera (+z)
    const R = BOTTLE.radius * pxPerMM;
    const clear = b.drink.liquid === 'clear';
    const tint = clear ? new THREE.Color(b.drink.color) : neutral;
    const ring = (x, y, stops) => {
      const outer = stops[stops.length - 1][0] * R;
      const grad = g.createRadialGradient(x, y, 0, x, y, outer);
      for (const [r, amount, col] of stops) grad.addColorStop(Math.min(r * R / outer, 1), srgbMix(col ?? neutral, amount));
      g.fillStyle = grad;
      g.fillRect(x - outer, y - outer, outer * 2, outer * 2);
    };
    // Broad soft penumbra, pushed back and right, away from the key light.
    ring(cx + 0.18 * R, cy - 0.32 * R, [[0, clear ? 0.16 : 0.2], [1.1, clear ? 0.13 : 0.16], [1.9, 0.05], [2.9, 0]]);
    // Contact occlusion right at the base. Under a clear drink the floor still gets light
    // focused through the liquid, so only the rim of the base is dark there.
    const under = clear ? 0.28 : 0.62;
    ring(cx, cy, [[0, under], [0.82, under + 0.04], [0.97, 0.5], [1.06, 0.3], [1.22, 0.12], [1.55, 0.03], [2.0, 0]]);
    if (clear) {
      // Light through the liquid: a colored pool inside the shadow, strongest just behind.
      ring(cx + 0.05 * R, cy - 0.55 * R, [[0, 0.3, tint], [0.6, 0.22, tint], [1.15, 0.08, tint], [1.8, 0]]);
    } else {
      ring(cx, cy - 0.2 * R, [[0, 0.1, tint], [1.3, 0.04, tint], [1.8, 0]]);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: new THREE.Color().setRGB(BACKDROP, BACKDROP, BACKDROP, THREE.LinearSRGBColorSpace),
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((x0 + x1) / 2, -0.05, (z0 + z1) / 2);
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Studio: renderer, environment and a reusable shot.

export class Studio {
  constructor(canvas) {
    installToneMapping();
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.CustomToneMapping;
    this.renderer.toneMappingExposure = LOOK.exposure;
    this.environment = buildEnvironment(this.renderer, FLOOR_Y);
    this.metalEnvironment = buildEnvironment(this.renderer, METAL_FLOOR_Y);
    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
  }
}

export class Shot {
  /**
   * @param {Studio} studio
   * @param {{ width: number, height: number }} size  render size in pixels
   */
  constructor(studio, { width, height }) {
    this.studio = studio;
    this.width = width;
    this.height = height;
    this.bottles = [];
    this.sceneA = new THREE.Scene();
    this.sceneB = new THREE.Scene();
    this.sceneA.background = new THREE.Color().setRGB(BACKDROP, BACKDROP, BACKDROP, THREE.LinearSRGBColorSpace);
    const [kx, ky, kz] = direction(KEY_LIGHT.az, KEY_LIGHT.el);
    for (const s of [this.sceneA, this.sceneB]) {
      s.environment = studio.environment;
      s.environmentIntensity = LOOK.environmentIntensity;
      const key = new THREE.DirectionalLight(0xffffff, KEY_LIGHT.intensity);
      key.position.set(kx, ky, kz).multiplyScalar(1000);
      s.add(key);
    }
    this.camera = new THREE.PerspectiveCamera(20, width / height, 10, 20000);
    this.rtA = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: 4,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
    });
    this.sceneB.background = this.rtA.texture;
  }

  /** Adds a bottle for `drink` with its label texture at floor position (x, z). */
  addBottle(drink, labelCanvas, { x = 0, z = 0, rotationY = 0, seed = 7 } = {}) {
    const tex = new THREE.CanvasTexture(labelCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.studio.maxAnisotropy;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    const built = buildBottle(drink, tex, { seed });
    built.outer.traverse((o) => {
      if (o.material && o.material.metalness === 1) o.material.envMap = this.studio.metalEnvironment;
    });
    const entry = { drink, x, z, rotationY, built };
    for (const g of [built.inner, built.outer]) g.position.set(x, 0, z);
    this.sceneA.add(built.inner);
    this.sceneB.add(built.outer);
    this.bottles.push(entry);
    this.setRotation(this.bottles.length - 1, rotationY);
    return entry;
  }

  setRotation(i, rotationY) {
    const b = this.bottles[i];
    b.rotationY = rotationY;
    b.built.inner.rotation.y = rotationY;
    b.built.outer.rotation.y = rotationY;
  }

  /** Turns every bottle so its label front faces the camera (call after frame()). */
  faceCamera() {
    this.bottles.forEach((b, i) => {
      const dx = this.camera.position.x - b.x;
      const dz = this.camera.position.z - b.z;
      this.setRotation(i, Math.atan2(dx, dz));
    });
  }

  addFloor() {
    if (this.floor) this.sceneA.remove(this.floor);
    this.floor = buildFloor(this.bottles);
    this.sceneA.add(this.floor);
  }

  /**
   * Long-lens product framing. The camera sits `elevation` degrees above the horizon and is
   * moved until the bottles fill `heightFraction` of the frame height (or `widthFraction` of
   * the width, whichever binds first), centered.
   */
  frame({ fov = 20, elevation = 9, heightFraction = 0.8, widthFraction = 0.94, centerY = 0, centerX = 0 } = {}) {
    const cam = this.camera;
    cam.fov = fov;
    cam.aspect = this.width / this.height;
    cam.updateProjectionMatrix();
    const pts = [];
    for (const b of this.bottles) {
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        pts.push(new THREE.Vector3(b.x + Math.sin(a) * BOTTLE.radius, 0, b.z + Math.cos(a) * BOTTLE.radius));
        pts.push(new THREE.Vector3(b.x + Math.sin(a) * 29.7, BOTTLE.seamTop, b.z + Math.cos(a) * 29.7));
      }
    }
    const xs = this.bottles.map((b) => b.x);
    const target = new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, BOTTLE.seamTop / 2, 0);
    const e = THREE.MathUtils.degToRad(elevation);
    const dir = new THREE.Vector3(0, Math.sin(e), Math.cos(e));
    let dist = 800;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const v = new THREE.Vector3();
    for (let iter = 0; iter < 30; iter++) {
      cam.position.copy(target).addScaledVector(dir, dist);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        v.copy(p).project(cam);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
      const scale = Math.max((maxY - minY) / (2 * heightFraction), (maxX - minX) / (2 * widthFraction));
      // Recenter, in world units at the target distance.
      const worldPerNdcY = dist * tanHalf;
      const worldPerNdcX = worldPerNdcY * cam.aspect;
      target.y += ((maxY + minY) / 2 - centerY) * worldPerNdcY;
      target.x += ((maxX + minX) / 2 - centerX) * worldPerNdcX;
      dist *= scale;
    }
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    this.cameraTarget = target.clone();
  }

  // Per-instance attenuation for bubbles: light from a bubble reaches the camera through the
  // liquid between it and the front of the bottle.
  updateBubbles() {
    const camPos = this.camera.position;
    const p = new THREE.Vector3(), d = new THREE.Vector3(), col = new THREE.Color();
    for (const b of this.bottles) {
      const mesh = b.built.bubbles;
      if (!mesh) continue;
      const { attenuationColor, attenuationDistance } = b.built.liquid;
      const sigma = [attenuationColor.r, attenuationColor.g, attenuationColor.b].map((c) => -Math.log(Math.max(c, 1e-4)) / attenuationDistance);
      const R = BOTTLE.liquidRadius;
      mesh.userData.points.forEach((pt, i) => {
        p.set(pt.x, pt.y, pt.z).applyMatrix4(mesh.matrixWorld);
        d.copy(camPos).sub(p).normalize();
        // Distance to leave the liquid cylinder (axis at the bottle position) toward the camera.
        const qx = p.x - b.x, qz = p.z - b.z;
        const a = d.x * d.x + d.z * d.z;
        const bb = qx * d.x + qz * d.z;
        const c = qx * qx + qz * qz - R * R;
        let t = a > 1e-8 ? (-bb + Math.sqrt(Math.max(bb * bb - a * c, 0))) / a : 0;
        if (d.y > 1e-4) t = Math.min(t, Math.max(BOTTLE.fillY - p.y, 0) / d.y);
        col.setRGB(Math.exp(-sigma[0] * t), Math.exp(-sigma[1] * t), Math.exp(-sigma[2] * t));
        mesh.setColorAt(i, col);
      });
      mesh.instanceColor.needsUpdate = true;
    }
  }

  updateLiquidUniforms() {
    for (const b of this.bottles) {
      for (const m of [b.built.liquid.side, b.built.liquid.surface]) {
        const u = m.userData.chordUniforms;
        if (u) u.mfAxis.value.set(b.x, 0, b.z);
      }
    }
  }

  render() {
    const r = this.studio.renderer;
    r.setSize(this.width, this.height, false);
    r.toneMappingExposure = LOOK.exposure;
    // Bubble attenuation reads world matrices, which three only refreshes inside render().
    this.sceneA.updateMatrixWorld(true);
    this.sceneB.updateMatrixWorld(true);
    this.updateLiquidUniforms();
    this.updateBubbles();
    r.setRenderTarget(this.rtA);
    r.render(this.sceneA, this.camera);
    r.setRenderTarget(null);
    r.render(this.sceneB, this.camera);
    return this.studio.canvas;
  }

  dispose() {
    this.rtA.dispose();
    const seen = new Set();
    for (const s of [this.sceneA, this.sceneB]) {
      s.traverse((o) => {
        if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          if (seen.has(m)) continue;
          seen.add(m);
          for (const v of Object.values(m)) if (v && v.isTexture && v !== this.studio.environment && v !== this.studio.metalEnvironment) v.dispose();
          m.dispose();
        }
      });
    }
    this.studio.renderer.renderLists.dispose();
  }
}
