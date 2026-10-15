// GET /api/schedule: where and when the stand will be.
//
// Two sources, chosen by environment:
// - "calendar": CALENDAR_ICS_URL is an iCal feed (Google Calendar secret address, iCloud public
//   calendar, Outlook published calendar). The parsed feed is cached in memory for 5 minutes.
//   If the feed can't be read, the last good copy (up to 6 hours old) is used, and failing
//   that the site's own /data/schedule.json, so the page never breaks because of the feed.
// - "file": /data/schedule.json, hand-edited, with wall-clock times in its "timezone".
//
// Both return upcoming stops in the SPEC shape: not yet ended, starting within 90 days, sorted
// by start, at most 50.

import { createHash } from "node:crypto";
import { HttpError, json, requireMethod } from "./http.mjs";
import { MAX_ICS_BYTES, parseIcs } from "./ics.mjs";
import { DAY_MS, isValidTimeZone, parseLocalDateTime } from "./time.mjs";

export const DEFAULT_TIMEZONE = "America/New_York";
const WINDOW_DAYS = 90;
const MAX_EVENTS = 50;
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_LIMIT_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const MAX_FILE_BYTES = 512 * 1024;
const LIMITS = { title: 120, venue: 120, address: 200, notes: 500 };
const FALLBACK_TITLE = "Matchday Fuel stand";

// Feed cache, keyed by feed URL and time zone: { fetchedAt, occurrences }.
const feedCache = new Map();
const inflight = new Map();
const failures = new Map();

/** Forgets cached calendar data (for tests, or after changing the feed). */
export function clearScheduleCache() {
  feedCache.clear();
  inflight.clear();
  failures.clear();
}

// Text cleanup ---------------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (whole, body) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? whole;
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

// Google Calendar stores descriptions as HTML; keep the words, drop the markup. A tag never
// contains "<", which keeps each pattern linear: with [^>]* a run of "<a<a<a…" without a ">"
// made every "<" scan to the end of the text (quadratic, minutes for a large description).
function stripHtml(text) {
  if (!/<\/?[a-z][^<>]*>/i.test(text)) return text;
  return decodeEntities(text
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^<>]*>/gi, " ")
    .replace(/<[^<>]*>/g, ""));
}

/** Trims, collapses whitespace, removes control and bidi-override characters, caps length. */
export function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/[‪-‮⁦-⁩​﻿]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  // 2 x maxLength UTF-16 units always hold more than maxLength - 1 whole characters.
  const chars = Array.from(text.slice(0, maxLength * 2));
  if (chars.length <= maxLength && text.length <= maxLength * 2) return text;
  return `${chars.slice(0, maxLength - 1).join("").trimEnd()}…`;
}

// Raw calendar text is cut to this many UTF-16 units before cleanup. Displayed text is capped far
// lower (LIMITS), so this only bounds the work a huge SUMMARY, LOCATION, or DESCRIPTION can cause.
const RAW_TEXT_LIMITS = { summary: 2_000, location: 4_000, description: 20_000 };
const clip = (text, max) => (text.length > max ? text.slice(0, max) : text);

/** LOCATION splits at the first comma (or line break, as Apple Calendar writes it). */
export function splitLocation(location) {
  const text = String(location ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { venue: "", address: "" };
  const newline = text.indexOf("\n");
  const comma = text.indexOf(",");
  const cut = newline !== -1 && (comma === -1 || newline < comma) ? newline : comma;
  if (cut === -1) return { venue: text, address: "" };
  return {
    venue: text.slice(0, cut),
    address: text.slice(cut + 1).replace(/\s*\n\s*/g, ", ").replace(/,(\s*,)+/g, ","),
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shared shaping -------------------------------------------------------------------------------

function upcoming(events, nowMs) {
  const horizon = nowMs + WINDOW_DAYS * DAY_MS;
  return events
    .filter((event) => event.endMs > nowMs && event.startMs < horizon)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_EVENTS)
    .map(({ id, title, venue, address, startMs, endMs, notes, sample }) => ({
      id,
      title,
      venue,
      address,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      notes,
      sample,
    }));
}

function compactUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

export function businessTimeZone(env = {}) {
  const zone = String(env.BUSINESS_TIMEZONE ?? "").trim();
  if (!zone) return DEFAULT_TIMEZONE;
  if (isValidTimeZone(zone)) return zone;
  console.warn(`[schedule] BUSINESS_TIMEZONE "${zone.slice(0, 60)}" isn't a time zone id; using ${DEFAULT_TIMEZONE}.`);
  return DEFAULT_TIMEZONE;
}

// Fetching -------------------------------------------------------------------------------------

async function readCapped(response, maxBytes, label) {
  const tooLarge = () => new Error(`${label} is larger than ${Math.round(maxBytes / 1024)} KB`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) throw tooLarge();
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// GETs a URL and returns its body as bytes, within FETCH_TIMEOUT_MS for the whole exchange.
async function fetchBytes(url, fetchImpl, { accept, maxBytes, label }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} took longer than ${FETCH_TIMEOUT_MS / 1000} seconds`));
    }, FETCH_TIMEOUT_MS);
  });
  const exchange = (async () => {
    const response = await fetchImpl(url, {
      headers: { accept, "user-agent": "MatchdayFuel-Schedule/1.0" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${label} answered HTTP ${response.status}`);
    return readCapped(response, maxBytes, label);
  })();
  try {
    return await Promise.race([exchange, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** https:// passes through, webcal:// and webcals:// become https://, anything else throws. */
export function normalizeFeedUrl(raw) {
  const text = String(raw ?? "").trim();
  const converted = text.replace(/^webcals?:\/\//i, "https://");
  let url;
  try {
    url = new URL(converted);
  } catch {
    throw new Error("CALENDAR_ICS_URL isn't a web address");
  }
  if (url.protocol !== "https:") throw new Error("CALENDAR_ICS_URL must start with https:// or webcal://");
  // fetch refuses these, and its error message quotes the whole address, secret path included.
  if (url.username || url.password) throw new Error("CALENDAR_ICS_URL can't include a user name or password");
  return url.href;
}

// Calendar mode --------------------------------------------------------------------------------

async function fetchCalendar(url, timezone, nowMs, fetchImpl) {
  const bytes = await fetchBytes(url, fetchImpl, {
    accept: "text/calendar, text/plain;q=0.8, */*;q=0.5",
    maxBytes: MAX_ICS_BYTES,
    label: "The calendar feed",
  });
  const warnings = [];
  const occurrences = parseIcs(bytes, {
    defaultTimeZone: timezone,
    rangeStart: new Date(nowMs),
    // A day past the window, so a cached copy still covers the window when it is served later.
    rangeEnd: new Date(nowMs + (WINDOW_DAYS + 1) * DAY_MS),
    onWarning: (message) => warnings.push(message),
  });
  if (warnings.length) console.warn(`[schedule] Calendar feed: ${warnings.join(" ")}`);
  return occurrences;
}

async function calendarOccurrences(rawUrl, timezone, nowMs, fetchImpl) {
  const url = normalizeFeedUrl(rawUrl);
  const key = `${url}\n${timezone}`;
  const cached = feedCache.get(key);
  const age = cached ? nowMs - cached.fetchedAt : Infinity;
  if (age >= 0 && age < CACHE_TTL_MS) return cached.occurrences;

  const stale = age >= 0 && age < STALE_LIMIT_MS ? cached.occurrences : null;
  const failedAt = failures.get(key);
  if (failedAt !== undefined && nowMs >= failedAt && nowMs - failedAt < RETRY_AFTER_FAILURE_MS) {
    if (stale) return stale;
    throw Object.assign(new Error("The calendar feed failed less than a minute ago"), { quiet: true });
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchCalendar(url, timezone, nowMs, fetchImpl);
    inflight.set(key, pending);
    pending.then(() => inflight.delete(key), () => inflight.delete(key));
  }
  try {
    const occurrences = await pending;
    feedCache.set(key, { fetchedAt: nowMs, occurrences });
    failures.delete(key);
    return occurrences;
  } catch (error) {
    failures.set(key, nowMs);
    if (stale) {
      console.error(`[schedule] ${describeFeedError(error, url)} Showing the copy from ${Math.round(age / 60000)} minutes ago.`);
      return stale;
    }
    throw error;
  }
}

// The feed address is a secret, so logs name only its host, even when an error message quotes it.
function describeFeedError(error, url) {
  let host = "the calendar host";
  let secrets = [];
  try {
    const parsed = new URL(url);
    host = parsed.host;
    secrets = [url, String(url).trim(), parsed.href, parsed.pathname + parsed.search].filter((s) => s && s !== "/");
  } catch {
    if (url) secrets = [String(url)];
  }
  let message = String(error?.message ?? error);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) message = message.split(secret).join(`${host}/…`);
  const cause = error?.cause?.code ? ` (${error.cause.code})` : "";
  return `Couldn't read the calendar feed from ${host}: ${message}${cause}.`;
}

// Every occurrence of a repeating event shares its master's text, so each distinct string is
// cleaned once per call rather than once per occurrence (up to 5,000 of them).
function memoize(fn) {
  const results = new Map();
  return (value) => {
    if (!results.has(value)) results.set(value, fn(value));
    return results.get(value);
  };
}

function calendarEvents(occurrences, env, nowMs) {
  const keyword = String(env.CALENDAR_KEYWORD ?? "").trim();
  const keywordPattern = keyword ? new RegExp(escapeRegExp(keyword), "gi") : null;
  const strip = (text) => (keywordPattern ? text.replace(keywordPattern, " ") : text);
  const mentionsKeyword = memoize((text) => text.toLowerCase().includes(keyword.toLowerCase()));
  const uidHash = memoize((uid) => createHash("sha256").update(uid).digest("hex").slice(0, 12));
  const title = memoize((summary) => cleanText(strip(clip(summary, RAW_TEXT_LIMITS.summary)), LIMITS.title));
  const place = memoize((location) => {
    const parts = splitLocation(strip(clip(location, RAW_TEXT_LIMITS.location)));
    return { venue: cleanText(parts.venue, LIMITS.venue), address: cleanText(parts.address, LIMITS.address) };
  });
  const notes = memoize((description) => cleanText(stripHtml(strip(clip(description, RAW_TEXT_LIMITS.description))), LIMITS.notes));

  const events = [];
  const ids = new Set();
  for (const occurrence of occurrences) {
    const startMs = occurrence.start.getTime();
    const endMs = occurrence.end.getTime();
    if (!(endMs > nowMs)) continue;
    if (keyword && !mentionsKeyword(occurrence.summary) && !mentionsKeyword(occurrence.description)) continue;
    const id = `${uidHash(occurrence.uid)}-${compactUtc(startMs)}`;
    if (ids.has(id)) continue;
    ids.add(id);
    const { venue, address } = place(occurrence.location);
    events.push({
      id,
      title: title(occurrence.summary) || venue || FALLBACK_TITLE,
      venue,
      address,
      startMs,
      endMs,
      notes: notes(occurrence.description),
      sample: false,
    });
  }
  return upcoming(events, nowMs);
}

// File mode ------------------------------------------------------------------------------------

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function fileEvents(data, timezone, nowMs) {
  const list = Array.isArray(data?.events) ? data.events : [];
  const events = [];
  const ids = new Set();
  const problems = [];
  list.forEach((raw, index) => {
    const label = `event ${index + 1}`;
    if (!raw || typeof raw !== "object") return problems.push(`${label} isn't an object`);
    let startMs;
    let endMs;
    try {
      startMs = parseLocalDateTime(raw.start, timezone).getTime();
      endMs = parseLocalDateTime(raw.end, timezone).getTime();
    } catch (error) {
      return problems.push(`${label}: ${error.message}`);
    }
    if (endMs <= startMs) return problems.push(`${label} ends before it starts`);
    const venue = cleanText(raw.venue, LIMITS.venue);
    const title = cleanText(raw.title, LIMITS.title) || venue || FALLBACK_TITLE;
    const base = typeof raw.id === "string" && FILE_ID.test(raw.id.trim()) ? raw.id.trim()
      : `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "stop"}-${compactUtc(startMs)}`;
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    events.push({
      id,
      title,
      venue,
      address: cleanText(raw.address, LIMITS.address),
      startMs,
      endMs,
      notes: cleanText(stripHtml(typeof raw.notes === "string" ? raw.notes : ""), LIMITS.notes),
      sample: raw.sample === true,
    });
  });
  if (problems.length) console.warn(`[schedule] Skipped entries in schedule.json: ${problems.slice(0, 10).join("; ")}.`);
  return upcoming(events, nowMs);
}

async function loadFileSchedule(env, request, nowMs, fetchImpl) {
  if (!request?.url) throw new HttpError(500, "SERVER_ERROR", "The schedule needs the request URL to find /data/schedule.json.");
  const url = new URL("/data/schedule.json", request.url);
  let data;
  try {
    const bytes = await fetchBytes(url.href, fetchImpl, {
      accept: "application/json",
      maxBytes: MAX_FILE_BYTES,
      label: "schedule.json",
    });
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    console.error(`[schedule] Couldn't load ${url.pathname}: ${error.message}`);
    throw new HttpError(503, "SCHEDULE_UNAVAILABLE", "The schedule isn't available right now. Try again in a moment.");
  }
  const fileZone = typeof data?.timezone === "string" ? data.timezone.trim() : "";
  let timezone = businessTimeZone(env);
  if (fileZone && isValidTimeZone(fileZone)) timezone = fileZone;
  else if (fileZone) console.warn(`[schedule] schedule.json timezone "${fileZone.slice(0, 60)}" isn't a time zone id; using ${timezone}.`);
  return { mode: "file", timezone, events: fileEvents(data, timezone, nowMs) };
}

// Public API -----------------------------------------------------------------------------------

/**
 * Upcoming stops as { mode, timezone, events } (see SPEC.md, GET /api/schedule).
 * `fetchImpl` is used for both the calendar feed and /data/schedule.json.
 */
export async function loadSchedule({ env = {}, request, now = new Date(), fetchImpl = fetch } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const timezone = businessTimeZone(env);
  const feed = String(env.CALENDAR_ICS_URL ?? "").trim();
  if (feed) {
    try {
      const occurrences = await calendarOccurrences(feed, timezone, nowMs, fetchImpl);
      return { mode: "calendar", timezone, events: calendarEvents(occurrences, env, nowMs) };
    } catch (error) {
      if (!error?.quiet) {
        let url = feed;
        try {
          url = normalizeFeedUrl(feed);
        } catch {
          // The message already says what is wrong with the address.
        }
        console.error(`[schedule] ${describeFeedError(error, url)} Showing schedule.json instead.`);
      }
    }
  }
  return loadFileSchedule(env, request, nowMs, fetchImpl);
}

/** The stop with this id, or null. */
export function findEvent(schedule, id) {
  if (typeof id !== "string" || !Array.isArray(schedule?.events)) return null;
  return schedule.events.find((event) => event.id === id) ?? null;
}

export async function handleSchedule(request, env = {}) {
  requireMethod(request, "GET", "HEAD");
  const schedule = await loadSchedule({ env, request });
  return json(200, schedule, { "cache-control": "public, max-age=60" });
}
