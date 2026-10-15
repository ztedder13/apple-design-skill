// Page entry for render.html. Exposes window.MF, which render.mjs drives through Playwright.
// Every call returns a PNG data URL of the supersampled frame; encode.py downsamples it.

import { DRINKS, OUTPUTS, drinkByKey } from './drinks.js';
import { drawLabel, FONT_FACES, fontString } from './label.js';
import { LOOK, Shot, Studio } from './scene.js';

const canvas = document.getElementById('stage');
let studio = null;
const logos = new Map();
const labels = new Map();

async function ensureFonts() {
  await Promise.all(FONT_FACES.map((f) => document.fonts.load(fontString(f, 48), 'MATCHDAY FUEL 0123')));
  await document.fonts.ready;
  const loaded = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Archivo' && f.status === 'loaded');
  if (loaded.length === 0) throw new Error('Archivo did not load from Google Fonts (no loaded FontFace).');
  // Confirm by metrics: Archivo must differ from the fallback, and the wdth axis must work.
  const ctx = document.createElement('canvas').getContext('2d');
  const width = (font) => { ctx.font = font; return ctx.measureText('MATCHDAY FUEL').width; };
  const archivo = width('900 normal 48px Archivo');
  const fallback = width('900 normal 48px monospace');
  const wide = width('900 expanded 48px Archivo');
  if (Math.abs(archivo - fallback) < 1) throw new Error('Archivo measured like the fallback font; it did not load.');
  if (wide < archivo * 1.08) throw new Error(`Archivo width axis not applied (expanded ${wide.toFixed(1)} vs normal ${archivo.toFixed(1)}).`);
  return { faces: loaded.length, archivo, wide };
}

async function loadLogo(sport) {
  if (!logos.has(sport)) {
    const img = new Image();
    img.src = `/tools/logos/out/sport-${sport}.png`;
    try {
      await img.decode();
    } catch {
      throw new Error(`Missing logo master tools/logos/out/sport-${sport}.png. Run \`npm run logos\` first.`);
    }
    logos.set(sport, img);
  }
  return logos.get(sport);
}

async function labelFor(drink) {
  if (!labels.has(drink.key)) labels.set(drink.key, drawLabel(drink, await loadLogo(drink.sport)));
  return labels.get(drink.key);
}

function png() {
  return canvas.toDataURL('image/png');
}

const FRAMING = { fov: 20, elevation: 15, heightFraction: 0.8 };
let sequence = null;

window.MF = {
  async init() {
    const fonts = await ensureFonts();
    studio = new Studio(canvas);
    const gl = studio.renderer.getContext();
    return { fonts, webgl2: gl instanceof WebGL2RenderingContext, maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
  },

  drinks: () => DRINKS.map((d) => d.key),

  async label(key) {
    const c = await labelFor(drinkByKey(key));
    return c.toDataURL('image/png');
  },

  // Product shot: one bottle, label front to camera.
  async still(key, { scale = 2 } = {}) {
    const drink = drinkByKey(key);
    const { width, height } = OUTPUTS.still;
    const shot = new Shot(studio, { width: width * scale, height: height * scale });
    shot.addBottle(drink, await labelFor(drink));
    shot.frame(FRAMING);
    shot.addFloor();
    shot.render();
    const out = png();
    shot.dispose();
    return out;
  },

  // All ten in one row, cold brews left, Lotus right, table order.
  async lineup({ scale = 2, spacing = 78, groupGap = 20 } = {}) {
    const { width, height } = OUTPUTS.lineup;
    const shot = new Shot(studio, { width: width * scale, height: height * scale });
    const xs = [];
    let x = 0;
    DRINKS.forEach((d, i) => {
      if (i > 0) x += spacing + (d.line !== DRINKS[i - 1].line ? groupGap : 0);
      xs.push(x);
    });
    const mid = (xs[0] + xs[xs.length - 1]) / 2;
    for (const [i, d] of DRINKS.entries()) {
      shot.addBottle(d, await labelFor(d), { x: xs[i] - mid, z: 0, seed: 11 + i });
    }
    shot.frame({ fov: 13, elevation: 11, heightFraction: 0.74, widthFraction: 0.955 });
    shot.faceCamera();
    shot.addFloor();
    shot.render();
    const out = png();
    shot.dispose();
    return out;
  },

  // 360-degree turn: build once, then render one frame per angle.
  async sequenceStart(key, { scale = 2 } = {}) {
    const drink = drinkByKey(key);
    const { width, height } = OUTPUTS.sequence;
    sequence = new Shot(studio, { width: width * scale, height: height * scale });
    sequence.addBottle(drink, await labelFor(drink));
    sequence.frame(FRAMING);
    sequence.addFloor();
    return true;
  },

  sequenceFrame(degrees) {
    sequence.setRotation(0, (degrees * Math.PI) / 180);
    sequence.render();
    return png();
  },

  sequenceEnd() {
    sequence?.dispose();
    sequence = null;
    return true;
  },

  setLook(look) {
    Object.assign(LOOK, look);
    return { ...LOOK };
  },
};

window.MF.ready = true;
