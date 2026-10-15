// Reads the environment variables listed in SPEC.md (Environment) into one checked object, so
// every handler sees the same defaults and nothing reads process.env directly.
//
// Bad values never throw: each falls back to its default and logs one warning, so a typo in
// the Netlify settings degrades to sample mode or the default instead of taking the site down.

import { isValidTimeZone } from "./time.mjs";

// Square API version, pinned so a Square release can't change response shapes under us.
// 2026-08-19 is the newest release more than a month old (checked 2026-10-14); every schema
// this site uses is identical in 2026-09-16.
export const SQUARE_VERSION = "2026-08-19";

export const SQUARE_BASE_URLS = Object.freeze({
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
});

export const DEFAULTS = Object.freeze({
  squareEnvironment: "sandbox",
  businessTimezone: "America/New_York",
  orderCutoffMinutes: 15,
});

const MAX_CUTOFF_MINUTES = 24 * 60;
const warned = new Set();

function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[config] ${message}`);
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

// People paste tokens with a "Bearer " prefix or surrounding quotes; accept both.
function cleanToken(value) {
  return text(value).replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
}

function readEnvironment(value) {
  const raw = text(value).toLowerCase();
  if (!raw) return DEFAULTS.squareEnvironment;
  if (raw === "production" || raw === "sandbox") return raw;
  // Quote only a short word: a long value may be an access token pasted into the wrong field.
  const shown = /^[a-z_-]{1,20}$/.test(raw) ? `not "${raw}"` : "not the value set";
  warnOnce(`SQUARE_ENVIRONMENT must be "sandbox" or "production", ${shown}. Using sandbox.`);
  return DEFAULTS.squareEnvironment;
}

// An absolute http(s) address without a trailing slash, query, or fragment; "" when unset or bad.
function readSiteUrl(value) {
  const raw = text(value);
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    warnOnce(`SITE_URL "${raw.slice(0, 80)}" isn't a web address. Using each request's own address instead.`);
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    warnOnce("SITE_URL must start with https:// (or http:// for local testing). Using each request's own address instead.");
    return "";
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function readTimezone(value) {
  const raw = text(value);
  if (!raw) return DEFAULTS.businessTimezone;
  if (isValidTimeZone(raw)) return raw;
  warnOnce(`BUSINESS_TIMEZONE "${raw.slice(0, 60)}" isn't a time zone id. Using ${DEFAULTS.businessTimezone}.`);
  return DEFAULTS.businessTimezone;
}

function readCutoff(value) {
  const raw = text(String(value ?? ""));
  if (!raw) return DEFAULTS.orderCutoffMinutes;
  const minutes = Number(raw);
  if (/^\d+$/.test(raw) && minutes <= MAX_CUTOFF_MINUTES) return minutes;
  warnOnce(`ORDER_CUTOFF_MINUTES must be a whole number from 0 to ${MAX_CUTOFF_MINUTES}, not "${raw.slice(0, 20)}". Using ${DEFAULTS.orderCutoffMinutes}.`);
  return DEFAULTS.orderCutoffMinutes;
}

/**
 * The site's settings from an environment object (process.env on Netlify and in the dev server).
 * `squareConfigured` is true only when both the access token and the location ID are set; the
 * menu and checkout run in sample mode otherwise.
 */
export function readConfig(env = {}) {
  const squareAccessToken = cleanToken(env.SQUARE_ACCESS_TOKEN);
  const squareLocationId = text(env.SQUARE_LOCATION_ID);
  const squareEnvironment = readEnvironment(env.SQUARE_ENVIRONMENT);
  if (Boolean(squareAccessToken) !== Boolean(squareLocationId)) {
    warnOnce(`${squareAccessToken ? "SQUARE_LOCATION_ID" : "SQUARE_ACCESS_TOKEN"} is empty, so Square stays off and the site shows sample prices.`);
  }
  return Object.freeze({
    squareAccessToken,
    squareLocationId,
    squareEnvironment,
    squareBaseUrl: SQUARE_BASE_URLS[squareEnvironment],
    squareVersion: SQUARE_VERSION,
    squareConfigured: Boolean(squareAccessToken && squareLocationId),
    siteUrl: readSiteUrl(env.SITE_URL),
    calendarIcsUrl: text(env.CALENDAR_ICS_URL),
    calendarKeyword: text(env.CALENDAR_KEYWORD),
    businessTimezone: readTimezone(env.BUSINESS_TIMEZONE),
    orderCutoffMinutes: readCutoff(env.ORDER_CUTOFF_MINUTES),
  });
}

/** For tests: lets the same warning be logged again. */
export function resetConfigWarnings() {
  warned.clear();
}
