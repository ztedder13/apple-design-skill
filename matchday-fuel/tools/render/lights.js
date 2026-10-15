// The studio: where the soft boxes and flags sit around the subject. scene.js builds the
// reflection environment from this list; bottle.js uses the bright ones for the glints on
// bubbles and condensation, so every highlight comes from the same lights.
//
// az: degrees around the subject, 0 = toward the camera, +90 = camera right, 180 = behind.
// el: degrees above the horizon. w, h: angular size in degrees. intensity: linear radiance
// (the backdrop is 1.02, which the tone curve maps to pure white).
// texture: 'box' (flat diffuser, soft edges), 'strip' (bright center line), or none.
// dist: how far the panel sits from the subject. Panels must stay above the floor (FLOOR_Y):
// a panel cut off by the floor ends its reflection partway down the bottle.

export const BACKDROP = 1.02;

export const PANELS = [
  // Seamless white backdrop behind the subject; below the horizon it meets the white floor.
  { name: 'backdrop', az: 180, el: 8, w: 80, h: 60, intensity: BACKDROP, dist: 10 },
  // Dark flags behind each side: they give clear plastic and liquid dark, defined edges.
  { name: 'flag-left', az: -128, el: 10, w: 24, h: 90, intensity: 0.18, dist: 7 },
  { name: 'flag-right', az: 128, el: 10, w: 24, h: 90, intensity: 0.18, dist: 7 },
  // Strip boxes at the sides: long vertical highlights near both edges.
  { name: 'strip-left', az: -99, el: 6, w: 9, h: 72, intensity: 14, texture: 'strip', dist: 6, glint: 1.0 },
  { name: 'strip-right', az: 98, el: 6, w: 8, h: 72, intensity: 9, texture: 'strip', dist: 6, glint: 0.7 },
  // Key: soft box front left and above, with a brighter core for the front highlight.
  { name: 'key', az: -44, el: 22, w: 32, h: 42, intensity: 2.2, texture: 'box', dist: 6 },
  { name: 'key-core', az: -36, el: 16, w: 10, h: 56, intensity: 9, texture: 'strip', dist: 5.5, glint: 1.2 },
  // Fill: front right, larger and dimmer.
  { name: 'fill', az: 50, el: 10, w: 36, h: 38, intensity: 1.4, texture: 'box', dist: 6 },
  // Overhead box for the can end and the shoulder.
  { name: 'top', az: 0, el: 76, w: 56, h: 44, intensity: 3.2, texture: 'box', dist: 6, glint: 0.5 },
  // Large dim card above the camera: lifts the can end and the tops of the shoulders.
  { name: 'front-card', az: 0, el: 24, w: 70, h: 30, intensity: 0.3, texture: 'box', dist: 6 },
];

export const ROOM = 0.05; // studio walls and ceiling
export const FLOOR = 1.0; // white floor, lit like the backdrop
// Floor height in the environment (panels sit 5.5 to 10 units away). Low, so the area just
// below the horizon in front of the bottle stays dark and the clear plastic keeps its contrast.
export const FLOOR_Y = -6;
// The aluminum can end gets its own reflection map with the floor's horizon raised, the way a
// white sweep reaches toward the camera; otherwise the vertical seam only sees the dark studio.
export const METAL_FLOOR_Y = -3.2;

// Direct light for diffuse shading of the label and the milky liquids. It adds little to the
// reflections of the clear plastic, which come from PANELS.
export const KEY_LIGHT = { az: -40, el: 32, intensity: 1.1 };

export function direction(az, el) {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

// The panels that make glints on small spheres: [x, y, z, strength].
export function glints() {
  return PANELS.filter((p) => p.glint).map((p) => [...direction(p.az, p.el), p.glint]);
}
