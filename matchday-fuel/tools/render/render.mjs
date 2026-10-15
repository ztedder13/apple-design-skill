#!/usr/bin/env node
// Regenerates every drink image in the SPEC asset contract:
//   public/assets/drinks/{key}.webp (1200x1500) and {key}-600.webp
//   public/assets/lineup.webp (2400x1000) and lineup-1200.webp
//   public/assets/sequence/golden-boot/000.webp ... 071.webp (1000x1250), plus 720/ (720x900)
//
// How: a small static server serves the project, headless Chromium (Playwright, SwiftShader
// WebGL2) opens tools/render/render.html, which renders each shot with three.js at 2x and
// returns a PNG. Those land in tools/render/out/ (git-ignored) and encode.py (Pillow)
// downsamples them and writes WebP.
//
// Usage: npm run render [-- options]
//   --only=key,key     stills for these drinks only
//   --skip-stills --skip-lineup --skip-sequence
//   --frames=0,18,36   render only these sequence frame indexes
//   --labels           also write flat label PNGs to tools/render/out/labels/
//   --scale=2          supersampling factor
//   --png-only         leave the PNGs in tools/render/out/ and skip writing WebP
//
// Needs: devDependencies installed (three, playwright), a Chromium for Playwright
// (`npx playwright install chromium` if none is set up), Python 3 with Pillow, the logo masters
// in tools/logos/out/ (`npm run logos`), and network access to fonts.googleapis.com.

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { DRINKS, OUTPUTS } from './drinks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(HERE, 'out');
const ASSETS = path.join(ROOT, 'public', 'assets');

const QUALITY = { still: 82, sequence: 72 };
const SEQUENCE_MAX_BYTES = 80 * 1024;

// ---------------------------------------------------------------------------------------------
// Options

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const scale = Number(args.scale ?? 2);
const onlyKeys = args.only ? String(args.only).split(',') : null;
const frameFilter = args.frames ? new Set(String(args.frames).split(',').map(Number)) : null;

// ---------------------------------------------------------------------------------------------
// Static server for the project root (ES modules do not load from file://).

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.css': 'text/css',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
      if (!file.startsWith(ROOT + path.sep)) throw Object.assign(new Error('outside root'), { code: 403 });
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(err.code === 403 ? 403 : 404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------------------------
// Playwright

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (err) {
    // Fall back to a globally installed copy.
    try {
      const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
      const require = createRequire(path.join(globalRoot, 'noop.js'));
      return require('playwright');
    } catch {
      throw new Error(`Playwright is not installed. Run \`npm install\` in ${ROOT}. (${err.message})`);
    }
  }
}

async function launch() {
  const { chromium } = await loadPlaywright();
  // Route Google Fonts through the HTTPS proxy when there is one, but never the local server.
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyServer) process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    proxy: proxyServer ? { server: proxyServer, bypass: '127.0.0.1,localhost' } : undefined,
  });
  return browser;
}

// ---------------------------------------------------------------------------------------------

async function writeDataUrl(dataUrl, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

function encode(jobs) {
  if (jobs.length === 0 || args['png-only']) return;
  const manifest = path.join(OUT, 'manifest.json');
  return fs.writeFile(manifest, JSON.stringify(jobs, null, 1)).then(() => {
    const r = spawnSync('python3', [path.join(HERE, 'encode.py'), manifest], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('encode.py failed');
  });
}

const seconds = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function main() {
  for (const sport of new Set(DRINKS.map((d) => d.sport))) {
    const master = path.join(ROOT, 'tools', 'logos', 'out', `sport-${sport}.png`);
    if (!existsSync(master)) throw new Error(`Missing ${path.relative(ROOT, master)}. Run \`npm run logos\` first.`);
  }
  await fs.mkdir(OUT, { recursive: true });

  const server = await startServer();
  const port = server.address().port;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text()); });

  try {
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/tools/render/render.html`);
    await page.waitForFunction(() => window.MF && window.MF.ready === true, null, { timeout: 60000 });
    const info = await page.evaluate(() => window.MF.init());
    console.log(`stage ready in ${seconds(t0)}:`, JSON.stringify(info));

    if (args.labels) {
      for (const d of DRINKS) {
        await writeDataUrl(await page.evaluate((k) => window.MF.label(k), d.key), path.join(OUT, 'labels', `${d.key}.png`));
      }
      console.log('labels written to', path.relative(ROOT, path.join(OUT, 'labels')));
    }

    // Stills
    if (!args['skip-stills']) {
      const jobs = [];
      for (const d of DRINKS) {
        if (onlyKeys && !onlyKeys.includes(d.key)) continue;
        const t = Date.now();
        const src = path.join(OUT, 'drinks', `${d.key}.png`);
        await writeDataUrl(await page.evaluate(([k, s]) => window.MF.still(k, { scale: s }), [d.key, scale]), src);
        console.log(`still ${d.key} ${seconds(t)}`);
        const { width, height, small } = OUTPUTS.still;
        jobs.push({
          src,
          outputs: [
            { path: path.join(ASSETS, 'drinks', `${d.key}.webp`), width, height, quality: QUALITY.still },
            { path: path.join(ASSETS, 'drinks', `${d.key}-600.webp`), width: small.width, height: small.height, quality: QUALITY.still },
          ],
        });
      }
      await encode(jobs);
    }

    // Lineup
    if (!args['skip-lineup'] && !onlyKeys) {
      const t = Date.now();
      const src = path.join(OUT, 'lineup.png');
      await writeDataUrl(await page.evaluate((s) => window.MF.lineup({ scale: s }), scale), src);
      console.log(`lineup ${seconds(t)}`);
      const { width, height, small } = OUTPUTS.lineup;
      await encode([{
        src,
        outputs: [
          { path: path.join(ASSETS, 'lineup.webp'), width, height, quality: QUALITY.still },
          { path: path.join(ASSETS, 'lineup-1200.webp'), width: small.width, height: small.height, quality: QUALITY.still },
        ],
      }]);
    }

    // Sequence (slowest, so last)
    if (!args['skip-sequence'] && !onlyKeys) {
      const { key, width, height, stepDegrees } = OUTPUTS.sequence;
      const count = Math.round(360 / stepDegrees);
      await page.evaluate(([k, s]) => window.MF.sequenceStart(k, { scale: s }), [key, scale]);
      const jobs = [];
      const ts = Date.now();
      for (let i = 0; i < count; i++) {
        if (frameFilter && !frameFilter.has(i)) continue;
        const t = Date.now();
        const name = String(i).padStart(3, '0');
        const src = path.join(OUT, 'sequence', key, `${name}.png`);
        await writeDataUrl(await page.evaluate((deg) => window.MF.sequenceFrame(deg), i * stepDegrees), src);
        console.log(`sequence ${key} ${name} (${i * stepDegrees} deg) ${seconds(t)}`);
        jobs.push({
          src,
          outputs: [{
            path: path.join(ASSETS, 'sequence', key, `${name}.webp`),
            width, height, quality: QUALITY.sequence, maxBytes: SEQUENCE_MAX_BYTES,
          }, {
            // Phones: a 720 px set, which a 2x canvas on a phone can't tell apart and decodes faster.
            path: path.join(ASSETS, 'sequence', key, '720', `${name}.webp`),
            width: 720, height: 900, quality: QUALITY.sequence, maxBytes: SEQUENCE_MAX_BYTES,
          }],
        });
      }
      await page.evaluate(() => window.MF.sequenceEnd());
      console.log(`sequence total ${seconds(ts)}`);
      await encode(jobs);
    }
    console.log(`done in ${seconds(t0)}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
