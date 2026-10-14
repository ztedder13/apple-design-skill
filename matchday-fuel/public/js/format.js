// Formatting and time-zone helpers. Times are shown in the business's time zone, not the
// visitor's, so a stop at 6:00 PM reads 6:00 PM wherever someone opens the page.

export const DEFAULT_TIME_ZONE = "America/New_York";

const moneyFormats = new Map();
export function formatMoney(cents, currency = "USD") {
  if (!moneyFormats.has(currency)) {
    moneyFormats.set(currency, new Intl.NumberFormat("en-US", { style: "currency", currency }));
  }
  return moneyFormats.get(currency).format(cents / 100);
}

function partsIn(date, timeZone) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  return Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
}

function offsetMs(date, timeZone) {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Converts a wall-clock time in a time zone to an instant. A time inside the skipped
// spring-forward hour moves an hour later; a time in the repeated fall-back hour takes the first
// occurrence.
export function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(guess), timeZone);
  const second = offsetMs(new Date(guess - first), timeZone);
  return new Date(guess - (first === second ? first : Math.min(first, second)));
}

export function parseLocalDateTime(value, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(value || ""));
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0"] = match;
  return zonedWallTimeToUtc(+y, +mo, +d, +h, +mi, timeZone);
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function dateTile(date, timeZone) {
  const get = (options) => new Intl.DateTimeFormat("en-US", { timeZone, ...options }).format(date);
  return { month: get({ month: "short" }), day: get({ day: "numeric" }), weekday: get({ weekday: "short" }) };
}

export function formatTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

export function formatDay(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
}

export function formatTimeRange(start, end, timeZone) {
  return `${formatTime(start, timeZone)} – ${formatTime(end, timeZone)}`;
}

export function dayKey(date, timeZone) {
  const p = partsIn(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function mapsUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
