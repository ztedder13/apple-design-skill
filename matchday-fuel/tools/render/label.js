// Printed shrink-sleeve label, drawn on a 2D canvas and wrapped around the bottle.
//
// The canvas is the flattened sleeve: x runs once around the bottle (u = x / width) and y runs
// from the top edge of the sleeve to the bottom. u = 0.5 is the front panel (it faces the camera
// when the bottle's rotation is 0), u = 0.25 the left side, u = 0.75 the right side, and u = 0 / 1
// the back, where the sleeve's seam is.
//
// All layout is in millimeters on the real sleeve and converted with PX_PER_MM.

import { LINES, VOLUME_TEXT } from './drinks.js';

export const LABEL = {
  heightMM: 70,
  radiusMM: 33.15, // sleeve sits just proud of the 66 mm bottle wall
  pxPerMM: 20,
};
LABEL.circumferenceMM = 2 * Math.PI * LABEL.radiusMM;

const INK = '#1C130C'; // brand ink: black with a little coffee in it
const PAPER = '#FFFFFF';
const FONT_FAMILY = 'Archivo';

// The weights and widths the label uses. render.html loads Archivo from Google Fonts; main.js
// awaits these faces and refuses to render if any of them fell back to another font.
export const FONT_FACES = [
  { weight: 900, stretch: 'expanded' },
  { weight: 800, stretch: 'expanded' },
  { weight: 700, stretch: 'expanded' },
  { weight: 800, stretch: 'semi-expanded' },
  { weight: 800, stretch: 'normal' },
  { weight: 700, stretch: 'normal' },
  { weight: 600, stretch: 'normal' },
];

export function fontString({ weight, stretch }, px) {
  return `${weight} ${stretch} ${px}px ${FONT_FAMILY}`;
}

// ---------------------------------------------------------------------------------------------
// Color helpers

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

function hslToHex({ h, s, l }) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// A darker, still clearly colored shade of the drink color for the flavor callout. Light
// colors (mango, peach) come down a long way so the text has contrast on white; colors that are
// already dark (black coffee) stay dark.
export function darkerShade(hex) {
  const hsl = rgbToHsl(hexToRgb(hex));
  const l = Math.min(hsl.l * 0.72, 0.34);
  const s = Math.min(1, hsl.s * 1.05);
  return hslToHex({ h: hsl.h, s, l });
}

// ---------------------------------------------------------------------------------------------
// Text fitting

const capCache = new Map();
// Cap height as a fraction of the font size, measured from the loaded font.
function capRatio(ctx, face) {
  const k = `${face.weight}/${face.stretch}`;
  if (!capCache.has(k)) {
    ctx.save();
    ctx.font = fontString(face, 200);
    const m = ctx.measureText('H');
    ctx.restore();
    capCache.set(k, m.actualBoundingBoxAscent / 200);
  }
  return capCache.get(k);
}

function measure(ctx, text, face, px, trackingEm = 0) {
  ctx.save();
  ctx.font = fontString(face, px);
  ctx.letterSpacing = `${trackingEm * px}px`;
  // letterSpacing adds space after the last glyph too; remove it so centering is exact.
  const w = ctx.measureText(text).width - trackingEm * px;
  ctx.restore();
  return w;
}

// Splits text into one or two lines at spaces, or after a hyphen (keeping the hyphen).
function lineOptions(text) {
  const options = [{ lines: [text], penalty: 1 }];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') options.push({ lines: [text.slice(0, i), text.slice(i + 1)], penalty: 1 });
    if (text[i] === '-' && i < text.length - 1) options.push({ lines: [text.slice(0, i + 1), text.slice(i + 1)], penalty: 0.85 });
  }
  return options;
}

// Finds the largest setting of `text` that fits a box, trying one or two lines and a few font
// widths. Returns { face, px, lines, capPx, lineGapPx }.
function fitBlock(ctx, text, box, { faces, trackingEm = 0, maxLines = 2, lineGap = 0.32, preferWide = 0.9, preferOneLine = 1.06 }) {
  let best = null;
  for (const { lines, penalty } of lineOptions(text)) {
    if (lines.length > maxLines) continue;
    faces.forEach((face, faceIndex) => {
      const cap = capRatio(ctx, face);
      // Height limit: n * cap + (n - 1) * gap * cap <= box.h
      const n = lines.length;
      const capFromHeight = box.h / (n + (n - 1) * lineGap);
      const widest = Math.max(...lines.map((l) => measure(ctx, l, face, 100, trackingEm) / 100));
      const capFromWidth = (box.w / widest) * cap;
      const capPx = Math.min(capFromHeight, capFromWidth, box.maxCap ?? Infinity);
      // Prefer wider faces, one line and breaks at spaces unless another setting is clearly bigger.
      const score = capPx * penalty * Math.pow(preferWide, faceIndex) * (n === 1 ? preferOneLine : 1);
      if (!best || score > best.score) {
        best = { score, face, px: capPx / cap, capPx, lines, lineGapPx: capPx * lineGap };
      }
    });
  }
  return best;
}

// Draws a fitted block centered on cx, vertically centered in [top, top + h].
function drawBlock(ctx, block, cx, top, h, color, trackingEm = 0) {
  const { face, px, capPx, lines, lineGapPx } = block;
  const total = lines.length * capPx + (lines.length - 1) * lineGapPx;
  let y = top + (h - total) / 2 + capPx;
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = fontString(face, px);
  ctx.letterSpacing = `${trackingEm * px}px`;
  ctx.textBaseline = 'alphabetic';
  for (const line of lines) {
    const w = measure(ctx, line, face, px, trackingEm);
    ctx.fillText(line, cx - w / 2, y);
    y += capPx + lineGapPx;
  }
  ctx.restore();
  return { top: top + (h - total) / 2, bottom: top + (h + total) / 2 };
}

// Single line at a given cap height (mm), tracked, centered.
function drawLine(ctx, text, cx, capTopPx, capPx, face, color, trackingEm = 0) {
  const px = capPx / capRatio(ctx, face);
  const w = measure(ctx, text, face, px, trackingEm);
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = fontString(face, px);
  ctx.letterSpacing = `${trackingEm * px}px`;
  ctx.fillText(text, cx - w / 2, capTopPx + capPx);
  ctx.restore();
  return w;
}

// ---------------------------------------------------------------------------------------------
// The sleeve

/**
 * Draws the sleeve for one drink.
 * @param {object} drink  row from drinks.js
 * @param {CanvasImageSource} logo  the sport logo master for drink.sport (1254 px, white ground)
 * @returns {HTMLCanvasElement}
 */
export function drawLabel(drink, logo) {
  const S = LABEL.pxPerMM;
  const W = Math.round(LABEL.circumferenceMM * S);
  const H = Math.round(LABEL.heightMM * S);
  const mm = (v) => v * S;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const accent = drink.color;
  const accentDark = darkerShade(drink.color);
  const lineLabel = LINES[drink.line].label;
  const name = drink.name.toUpperCase();
  const flavor = drink.flavor.toUpperCase();
  const sport = drink.sport.toUpperCase();

  // Paper
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // Bands of drink color along the top and bottom edges, with a hairline of the darker shade.
  const band = mm(3.2);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, band);
  ctx.fillRect(0, H - band, W, band);
  ctx.fillStyle = accentDark;
  ctx.fillRect(0, band, W, mm(0.25));
  ctx.fillRect(0, H - band - mm(0.25), W, mm(0.25));

  // Front panel ----------------------------------------------------------------------------
  const fx = W * 0.5;

  // Sport logo: the 1254 px master on its white ground. The painted ring is about 30 mm across
  // and its splashes reach about 34 mm.
  const logoSize = mm(35.5);
  const logoTop = mm(3.7);
  ctx.drawImage(logo, fx - logoSize / 2, logoTop, logoSize, logoSize);

  // Drink name: wide, heavy, as large as the box allows on one or two lines. The box stays
  // within about 40 degrees either side of center so the name reads on the curved front.
  const nameBox = { w: mm(44), h: mm(11), maxCap: mm(6.4) };
  const nameBlock = fitBlock(ctx, name, nameBox, {
    faces: [{ weight: 900, stretch: 'expanded' }, { weight: 900, stretch: 'semi-expanded' }],
    trackingEm: 0.01,
    lineGap: 0.28,
  });
  drawBlock(ctx, nameBlock, fx, mm(39.9), nameBox.h, INK, 0.01);

  // Flavor callout: one line in the darker shade, between two short rules in the drink color.
  const flavorBox = { w: mm(44), h: mm(3.0), maxCap: mm(3.0) };
  const flavorBlock = fitBlock(ctx, flavor, flavorBox, {
    faces: [{ weight: 800, stretch: 'expanded' }, { weight: 800, stretch: 'semi-expanded' }, { weight: 800, stretch: 'normal' }],
    trackingEm: 0.04,
    maxLines: 1,
    preferWide: 0.95,
  });
  const flavorTop = mm(53.3);
  drawBlock(ctx, flavorBlock, fx, flavorTop, flavorBox.h, accentDark, 0.04);
  {
    const textW = measure(ctx, flavorBlock.lines[0], flavorBlock.face, flavorBlock.px, 0.04);
    const gap = mm(1.5);
    const ruleLen = Math.min(mm(4.2), (mm(56) - textW) / 2 - gap);
    if (ruleLen > mm(1.2)) {
      const y = flavorTop + flavorBox.h / 2 - mm(0.22);
      ctx.fillStyle = accent;
      ctx.fillRect(fx - textW / 2 - gap - ruleLen, y, ruleLen, mm(0.45));
      ctx.fillRect(fx + textW / 2 + gap, y, ruleLen, mm(0.45));
    }
  }

  // Product line, small and tracked, then the volume.
  drawLine(ctx, lineLabel, fx, mm(58.9), mm(2.0), { weight: 700, stretch: 'expanded' }, INK, 0.16);
  drawLine(ctx, VOLUME_TEXT, fx, mm(62.5), mm(1.85), { weight: 700, stretch: 'normal' }, INK, 0.08);

  // Right side panel (u = 0.75): caffeine and sport. Kept within about 15 mm of its center
  // so it never crowds the front panel.
  const rx = W * 0.75;
  drawLine(ctx, 'CAFFEINE', rx, mm(22.6), mm(1.8), { weight: 700, stretch: 'expanded' }, INK, 0.2);
  drawLine(ctx, `${drink.caffeine} MG`, rx, mm(26.0), mm(5.0), { weight: 900, stretch: 'expanded' }, INK, 0.0);
  ctx.fillStyle = accent;
  ctx.fillRect(rx - mm(6), mm(33.6), mm(12), mm(0.45));
  drawLine(ctx, sport, rx, mm(36.2), mm(2.5), { weight: 800, stretch: 'expanded' }, accentDark, 0.16);
  drawLine(ctx, lineLabel, rx, mm(41.2), mm(1.45), { weight: 700, stretch: 'normal' }, INK, 0.14);

  // Left side panel (u = 0.25): the wordmark.
  const lx = W * 0.25;
  drawLine(ctx, 'MATCHDAY', lx, mm(25.0), mm(3.9), { weight: 900, stretch: 'expanded' }, INK, 0.0);
  const fuelW = drawLine(ctx, 'FUEL', lx, mm(30.4), mm(3.2), { weight: 900, stretch: 'expanded' }, INK, 0.42);
  ctx.fillStyle = INK;
  const ruleY = mm(30.4) + mm(3.2) / 2 - mm(0.22);
  ctx.fillRect(lx - fuelW / 2 - mm(6.2), ruleY, mm(4.4), mm(0.45));
  ctx.fillRect(lx + fuelW / 2 + mm(1.8), ruleY, mm(4.4), mm(0.45));
  drawLine(ctx, 'COLD BREW + ENERGY', lx, mm(36.0), mm(1.5), { weight: 700, stretch: 'expanded' }, INK, 0.16);
  ctx.fillStyle = accent;
  ctx.fillRect(lx - mm(3.5), mm(40.0), mm(7), mm(0.45));

  // Back (u = 0 and 1, the sleeve seam): a small info panel, drawn on both edges of the canvas
  // so it wraps across the seam. Seen in the 360-degree turn.
  const backName = fitBlock(ctx, name, { w: mm(34), h: mm(7.4), maxCap: mm(3.4) }, {
    faces: [{ weight: 900, stretch: 'expanded' }, { weight: 900, stretch: 'semi-expanded' }],
    trackingEm: 0.01,
    lineGap: 0.3,
  });
  const backFlavor = fitBlock(ctx, flavor, { w: mm(34), h: mm(2.2), maxCap: mm(2.2) }, {
    faces: [{ weight: 800, stretch: 'expanded' }, { weight: 800, stretch: 'semi-expanded' }, { weight: 800, stretch: 'normal' }],
    trackingEm: 0.05,
    maxLines: 1,
    preferWide: 0.95,
  });
  for (const bx of [0, W]) {
    drawLine(ctx, 'MATCHDAY FUEL', bx, mm(22.2), mm(1.6), { weight: 800, stretch: 'expanded' }, INK, 0.24);
    drawBlock(ctx, backName, bx, mm(25.8), mm(7.4), INK, 0.01);
    drawBlock(ctx, backFlavor, bx, mm(35.0), mm(2.2), accentDark, 0.05);
    ctx.fillStyle = accent;
    ctx.fillRect(bx - mm(5), mm(39.4), mm(10), mm(0.45));
    drawLine(ctx, lineLabel, bx, mm(42.0), mm(1.6), { weight: 700, stretch: 'expanded' }, INK, 0.16);
    drawLine(ctx, VOLUME_TEXT, bx, mm(45.4), mm(1.55), { weight: 700, stretch: 'normal' }, INK, 0.08);
  }

  return canvas;
}
