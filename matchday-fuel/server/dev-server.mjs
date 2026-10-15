// Local preview server: `npm run dev` (or `node server/dev-server.mjs`).
//
// Serves public/ the way Netlify does and routes /api/menu, /api/schedule, and /api/checkout to
// the same handlers the Netlify Functions use. Settings come from the environment, plus
// matchday-fuel/.env when it exists (values already in the environment win).
//
// PORT sets the port (default 8888). HOST sets the interface (default localhost; use 0.0.0.0
// to try the site from a phone on the same network).

import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleCheckout } from "./checkout.mjs";
import { readConfig } from "./config.mjs";
import { errorResponse, HttpError, json } from "./http.mjs";
import { handleMenu } from "./menu.mjs";
import { handleSchedule } from "./schedule.mjs";

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_DIR = path.join(PROJECT_DIR, "public");
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_PORT = 8888;

export const ROUTES = Object.freeze({
  "/api/menu": handleMenu,
  "/api/schedule": handleSchedule,
  "/api/checkout": handleCheckout,
});

export const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".ics": "text/calendar; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
});

const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found · Matchday Fuel</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #FFFFFF; color: #1C130C;
         font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 0 16px; }
  main { max-width: 32rem; text-align: center; }
  h1 { font-size: 1.75rem; margin: 0 0 .5rem; }
  p { color: #5F4A39; margin: 0 0 1.5rem; }
  a { color: #7A3410; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Page not found</h1>
  <p>There's nothing at this address.</p>
  <a href="/">Go to Matchday Fuel</a>
</main>
</body>
</html>
`;

// .env ------------------------------------------------------------------------------------------

/** KEY=VALUE lines; # comments, blank lines, `export ` prefixes, and quoted values allowed. */
export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    const doubleQuoted = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    const singleQuoted = /^'([^']*)'/.exec(rest);
    if (doubleQuoted) {
      values[key] = doubleQuoted[1].replace(/\\(.)/g, (_, char) => (char === "n" ? "\n" : char));
    } else if (singleQuoted) {
      values[key] = singleQuoted[1];
    } else {
      values[key] = rest.replace(/\s+#.*$/, "").trim();
    }
  }
  return values;
}

/** Copies .env values into `env` without replacing variables that are already set. */
export async function loadEnvFile(file = path.join(PROJECT_DIR, ".env"), env = process.env) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const loaded = [];
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (key in env) continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

// Static files ----------------------------------------------------------------------------------

function sendNotFound(req, res) {
  res.writeHead(404, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(NOT_FOUND_PAGE),
    "cache-control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : NOT_FOUND_PAGE);
}

const isInside = (dir, target) => target === dir || target.startsWith(dir + path.sep);

// The file a URL path names inside root, or null. Rejects traversal, encoded separators,
// NUL bytes, dot-files, and symlinks that lead outside root.
async function resolveStatic(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) return null;
  const target = path.resolve(root, ...segments);
  if (!isInside(root, target)) return null;
  let info;
  let file = target;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      // One leading slash only: "//assets/" in a Location header would mean the host "assets".
      if (!pathname.endsWith("/")) return { redirect: `/${pathname.replace(/^[/\\]+/, "")}/` };
      file = path.join(target, "index.html");
      info = await stat(file);
    }
    if (!info.isFile()) return null;
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    if (!isInside(realRoot, realFile)) return null;
  } catch {
    return null;
  }
  return { file, size: info.size, mtime: info.mtime };
}

async function serveStatic(req, res, root, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }
  const found = await resolveStatic(root, pathname);
  if (!found) return sendNotFound(req, res);
  if (found.redirect) {
    res.writeHead(301, { location: found.redirect });
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(found.file).toLowerCase()] ?? "application/octet-stream",
    "content-length": found.size,
    "last-modified": found.mtime.toUTCString(),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(found.file)
    .on("error", () => res.destroy())
    .pipe(res);
}

// API -------------------------------------------------------------------------------------------

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"]);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > limit) {
        failed = true;
        reject(new HttpError(413, "TOO_LARGE", "The request is too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

// Host names that reach this machine. Anything else in a Host header is ignored, so a forged
// header can't point the schedule's /data/schedule.json fetch or the checkout return link
// at another site.
function localHostNames() {
  const names = new Set(["localhost", "127.0.0.1", "[::1]"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) names.add(entry.family === "IPv6" || entry.family === 6 ? `[${entry.address}]` : entry.address);
  }
  return names;
}

function originFor(req, address, hostNames) {
  const port = address?.port;
  const bound = address?.address;
  const wildcard = !bound || bound === "0.0.0.0" || bound === "::";
  const fallback = `http://${wildcard ? "localhost" : bound.includes(":") ? `[${bound}]` : bound}:${port}`;
  const host = req.headers.host;
  if (typeof host !== "string") return fallback;
  try {
    const url = new URL(`http://${host}`);
    if (hostNames.has(url.hostname) && Number(url.port || 80) === port) return url.origin;
  } catch {
    // Not a host name; use the fallback.
  }
  return fallback;
}

// The request's URL on this server. Only the path and query come from the request line: an
// absolute target ("GET http://elsewhere/api/schedule") or a protocol-relative one
// ("GET //elsewhere/api/schedule") would otherwise name another host, and the handlers derive
// the schedule.json address and the checkout return link from this URL.
export function requestUrl(target, origin) {
  const parsed = new URL(target || "/", "http://request.invalid");
  const url = new URL(origin);
  url.pathname = parsed.pathname;
  url.search = parsed.search;
  return url;
}

async function toRequest(req, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await readBody(req, MAX_BODY_BYTES) : undefined;
  return new Request(url, { method: req.method, headers, body });
}

async function sendResponse(req, res, response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie" && name !== "content-length" && !HOP_BY_HOP.has(name)) headers[name] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  const body = req.method === "HEAD" || response.status === 204 || response.status === 304
    ? null
    : Buffer.from(await response.arrayBuffer());
  if (body) headers["content-length"] = body.length;
  res.writeHead(response.status, headers);
  res.end(body ?? undefined);
}

// Server ----------------------------------------------------------------------------------------

/**
 * An http.Server for the site. `env` is passed to the handlers; `handlerOptions` (for tests) is
 * passed as their third argument.
 */
export function createDevServer({ root = PUBLIC_DIR, env = process.env, routes = ROUTES, handlerOptions, log = () => {} } = {}) {
  const publicRoot = path.resolve(root);
  const hostNames = localHostNames();
  const server = createServer(async (req, res) => {
    const started = Date.now();
    try {
      const origin = originFor(req, server.address(), hostNames);
      const url = requestUrl(req.url, origin);
      const { pathname } = url;
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        const handler = routes[pathname.replace(/\/+$/, "")];
        let response;
        try {
          if (!handler) throw new HttpError(404, "NOT_FOUND", "There's no API at this address.");
          const request = await toRequest(req, url);
          response = await handler(request, env, handlerOptions);
        } catch (error) {
          response = errorResponse(error);
          if (error?.code === "TOO_LARGE") res.setHeader("connection", "close");
        }
        await sendResponse(req, res, response);
        log(`${req.method} ${pathname} ${response.status} (${Date.now() - started} ms)`);
        return;
      }
      await serveStatic(req, res, publicRoot, pathname);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) await sendResponse(req, res, json(500, { error: "The dev server failed.", code: "SERVER_ERROR" }));
      else res.destroy();
    }
  });
  return server;
}

/** Starts the server; resolves to { server, url, close() } once it is listening. */
export function startDevServer({ port = DEFAULT_PORT, host = "localhost", ...options } = {}) {
  const server = createDevServer(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const actual = server.address().port;
      const shownHost = host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
      resolve({
        server,
        url: `http://${shownHost}:${actual}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

async function main() {
  const loaded = await loadEnvFile();
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST?.trim() || "localhost";
  let running;
  try {
    running = await startDevServer({ port, host, env: process.env, log: (line) => console.log(line) });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Stop the other server or run with PORT=${port + 1}.`);
      process.exit(1);
    }
    throw error;
  }
  const config = readConfig(process.env);
  console.log(`Matchday Fuel is running at ${running.url}`);
  if (loaded.length) console.log(`Loaded ${loaded.length} setting${loaded.length === 1 ? "" : "s"} from .env.`);
  console.log(config.squareConfigured
    ? `Square: ${config.squareEnvironment}, location ${config.squareLocationId}.`
    : "Square: not connected, so the menu shows sample prices and checkout is off.");
  console.log(config.calendarIcsUrl ? "Schedule: calendar feed (CALENDAR_ICS_URL)." : "Schedule: public/data/schedule.json.");
  const stop = () => running.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
