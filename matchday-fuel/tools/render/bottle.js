// The Matchday Fuel "bottle can": a clear PET cylinder with an aluminum can end, modeled in
// millimeters with y up and the base resting on y = 0.
//
// buildBottle() returns two groups because the renderer composites in two layers (see
// scene.js):
//   inner  what is seen through the plastic: liquid, bubbles, the inside of the sleeve, the
//          far wall of the bottle
//   outer  what sits on the outside: the plastic wall facing the camera, the printed sleeve,
//          condensation and the can end
// Both groups get the same transform so they stay registered.

import * as THREE from 'three';
import { LABEL } from './label.js';
import { BACKDROP, glints } from './lights.js';

export const BOTTLE = {
  radius: 33, // 66 mm outer diameter
  heelRadius: 5,
  baseDome: 2.6, // how far the domed base is pushed up
  shoulderStart: 147, // straight wall ends here
  neckY: 156.6, // shoulder ends at the 57 mm neck, under the seam
  neckRadius: 28.5,
  seamTop: 160, // base to top of the double seam
  wall: 0.45, // PET wall thickness
  baseThickness: 1.7, // clear PET under the liquid at the base
  fillGap: 14, // liquid sits this far below the top of the seam
  meniscus: 1.15, // height the liquid climbs the wall
  labelBottom: 38,
};
BOTTLE.fillY = BOTTLE.seamTop - BOTTLE.fillGap;
BOTTLE.labelTop = BOTTLE.labelBottom + LABEL.heightMM;
BOTTLE.liquidRadius = BOTTLE.radius - BOTTLE.wall - 0.05;

// ---------------------------------------------------------------------------------------------
// Small deterministic RNG so droplets and bubbles land in the same place on every run.

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Profiles and a lathe that keeps normals and tangents under control.

const ease = (t) => t * t * (3 - 2 * t);

// Profile helpers: arcs and lines as lists of [r, y] points, joined without duplicates.
function arc(cx, cy, radius, a0, a1, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return pts;
}

function line(r0, y0, r1, y1, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([r0 + (r1 - r0) * t, y0 + (y1 - y0) * t]);
  }
  return pts;
}

function join(...parts) {
  const out = [];
  for (const p of parts) {
    for (const pt of p) {
      const last = out[out.length - 1];
      if (last && Math.hypot(last[0] - pt[0], last[1] - pt[1]) < 1e-6) continue;
      out.push(pt);
    }
  }
  return out;
}

// Outer surface of the PET body from the center of the base to the neck under the seam.
function outerProfile() {
  const { radius: R, heelRadius: h, baseDome, shoulderStart, neckY, neckRadius } = BOTTLE;
  const standR = R - h;
  const base = [];
  for (let i = 0; i <= 16; i++) {
    const r = (standR * i) / 16;
    const k = 1 - (r / standR) ** 2;
    base.push([r, baseDome * Math.pow(Math.max(k, 0), 1.6)]);
  }
  const heel = arc(standR, h, h, -Math.PI / 2, 0, 14);
  const wall = line(R, h, R, shoulderStart, 40);
  const shoulder = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    shoulder.push([R + (neckRadius - R) * ease(t), shoulderStart + (neckY - shoulderStart) * t]);
  }
  const neck = line(neckRadius, neckY, neckRadius, neckY + 0.6, 2);
  return join(base, heel, wall, shoulder, neck);
}

// Liquid: follows the inside of the wall from the base up to the fill line, then the meniscus
// curves in to the flat surface. Returned as two profiles so the free surface can have its own
// material.
function liquidProfiles() {
  const R = BOTTLE.liquidRadius;
  const inset = BOTTLE.radius - R;
  const h = BOTTLE.heelRadius - inset;
  const standR = R - h;
  const y0 = BOTTLE.baseThickness; // liquid floor sits on the thick PET base
  const base = [];
  for (let i = 0; i <= 16; i++) {
    const r = (standR * i) / 16;
    const k = 1 - (r / standR) ** 2;
    base.push([r, y0 + BOTTLE.baseDome * Math.pow(Math.max(k, 0), 1.6)]);
  }
  const heel = arc(standR, y0 + h, h, -Math.PI / 2, 0, 14);
  const top = BOTTLE.fillY;
  const wall = line(R, y0 + h, R, top + BOTTLE.meniscus, 40);
  // Meniscus: rises at the wall, flat within ~2.5 mm. Starts at the wall, ends at the center.
  const surface = [];
  for (let i = 0; i <= 18; i++) {
    const t = i / 18; // 0 at wall
    const d = 2.6 * t * t; // distance in from the wall, packed toward the wall
    surface.push([R - d, top + BOTTLE.meniscus * Math.exp(-d / 0.55)]);
  }
  surface.push([R - 6, top], [R - 14, top], [0, top]);
  return { side: join(base, heel, wall), surface: join(surface) };
}

// The can end (lid), from the lower lip of the seam to the center of the panel: rolled double
// seam, chuck wall, countersink, panel radius, flat center panel with a small bead.
function canEndProfile() {
  const y = BOTTLE.seamTop;
  return join(
    line(BOTTLE.neckRadius - 0.05, y - 3.95, 29.05, y - 3.65, 3),
    arc(29.05, y - 3.05, 0.6, -Math.PI / 2, 0, 6), // lower lip of the seam
    line(29.65, y - 3.05, 29.72, y - 0.92, 10), // seam wall, very slightly flared
    arc(28.8, y - 0.92, 0.92, 0, Math.PI, 16), // rolled top of the seam
    line(27.88, y - 0.92, 27.0, y - 4.9, 12), // chuck wall
    arc(26.55, y - 4.9, 0.45, 0, -Math.PI, 10), // countersink groove
    line(26.1, y - 4.9, 25.75, y - 3.9, 5), // panel wall
    arc(25.15, y - 3.9, 0.6, 0, Math.PI / 2, 6), // panel radius
    line(25.15, y - 3.3, 21.6, y - 3.3, 4),
    arc(21.3, y - 3.3, 0.3, 0, Math.PI, 6), // panel bead
    line(21.0, y - 3.3, 0, y - 3.25, 10),
  );
}

/**
 * Builds a lathe (surface of revolution) from a profile of [r, y] points.
 * u runs around the axis (0 at the back, 0.5 facing +z), v along the profile. Normals come from
 * the profile; `flip` reverses them. Tangents point around the axis, which is what the brushed
 * metal's anisotropy follows.
 */
export function lathe(profile, { segments = 128, flip = false } = {}) {
  const n = profile.length;
  // Profile normals by central differences; outward = rotate tangent (dr, dy) by -90 degrees.
  const pnorm = profile.map((p, i) => {
    const a = profile[Math.max(i - 1, 0)];
    const b = profile[Math.min(i + 1, n - 1)];
    let dr = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dr, dy) || 1;
    dr /= len; dy /= len;
    return flip ? [-dy, dr] : [dy, -dr];
  });
  // Arc length for v.
  const lens = [0];
  for (let i = 1; i < n; i++) lens.push(lens[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const total = lens[n - 1] || 1;

  const pos = [], nor = [], uv = [], tan = [], idx = [];
  for (let s = 0; s <= segments; s++) {
    const u = s / segments;
    const theta = (u - 0.5) * Math.PI * 2; // 0 faces +z
    const sin = Math.sin(theta), cos = Math.cos(theta);
    for (let i = 0; i < n; i++) {
      const [r, y] = profile[i];
      pos.push(r * sin, y, r * cos);
      const [nr, ny] = pnorm[i];
      nor.push(nr * sin, ny, nr * cos);
      uv.push(u, lens[i] / total);
      tan.push(cos, 0, -sin, flip ? -1 : 1); // bitangent = cross(n, t) * w runs along +v
    }
  }
  for (let s = 0; s < segments; s++) {
    for (let i = 0; i < n - 1; i++) {
      const a = s * n + i, b = (s + 1) * n + i, c = (s + 1) * n + i + 1, d = s * n + i + 1;
      if (flip) idx.push(a, d, b, b, d, c);
      else idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('tangent', new THREE.Float32BufferAttribute(tan, 4));
  g.setIndex(idx);
  return g;
}

// Open cylinder for the sleeve. Same u convention as lathe(); v = 0 at the bottom edge and 1 at
// the top, which maps the canvas upright (textures are flipped on upload).
function sleeveGeometry(radius, y0, y1, segments = 256) {
  return lathe(line(radius, y0, radius, y1, 2), { segments });
}

// ---------------------------------------------------------------------------------------------
// Materials

function linearColor(hex) {
  return new THREE.Color(hex); // three converts sRGB hex to the linear working space
}

/**
 * Patches a transmissive liquid material so that
 *  - its volume thickness is the real path length of the refracted view ray through the liquid
 *    cylinder, instead of one constant. That makes black coffee near black in the middle and
 *    amber where the path is short.
 *  - the light it transmits comes from where the ray really leaves the bottle. A filled
 *    cylinder is a strong lens: rays near its edges are bent toward the sides of the studio
 *    (the black flags), which gives liquid its dark, defined edges against a white backdrop.
 *    three.js samples the screen behind the object, which on a white backdrop is white
 *    everywhere, so the sample is scaled by the environment radiance in the exit direction
 *    relative to the backdrop.
 */
function patchLiquidChord(material, opts) {
  const uniforms = {
    mfAxis: { value: new THREE.Vector3() },
    mfRadius: { value: BOTTLE.liquidRadius },
    mfFloorY: { value: BOTTLE.baseThickness + 0.4 },
    mfTopY: { value: BOTTLE.fillY },
    mfChordIor: { value: opts.chordIor ?? 1.33 },
    mfExitIor: { value: opts.exitIor ?? 1.34 },
    mfThick: { value: new THREE.Vector2(opts.minThickness ?? 0.4, opts.maxThickness ?? 80) },
    mfMode: { value: opts.mode === 'surface' ? 1 : 0 },
    mfEnvMix: { value: opts.envMix ?? 1 },
    mfBackdrop: { value: BACKDROP },
    mfRayMax: { value: opts.rayMax ?? 9 },
    mfWallY0: { value: BOTTLE.baseThickness + BOTTLE.heelRadius },
  };
  material.userData.chordUniforms = uniforms;
  material.customProgramCacheKey = () => 'mf-liquid-chord';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <transmission_pars_fragment>',
        `#include <transmission_pars_fragment>
uniform vec3 mfAxis;
uniform float mfRadius;
uniform float mfFloorY;
uniform float mfTopY;
uniform float mfChordIor;
uniform float mfExitIor;
uniform vec2 mfThick;
uniform int mfMode;
uniform float mfEnvMix;
uniform float mfBackdrop;
uniform float mfRayMax;
uniform float mfWallY0;
vec3 mfExitDir;
float mfChordFull;
// Path length (mm) of the refracted view ray through the liquid; sets mfExitDir.
float mfChord( vec3 p, vec3 v, vec3 n ) {
  vec3 q = p - mfAxis;
  // On the straight wall use the exact cylinder normal: interpolated vertex normals are
  // faceted, and near the silhouette that shows up as vertical stripes in the exit direction.
  vec3 nn = normalize( n );
  if ( mfMode == 0 && q.y > mfWallY0 && q.y < mfTopY ) nn = normalize( vec3( q.x, 0.0, q.z ) );
  vec3 d = refract( -v, nn, 1.0 / mfChordIor );
  if ( dot( d, d ) < 1e-6 ) d = -v;
  d = normalize( d );
  float a = dot( d.xz, d.xz );
  float tWall = 1e5;
  if ( a > 1e-6 ) {
    float b = dot( q.xz, d.xz );
    float c = dot( q.xz, q.xz ) - mfRadius * mfRadius;
    float disc = b * b - a * c;
    if ( disc > 0.0 ) tWall = ( -b + sqrt( disc ) ) / a;
  }
  float tFloor = d.y < -1e-4 ? max( q.y - mfFloorY, 0.0 ) / -d.y : 1e5;
  float tTop = d.y > 1e-4 ? max( mfTopY - q.y, 0.0 ) / d.y : 1e5;
  float t = max( min( tWall, min( tFloor, tTop ) ), 0.0 );

  // Leave the liquid: refract out through the wall, the base or the surface.
  vec3 e = q + d * t;
  vec3 n2 = vec3( 0.0, 1.0, 0.0 );
  if ( tWall <= tFloor && tWall <= tTop ) n2 = normalize( vec3( e.x, 0.0, e.z ) );
  else if ( tFloor < tTop ) n2 = vec3( 0.0, -1.0, 0.0 );
  vec3 o = refract( d, -n2, mfExitIor );
  if ( dot( o, o ) < 1e-6 ) o = reflect( d, -n2 ); // total internal reflection
  mfExitDir = normalize( o );

  if ( mfMode == 0 ) {
    // Thin wedge of liquid at the meniscus line.
    t *= mix( 0.12, 1.0, smoothstep( -0.6, 1.8, mfTopY - q.y ) );
  } else {
    // The meniscus ring on the free surface is thin where it climbs the wall.
    float r = length( q.xz );
    t *= mix( 0.1, 1.0, smoothstep( 0.0, 1.6, mfRadius - r ) );
  }
  mfChordFull = clamp( t, mfThick.x, mfThick.y );
  // three.js offsets its screen-space sample by the full thickness, which smears whatever is
  // far away on screen into the liquid. Offset by at most mfRayMax and apply the rest of the
  // absorption separately (Beer-Lambert is multiplicative).
  return min( mfChordFull, mfRayMax );
}`,
      )
      .replace(
        '#include <transmission_fragment>',
        THREE.ShaderChunk.transmission_fragment
          .replace(
            'vec3 n = transformNormalByInverseViewMatrix( normal, viewMatrix );',
            `vec3 n = transformNormalByInverseViewMatrix( normal, viewMatrix );
	material.thickness = mfChord( pos, v, n );`,
          )
          .replace(
            'material.transmissionAlpha = mix(',
            `#ifdef USE_ENVMAP
	{
		vec3 mfEnv = textureCubeUV( envMap, envMapRotation * mfExitDir, 0.12 ).rgb * envMapIntensity;
		vec3 mfFactor = clamp( mfEnv / mfBackdrop, 0.0, 2.5 );
		transmitted.rgb *= mix( vec3( 1.0 ), mfFactor, mfEnvMix );
	}
	#endif
	transmitted.rgb *= volumeAttenuation( max( mfChordFull - material.thickness, 0.0 ), material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix(`,
          ),
      );
  };
}

export function liquidMaterials(drink) {
  const color = linearColor(drink.color);
  if (drink.liquid === 'milky') {
    const lighter = color.clone().lerp(new THREE.Color(1, 1, 1), 0.35);
    const side = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.42,
      specularIntensity: 0.25,
      sheen: 0.5,
      sheenRoughness: 0.55,
      sheenColor: lighter,
    });
    const surface = new THREE.MeshPhysicalMaterial({
      color: color.clone().lerp(new THREE.Color(1, 1, 1), 0.08),
      roughness: 0.18,
      specularIntensity: 0.8,
    });
    return { side, surface, transmissive: false };
  }

  const isBlack = drink.liquid === 'black';
  // Beer-Lambert: transmittance = attenuationColor ^ (path / attenuationDistance).
  const attenuationColor = isBlack
    ? new THREE.Color().setRGB(0.30, 0.085, 0.012, THREE.LinearSRGBColorSpace)
    : color.clone();
  const attenuationDistance = isBlack ? 13 : 44;
  const common = {
    color: 0xffffff,
    transmission: 1,
    roughness: 0.0,
    ior: 1.34,
    thickness: 50,
    attenuationColor,
    attenuationDistance,
    depthWrite: false, // so the bubbles inside it can draw over it
  };
  const side = new THREE.MeshPhysicalMaterial({ ...common, specularIntensity: 0.35 });
  const surface = new THREE.MeshPhysicalMaterial({ ...common, specularIntensity: isBlack ? 0.25 : 0.45 });
  const envMix = isBlack ? 0.15 : 1;
  // Black coffee uses the straight-line chord so the path, and the color, thins out toward
  // the silhouette: amber at the edges, near black in the middle.
  patchLiquidChord(side, { mode: 'side', chordIor: isBlack ? 1.0 : 1.33, minThickness: isBlack ? 1.2 : 0.6, envMix });
  patchLiquidChord(surface, { mode: 'surface', chordIor: 1.33, minThickness: isBlack ? 1.2 : 0.6, envMix });
  return { side, surface, transmissive: true, attenuationColor, attenuationDistance };
}

export function plasticMaterial(side = THREE.FrontSide) {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.035,
    transmission: 1,
    ior: 1.57,
    thickness: 0.6,
    specularIntensity: 1,
    clearcoat: 0.35,
    clearcoatRoughness: 0.02,
    side,
  });
}

export function aluminumMaterial({ roughness = 0.3, anisotropy = 0.55 } = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(0.91, 0.92, 0.93, THREE.LinearSRGBColorSpace),
    metalness: 1,
    roughness,
    anisotropy,
    anisotropyRotation: 0,
  });
}

// ---------------------------------------------------------------------------------------------
// Parts

function pullTab() {
  // Flat tab in its own XY plane: nose around the rivet at the origin, finger ring toward +x.
  const s = new THREE.Shape();
  const w = 5.9, nose = -5.2, end = 17.2, r = 5.4;
  s.moveTo(nose + r, -w);
  s.lineTo(end - r, -w);
  s.absarc(end - r, -w + r, r, -Math.PI / 2, 0, false);
  s.lineTo(end, w - r);
  s.absarc(end - r, w - r, r, 0, Math.PI / 2, false);
  s.lineTo(nose + r, w);
  s.absarc(nose + r, w - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(nose, -w + r);
  s.absarc(nose + r, -w + r, r, Math.PI, Math.PI * 1.5, false);
  // Finger hole
  const hole = new THREE.Path();
  const hx0 = 5.4, hx1 = 15.0, hw = 3.9, hr = 3.6;
  hole.moveTo(hx0 + hr, -hw);
  hole.absarc(hx1 - hr, -hw + hr, hr, -Math.PI / 2, 0, false);
  hole.lineTo(hx1, hw - hr);
  hole.absarc(hx1 - hr, hw - hr, hr, 0, Math.PI / 2, false);
  hole.lineTo(hx0 + hr, hw);
  hole.absarc(hx0 + hr, hw - hr, hr, Math.PI / 2, Math.PI, false);
  hole.lineTo(hx0, -hw + hr);
  hole.absarc(hx0 + hr, -hw + hr, hr, Math.PI, Math.PI * 1.5, false);
  s.holes.push(hole);
  // Small U-shaped relief around the rivet.
  const relief = new THREE.Path();
  relief.absarc(0, 0, 2.6, Math.PI * 0.15, Math.PI * 1.85, false);
  relief.absarc(0, 0, 2.15, Math.PI * 1.85, Math.PI * 0.15, true);
  s.holes.push(relief);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.32,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.16,
    bevelSegments: 2,
    curveSegments: 24,
  });
  g.computeVertexNormals();
  return g;
}

function scoreLine() {
  // Teardrop-shaped score that outlines the opening, in front of the rivet (toward +z).
  const pts = [];
  const steps = 80;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    // Teardrop: wide at the front, narrowing toward the rivet.
    const x = Math.sin(a) * (7.2 - 2.2 * Math.cos(a)) * 0.95;
    const z = 9.6 - Math.cos(a) * 6.0;
    pts.push(new THREE.Vector3(x, 0, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true);
  return new THREE.TubeGeometry(curve, 160, 0.14, 6, true);
}

function canEnd(group) {
  const metal = aluminumMaterial({ roughness: 0.17, anisotropy: 0.25 });
  const panelMetal = aluminumMaterial({ roughness: 0.22, anisotropy: 0.08 });
  const profile = canEndProfile();
  const end = new THREE.Mesh(lathe(profile, { segments: 160 }), metal);
  group.add(end);

  const panelY = BOTTLE.seamTop - 3.25;
  // Rivet
  const rivetGeo = new THREE.SphereGeometry(1.5, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  rivetGeo.scale(1, 0.42, 1);
  const rivet = new THREE.Mesh(rivetGeo, panelMetal);
  rivet.position.set(0, panelY + 0.32, -1.6);
  group.add(rivet);

  // Tab: lies flat over the rivet, finger ring toward the back of the bottle.
  const tab = new THREE.Mesh(pullTab(), aluminumMaterial({ roughness: 0.16, anisotropy: 0 }));
  tab.rotation.x = -Math.PI / 2; // shape XY -> XZ, extrude toward +y
  tab.rotation.z = Math.PI / 2; // ring toward -z (back)
  tab.position.set(0, panelY + 0.05, -1.6);
  group.add(tab);

  const score = new THREE.Mesh(scoreLine(), new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(0.55, 0.56, 0.57, THREE.LinearSRGBColorSpace),
    metalness: 1,
    roughness: 0.45,
  }));
  score.position.set(0, panelY - 0.06, -1.6);
  group.add(score);
}

// Condensation: small lens-shaped water droplets on the outside, below the fill line.
function condensation(seed) {
  const rand = rng(seed);
  const geo = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const mat = dropletMaterial();
  const drops = [];
  const add = (count, rMin, rMax, density) => {
    for (let i = 0; i < count; i++) {
      const y = 6.5 + rand() * (BOTTLE.fillY - 3.5 - 6.5);
      const onLabel = y > BOTTLE.labelBottom && y < BOTTLE.labelTop;
      if (onLabel && rand() > density) continue;
      const theta = rand() * Math.PI * 2;
      const r = rMin + (rMax - rMin) * Math.pow(rand(), 2.2);
      drops.push({ theta, y, r, onLabel, squash: 0.42 + rand() * 0.18, stretch: 1 + rand() * 0.25 });
    }
  };
  add(1400, 0.12, 0.3, 0.5); // fine mist
  add(520, 0.3, 0.7, 0.6);
  add(60, 0.7, 1.3, 0.7);

  const mesh = new THREE.InstancedMesh(geo, mat, drops.length);
  const m = new THREE.Matrix4(), s = new THREE.Vector3();
  const X = new THREE.Vector3(0, 1, 0), Y = new THREE.Vector3(), Z = new THREE.Vector3();
  drops.forEach((d, i) => {
    const surfaceR = (d.onLabel ? LABEL.radiusMM : BOTTLE.radius) - 0.03 * d.r;
    const nx = Math.sin(d.theta), nz = Math.cos(d.theta);
    // Hemisphere axes: local y along the surface normal, local x vertical (drops sag a little).
    Y.set(nx, 0, nz);
    Z.crossVectors(X, Y);
    m.makeBasis(X, Y, Z);
    m.scale(s.set(d.r * d.stretch, d.r * d.squash, d.r));
    m.setPosition(nx * surfaceR, d.y, nz * surfaceR);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.renderOrder = 3;
  return mesh;
}

// Water droplet shading. A drop on the bottle is a tiny lens: mostly clear, with a crisp glint
// of each soft box, a dark outline where rays bend away to the dark studio, and a bright
// crescent at the bottom where light from above is focused through it.
const GLINTS_GLSL = () => {
  const g = glints();
  return `const int GLINT_COUNT = ${g.length};
const vec4 GLINTS[${g.length}] = vec4[](${g.map((v) => `vec4(${v.map((x) => x.toFixed(4)).join(', ')})`).join(', ')});`;
};

function dropletMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        mat3 m = mat3( modelMatrix ) * mat3( instanceMatrix );
        vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
        vN = normalize( transpose( inverse( m ) ) * normal );
        vV = normalize( cameraPosition - wp.xyz );
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${GLINTS_GLSL()}
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec3 n = normalize( vN );
        vec3 v = normalize( vV );
        float rim = 1.0 - clamp( dot( n, v ), 0.0, 1.0 );
        vec3 r = reflect( -v, n );
        float spec = 0.0;
        for ( int i = 0; i < GLINT_COUNT; i ++ ) {
          spec += pow( max( dot( r, GLINTS[ i ].xyz ), 0.0 ), 260.0 ) * 9.0 * GLINTS[ i ].w;
        }
        float fres = 0.02 + 0.5 * pow( rim, 4.0 );
        float outline = smoothstep( 0.55, 0.95, rim );
        float lower = smoothstep( 0.05, -0.55, n.y );
        float caustic = lower * smoothstep( 0.2, 0.5, rim ) * ( 1.0 - smoothstep( 0.62, 0.9, rim ) );
        // Premultiplied: dark outline, bright crescent and glints over what is behind.
        vec3 col = vec3( 0.03 ) * outline * 0.45 + vec3( 1.1 ) * caustic * 0.45 + vec3( spec ) + vec3( 0.6 ) * fres * 0.25;
        float a = clamp( outline * 0.45 + caustic * 0.35 + min( spec, 1.0 ) + fres * 0.25, 0.0, 1.0 );
        gl_FragColor = vec4( col, a );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// Carbonation for the energy drinks: clinging to the wall, rising, and a ring at the surface.
function bubbles(drink, seed) {
  const rand = rng(seed);
  const R = BOTTLE.liquidRadius;
  const list = [];
  const push = (r, theta, y, size) => list.push({ x: Math.sin(theta) * r, y, z: Math.cos(theta) * r, size });
  // On the inside of the wall
  for (let i = 0; i < 520; i++) {
    const y = 4 + rand() * (BOTTLE.fillY - 6);
    push(R - 0.15 - rand() * 0.5, rand() * Math.PI * 2, y, 0.1 + Math.pow(rand(), 2.5) * 0.42);
  }
  // Rising through the volume, denser toward the top
  for (let i = 0; i < 260; i++) {
    const y = BOTTLE.fillY - 1 - Math.pow(rand(), 1.8) * (BOTTLE.fillY - 8);
    push(Math.sqrt(rand()) * (R - 1), rand() * Math.PI * 2, y, 0.08 + Math.pow(rand(), 3) * 0.3);
  }
  // Ring of fine bubbles where the surface meets the wall
  for (let i = 0; i < 300; i++) {
    push(R - 0.25 - rand() * 1.1, rand() * Math.PI * 2, BOTTLE.fillY + 0.05 + rand() * 0.35, 0.09 + rand() * 0.22);
  }
  const geo = new THREE.SphereGeometry(1, 12, 8);
  const mesh = new THREE.InstancedMesh(geo, bubbleMaterial(drink), list.length);
  const m = new THREE.Matrix4();
  list.forEach((b, i) => {
    m.makeScale(b.size, b.size, b.size).setPosition(b.x, b.y, b.z);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, new THREE.Color(1, 1, 1));
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.userData.points = list;
  mesh.renderOrder = 5;
  return mesh;
}

function bubbleMaterial(drink) {
  const tint = linearColor(drink.color);
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTint: { value: tint } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vAtten;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
        vN = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * normal );
        vV = normalize( cameraPosition - wp.xyz );
        vAtten = instanceColor;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${GLINTS_GLSL()}
      uniform vec3 uTint;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vAtten;
      void main() {
        vec3 n = normalize( vN );
        vec3 v = normalize( vV );
        float ndv = clamp( dot( n, v ), 0.0, 1.0 );
        float rim = 1.0 - ndv;
        // Dark outline where the bubble bends light away, a bright inner ring, a clear center.
        float ring = smoothstep( 0.45, 0.95, rim );
        float inner = exp( -pow( ( rim - 0.62 ) / 0.1, 2.0 ) );
        vec3 col = uTint * 0.18 * ( 1.0 - inner ) + vec3( 1.5 ) * inner;
        float a = max( ring * 0.85, inner * 0.55 );
        col = mix( vec3( 1.15 ), col, smoothstep( 0.0, 0.3, rim ) );
        a = max( a, 0.12 );
        // Glints from the soft boxes.
        vec3 r = reflect( -v, n );
        float g = 0.0;
        for ( int i = 0; i < GLINT_COUNT; i ++ ) {
          g += pow( max( dot( r, GLINTS[ i ].xyz ), 0.0 ), 120.0 ) * 6.0 * GLINTS[ i ].w;
        }
        col += vec3( g );
        a = clamp( max( a, g ), 0.0, 1.0 );
        // Bubbles deeper in the liquid are seen through it: tinted and fainter.
        float seen = pow( dot( vAtten, vec3( 0.3333 ) ), 1.5 );
        gl_FragColor = vec4( col * vAtten, a * seen );
      }`,
  });
}

// ---------------------------------------------------------------------------------------------

/**
 * Builds one bottle. `labelTexture` is a THREE.Texture of drawLabel()'s canvas.
 */
export function buildBottle(drink, labelTexture, { seed = 7 } = {}) {
  const inner = new THREE.Group();
  const outer = new THREE.Group();
  inner.name = `${drink.key}-inner`;
  outer.name = `${drink.key}-outer`;

  const shellGeo = lathe(outerProfile(), { segments: 192 });

  // Far wall of the bottle, seen from inside (inner layer).
  const backWall = new THREE.Mesh(shellGeo, plasticMaterial(THREE.BackSide));
  backWall.renderOrder = 0;
  inner.add(backWall);

  // Liquid
  const liquid = liquidMaterials(drink);
  const { side, surface } = liquidProfiles();
  const liquidSide = new THREE.Mesh(lathe(side, { segments: 192 }), liquid.side);
  const liquidTop = new THREE.Mesh(lathe(surface, { segments: 192, flip: false }), liquid.surface);
  liquidSide.renderOrder = 1;
  liquidTop.renderOrder = 1;
  inner.add(liquidSide, liquidTop);

  let bubbleMesh = null;
  if (drink.liquid === 'clear') {
    bubbleMesh = bubbles(drink, seed * 31 + 5);
    inner.add(bubbleMesh);
  }

  // Inside of the sleeve: the white back of the print, seen through the liquid.
  const sleeveInside = new THREE.Mesh(
    sleeveGeometry(LABEL.radiusMM - 0.02, BOTTLE.labelBottom, BOTTLE.labelTop),
    // Lit mostly by light coming through the bottle, so it reads close to white.
    new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.86, 0.85, 0.83, THREE.LinearSRGBColorSpace), side: THREE.BackSide }),
  );
  inner.add(sleeveInside);

  // Outer layer --------------------------------------------------------------------------
  const front = new THREE.Mesh(shellGeo, plasticMaterial(THREE.FrontSide));
  front.renderOrder = 2;
  outer.add(front);

  labelTexture.colorSpace = THREE.SRGBColorSpace;
  const sleeve = new THREE.Mesh(
    sleeveGeometry(LABEL.radiusMM, BOTTLE.labelBottom, BOTTLE.labelTop),
    new THREE.MeshPhysicalMaterial({
      map: labelTexture,
      roughness: 0.42,
      specularIntensity: 0.55,
      clearcoat: 1,
      clearcoatRoughness: 0.07,
    }),
  );
  outer.add(sleeve);

  outer.add(condensation(seed * 17 + 3));
  canEnd(outer);

  return { drink, inner, outer, liquid, bubbles: bubbleMesh };
}

export const _internal = { outerProfile, liquidProfiles, canEndProfile };
