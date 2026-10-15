// Time zone arithmetic with nothing but Intl, so schedules can be written in wall-clock time
// ("Saturday 9:00 AM in New York") and turned into exact instants on any Node 20+ host.
//
// Daylight saving transitions follow RFC 5545 section 3.3.5 (the rule calendar apps use, and
// the "compatible" choice in JavaScript's Temporal):
//
// - A wall time that happens twice (the repeated hour when clocks fall back) means the first
//   one, the earlier instant. 1:30 AM on 2026-11-01 in New York is 1:30 AM EDT (05:30 UTC).
// - A wall time that never happens (the skipped hour when clocks spring forward) is read with
//   the UTC offset in force before the gap, which moves it forward by the size of the gap.
//   2:30 AM on 2026-03-08 in New York becomes 3:30 AM EDT (07:30 UTC).
//
// Out-of-range fields roll over the way Date.UTC does (day 32 becomes the 1st of next month).

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const MAX_CACHE = 256;
const formatters = new Map();
const validity = new Map();

function remember(map, key, value) {
  if (map.size >= MAX_CACHE) map.clear();
  map.set(key, value);
  return value;
}

function formatterFor(timeZone) {
  return formatters.get(timeZone) ?? remember(formatters, timeZone, new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }));
}

/** True when Intl knows the IANA time zone id (for example "America/New_York" or "UTC"). */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim() || timeZone.length > 100) return false;
  if (validity.has(timeZone)) return validity.get(timeZone);
  let ok = true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    ok = false;
  }
  return remember(validity, timeZone, ok);
}

function assertTimeZone(timeZone) {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Unknown time zone "${timeZone}".`);
}

/** Milliseconds since the epoch for a wall time read as UTC. Handles years below 100. */
export function utcFromParts(year, month, day, hour = 0, minute = 0, second = 0) {
  if (year >= 100) return Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

// en-US output such as "10/24/2026, 09:00:00". Reading it with a pattern is several times
// faster than formatToParts, which matters when a feed expands thousands of occurrences.
const US_OUTPUT = /^(\d{1,2})\/(\d{1,2})\/(\d{1,6}),? (\d{1,2}):(\d{2}):(\d{2})$/;

/** The wall-clock fields of an instant in a time zone. */
export function utcToZonedParts(instant, timeZone) {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("Invalid instant.");
  const formatter = formatterFor(timeZone);
  const quick = US_OUTPUT.exec(formatter.format(ms));
  if (quick) {
    return {
      year: Number(quick[3]),
      month: Number(quick[1]),
      day: Number(quick[2]),
      hour: Number(quick[4]) % 24, // some engines print midnight as 24 even with h23
      minute: Number(quick[5]),
      second: Number(quick[6]),
    };
  }
  const fields = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour % 24, // some engines print midnight as 24 even with h23
    minute: fields.minute,
    second: fields.second,
  };
}

/** UTC offset of a time zone at an instant, in milliseconds (New York in winter: -18,000,000). */
export function timeZoneOffsetMs(instantMs, timeZone) {
  const whole = Math.floor(instantMs / 1000) * 1000; // Intl does not print milliseconds
  const p = utcToZonedParts(whole, timeZone);
  return utcFromParts(p.year, p.month, p.day, p.hour, p.minute, p.second) - whole;
}

/** Same as zonedWallTimeToUtc but returns epoch milliseconds. */
export function zonedWallTimeToEpochMs(year, month, day, hour = 0, minute = 0, second = 0, timeZone = "UTC") {
  const wall = utcFromParts(year, month, day, hour, minute, second);
  if (!Number.isFinite(wall)) throw new RangeError("Invalid date.");
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return wall;
  assertTimeZone(timeZone);

  // The instant lies within 14 hours of `wall`, so offsets a day either side bracket any
  // transition near it. When they agree (almost always) one more lookup confirms the answer.
  const before = timeZoneOffsetMs(wall - DAY_MS, timeZone);
  const after = timeZoneOffsetMs(wall + DAY_MS, timeZone);
  if (before === after && timeZoneOffsetMs(wall - before, timeZone) === before) return wall - before;

  // Near a transition: keep each offset that maps back to this exact wall time.
  const valid = [];
  for (const offset of new Set([before, after, timeZoneOffsetMs(wall, timeZone)])) {
    if (timeZoneOffsetMs(wall - offset, timeZone) === offset) valid.push(wall - offset);
  }
  if (valid.length) return Math.min(...valid); // repeated hour: the first occurrence
  return wall - before; // skipped hour: the offset before the gap
}

/**
 * The instant at which a wall-clock time happens in an IANA time zone.
 * zonedWallTimeToUtc(2026, 10, 24, 9, 0, 0, "America/New_York") -> 2026-10-24T13:00:00.000Z
 */
export function zonedWallTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0, timeZone = "UTC") {
  return new Date(zonedWallTimeToEpochMs(year, month, day, hour, minute, second, timeZone));
}

export function daysInMonth(year, month) {
  return new Date(utcFromParts(year, month + 1, 0)).getUTCDate();
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Reads "2026-10-24T09:00" (seconds optional; a bare date means midnight) as a wall time in
 * `timeZone`. A trailing "Z" or "+hh:mm" marks an exact instant and the zone is not used.
 * Throws a RangeError that names the problem, for input that is not a real date and time.
 */
export function parseLocalDateTime(text, timeZone) {
  const value = typeof text === "string" ? text.trim() : "";
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new RangeError(`"${String(text).slice(0, 40)}" is not a date and time like 2026-10-24T09:00.`);
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  const [hour, minute, second] = [match[4] ?? 0, match[5] ?? 0, match[6] ?? 0].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`"${value}" is not a real date and time.`);
  }
  const zone = match[7];
  if (zone) {
    const offset = zone.toUpperCase() === "Z" ? 0 : (() => {
      const digits = zone.replace(":", "");
      const minutes = Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5));
      return (digits[0] === "-" ? -1 : 1) * minutes * MINUTE_MS;
    })();
    return new Date(utcFromParts(year, month, day, hour, minute, second) - offset);
  }
  return zonedWallTimeToUtc(year, month, day, hour, minute, second, timeZone);
}
