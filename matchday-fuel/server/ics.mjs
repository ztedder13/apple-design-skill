// A small iCalendar (RFC 5545) reader for the stand's schedule feed. It reads the subset that
// Google Calendar, iCloud, and Outlook publish: VEVENTs with their times, recurrence rules,
// exceptions, and per-instance overrides. It returns concrete occurrences inside a time range.
//
// Recurrences are expanded in wall-clock time in the event's own zone, so a 9:00 AM weekly stop
// stays at 9:00 AM after daylight saving time ends. Time zone handling is in time.mjs.
//
// The feed comes from the internet, so the work is capped: input over 2 MB is refused, and
// expansion stops after MAX_INSTANCES occurrences near the range or MAX_STEPS candidate dates
// across the whole feed (a warning goes to options.onWarning when that happens).

import { createHash } from "node:crypto";
import { DAY_MS, daysInMonth, isValidTimeZone, utcFromParts, utcToZonedParts, zonedWallTimeToEpochMs } from "./time.mjs";

export const MAX_ICS_BYTES = 2 * 1024 * 1024;
export const MAX_INSTANCES = 5000;
export const MAX_STEPS = 200_000;
const MAX_DEPTH = 32;
const MAX_WARNINGS = 20;
const MAX_UID_LENGTH = 1024;

// Windows time zone ids that Outlook and Exchange put in TZID, mapped to IANA ids
// (CLDR windowsZones.xml, territory 001).
export const WINDOWS_TIME_ZONES = Object.freeze({
  "Dateline Standard Time": "Etc/GMT+12",
  "UTC-11": "Etc/GMT+11",
  "Aleutian Standard Time": "America/Adak",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Marquesas Standard Time": "Pacific/Marquesas",
  "Alaskan Standard Time": "America/Anchorage",
  "UTC-09": "Etc/GMT+9",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "UTC-08": "Etc/GMT+8",
  "Pacific Standard Time": "America/Los_Angeles",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time (Mexico)": "America/Mazatlan",
  "Mountain Standard Time": "America/Denver",
  "Yukon Standard Time": "America/Whitehorse",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time": "America/Chicago",
  "Easter Island Standard Time": "Pacific/Easter",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "SA Pacific Standard Time": "America/Bogota",
  "Eastern Standard Time (Mexico)": "America/Cancun",
  "Eastern Standard Time": "America/New_York",
  "Haiti Standard Time": "America/Port-au-Prince",
  "Cuba Standard Time": "America/Havana",
  "US Eastern Standard Time": "America/Indiana/Indianapolis",
  "Turks And Caicos Standard Time": "America/Grand_Turk",
  "Paraguay Standard Time": "America/Asuncion",
  "Atlantic Standard Time": "America/Halifax",
  "Venezuela Standard Time": "America/Caracas",
  "Central Brazilian Standard Time": "America/Cuiaba",
  "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago",
  "Newfoundland Standard Time": "America/St_Johns",
  "Tocantins Standard Time": "America/Araguaina",
  "E. South America Standard Time": "America/Sao_Paulo",
  "SA Eastern Standard Time": "America/Cayenne",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "Greenland Standard Time": "America/Nuuk",
  "Montevideo Standard Time": "America/Montevideo",
  "Magallanes Standard Time": "America/Punta_Arenas",
  "Saint Pierre Standard Time": "America/Miquelon",
  "Bahia Standard Time": "America/Bahia",
  "UTC-02": "Etc/GMT+2",
  "Azores Standard Time": "Atlantic/Azores",
  "Cape Verde Standard Time": "Atlantic/Cape_Verde",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "Sao Tome Standard Time": "Africa/Sao_Tome",
  "Morocco Standard Time": "Africa/Casablanca",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "Jordan Standard Time": "Asia/Amman",
  "GTB Standard Time": "Europe/Bucharest",
  "Middle East Standard Time": "Asia/Beirut",
  "Egypt Standard Time": "Africa/Cairo",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Syria Standard Time": "Asia/Damascus",
  "West Bank Standard Time": "Asia/Hebron",
  "South Africa Standard Time": "Africa/Johannesburg",
  "FLE Standard Time": "Europe/Kiev",
  "Israel Standard Time": "Asia/Jerusalem",
  "South Sudan Standard Time": "Africa/Juba",
  "Kaliningrad Standard Time": "Europe/Kaliningrad",
  "Sudan Standard Time": "Africa/Khartoum",
  "Libya Standard Time": "Africa/Tripoli",
  "Namibia Standard Time": "Africa/Windhoek",
  "Arabic Standard Time": "Asia/Baghdad",
  "Turkey Standard Time": "Europe/Istanbul",
  "Arab Standard Time": "Asia/Riyadh",
  "Belarus Standard Time": "Europe/Minsk",
  "Russian Standard Time": "Europe/Moscow",
  "E. Africa Standard Time": "Africa/Nairobi",
  "Volgograd Standard Time": "Europe/Volgograd",
  "Iran Standard Time": "Asia/Tehran",
  "Arabian Standard Time": "Asia/Dubai",
  "Astrakhan Standard Time": "Europe/Astrakhan",
  "Azerbaijan Standard Time": "Asia/Baku",
  "Russia Time Zone 3": "Europe/Samara",
  "Mauritius Standard Time": "Indian/Mauritius",
  "Saratov Standard Time": "Europe/Saratov",
  "Georgian Standard Time": "Asia/Tbilisi",
  "Caucasus Standard Time": "Asia/Yerevan",
  "Afghanistan Standard Time": "Asia/Kabul",
  "West Asia Standard Time": "Asia/Tashkent",
  "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "Pakistan Standard Time": "Asia/Karachi",
  "Qyzylorda Standard Time": "Asia/Qyzylorda",
  "India Standard Time": "Asia/Kolkata",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Nepal Standard Time": "Asia/Kathmandu",
  "Central Asia Standard Time": "Asia/Almaty",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Omsk Standard Time": "Asia/Omsk",
  "Myanmar Standard Time": "Asia/Yangon",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Altai Standard Time": "Asia/Barnaul",
  "W. Mongolia Standard Time": "Asia/Hovd",
  "North Asia Standard Time": "Asia/Krasnoyarsk",
  "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "Tomsk Standard Time": "Asia/Tomsk",
  "China Standard Time": "Asia/Shanghai",
  "North Asia East Standard Time": "Asia/Irkutsk",
  "Singapore Standard Time": "Asia/Singapore",
  "W. Australia Standard Time": "Australia/Perth",
  "Taipei Standard Time": "Asia/Taipei",
  "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
  "Aus Central W. Standard Time": "Australia/Eucla",
  "Transbaikal Standard Time": "Asia/Chita",
  "Tokyo Standard Time": "Asia/Tokyo",
  "North Korea Standard Time": "Asia/Pyongyang",
  "Korea Standard Time": "Asia/Seoul",
  "Yakutsk Standard Time": "Asia/Yakutsk",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "West Pacific Standard Time": "Pacific/Port_Moresby",
  "Tasmania Standard Time": "Australia/Hobart",
  "Vladivostok Standard Time": "Asia/Vladivostok",
  "Lord Howe Standard Time": "Australia/Lord_Howe",
  "Bougainville Standard Time": "Pacific/Bougainville",
  "Russia Time Zone 10": "Asia/Srednekolymsk",
  "Magadan Standard Time": "Asia/Magadan",
  "Norfolk Standard Time": "Pacific/Norfolk",
  "Sakhalin Standard Time": "Asia/Sakhalin",
  "Central Pacific Standard Time": "Pacific/Guadalcanal",
  "Russia Time Zone 11": "Asia/Kamchatka",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC+12": "Etc/GMT-12",
  "Fiji Standard Time": "Pacific/Fiji",
  "Chatham Islands Standard Time": "Pacific/Chatham",
  "UTC+13": "Etc/GMT-13",
  "Tonga Standard Time": "Pacific/Tongatapu",
  "Samoa Standard Time": "Pacific/Apia",
  "Line Islands Standard Time": "Pacific/Kiritimati",
});

// Display names that some Outlook versions write instead of an id, after the "(UTC-05:00) " prefix.
const DISPLAY_NAME_ZONES = new Map([
  ["eastern time (us & canada)", "America/New_York"],
  ["central time (us & canada)", "America/Chicago"],
  ["mountain time (us & canada)", "America/Denver"],
  ["pacific time (us & canada)", "America/Los_Angeles"],
  ["arizona", "America/Phoenix"],
  ["alaska", "America/Anchorage"],
  ["hawaii", "Pacific/Honolulu"],
  ["atlantic time (canada)", "America/Halifax"],
  ["dublin, edinburgh, lisbon, london", "Europe/London"],
  ["coordinated universal time", "UTC"],
]);

const WINDOWS_LOOKUP = new Map(Object.entries(WINDOWS_TIME_ZONES).map(([name, iana]) => [name.toLowerCase(), iana]));

// Real TZIDs, vendor prefixes included, are well under this. Longer ones are not looked at, so a
// TZID of thousands of path segments can't cost quadratic time.
const MAX_TZID_LENGTH = 256;
const resolvedZones = new Map(); // TZID text -> IANA id or null; a feed repeats the same few

/**
 * Turns a TZID parameter into an IANA id: IANA ids pass through, Windows ids and Outlook display
 * names are mapped, vendor-prefixed ids ("/mozilla.org/20050126_1/America/New_York") lose the
 * prefix. Anything else returns `fallback`.
 */
export function resolveTimeZoneId(tzid, fallback) {
  const raw = String(tzid ?? "");
  if (raw.length > MAX_TZID_LENGTH) return fallback;
  if (!resolvedZones.has(raw)) {
    if (resolvedZones.size >= 256) resolvedZones.clear();
    resolvedZones.set(raw, lookUpTimeZone(raw));
  }
  return resolvedZones.get(raw) ?? fallback;
}

function lookUpTimeZone(raw) {
  const id = raw.trim().replace(/^"(.*)"$/, "$1").trim();
  if (!id) return null;
  if (isValidTimeZone(id)) return id;
  const lower = id.toLowerCase();
  const mapped = WINDOWS_LOOKUP.get(lower) ?? DISPLAY_NAME_ZONES.get(lower.replace(/^\(utc[^)]*\)\s*/, ""));
  if (mapped) return mapped;
  const segments = id.split("/").filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    const candidate = segments.slice(i).join("/");
    if (isValidTimeZone(candidate)) return candidate;
  }
  return null;
}

// Day numbers (days since 1970-01-01) keep date arithmetic exact and independent of zones.
const dayNumber = (y, m, d) => Math.round(utcFromParts(y, m, d) / DAY_MS);
const MAX_DAY = dayNumber(9999, 12, 31);
const weekday = (dn) => (((dn + 4) % 7) + 7) % 7; // 0 = Sunday
function ymd(dn) {
  const date = new Date(dn * DAY_MS);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}
function wallMs(dn, h, mi, s, zone) {
  const [y, m, d] = ymd(dn);
  return zonedWallTimeToEpochMs(y, m, d, h, mi, s, zone);
}
function zonedDay(ms, zone) {
  const p = utcToZonedParts(ms, zone);
  return dayNumber(p.year, p.month, p.day);
}

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** RFC 5545 text unescaping: \n or \N is a newline; \, \; \\ (and a stray \:) are literals. */
export function unescapeText(value) {
  return value.replace(/\\([\\;,:nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

// Parsing ------------------------------------------------------------------------------------

function toText(input, maxBytes) {
  if (typeof input === "string") {
    const size = input.length * 3 <= maxBytes ? input.length : new TextEncoder().encode(input).length;
    if (size > maxBytes) throw new RangeError(`The calendar feed is larger than ${Math.round(maxBytes / 1048576)} MB.`);
    return input.replace(/\r?\n[ \t]/g, "");
  }
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input)
    : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!bytes) throw new TypeError("parseIcs expects text or bytes.");
  if (bytes.byteLength > maxBytes) throw new RangeError(`The calendar feed is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  // Unfold before decoding, so a fold that splits a multi-byte character joins back together.
  const out = new Uint8Array(bytes.byteLength);
  let j = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i];
    if (b === 0x0d && bytes[i + 1] === 0x0a && (bytes[i + 2] === 0x20 || bytes[i + 2] === 0x09)) { i += 2; continue; }
    if (b === 0x0a && (bytes[i + 1] === 0x20 || bytes[i + 1] === 0x09)) { i += 1; continue; }
    out[j++] = b;
  }
  return new TextDecoder("utf-8").decode(out.subarray(0, j));
}

// name *(";" param) ":" value, where parameter values may be quoted and contain ; : or ,
function parseContentLine(line) {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ";" && line[i] !== ":") i++;
  if (i >= n) return null;
  const name = line.slice(0, i).trim().toUpperCase();
  const params = {};
  while (line[i] === ";") {
    i++;
    let eq = i;
    while (eq < n && line[eq] !== "=" && line[eq] !== ";" && line[eq] !== ":") eq++;
    const key = line.slice(i, eq).trim().toUpperCase();
    i = eq;
    const values = [];
    if (line[i] === "=") {
      i++;
      for (;;) {
        if (line[i] === '"') {
          const close = line.indexOf('"', i + 1);
          values.push(close === -1 ? line.slice(i + 1) : line.slice(i + 1, close));
          i = close === -1 ? n : close + 1;
          while (i < n && line[i] !== "," && line[i] !== ";" && line[i] !== ":") i++;
        } else {
          let j = i;
          while (j < n && line[j] !== "," && line[j] !== ";" && line[j] !== ":") j++;
          values.push(line.slice(i, j));
          i = j;
        }
        if (line[i] !== ",") break;
        i++;
      }
    }
    if (key) params[key] = values.join(",");
  }
  if (line[i] !== ":") return null;
  return { name, params, value: line.slice(i + 1) };
}

function readComponents(text) {
  const events = [];
  const stack = [];
  let skippedDepth = 0;
  let sawCalendar = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line) continue;
    const prop = parseContentLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const name = prop.value.trim().toUpperCase();
      if (name === "VCALENDAR") sawCalendar = true;
      if (stack.length >= MAX_DEPTH) skippedDepth++;
      else stack.push({ name, props: name === "VEVENT" ? new Map() : null });
    } else if (prop.name === "END") {
      if (skippedDepth > 0) { skippedDepth--; continue; }
      const name = prop.value.trim().toUpperCase();
      const at = stack.findLastIndex((frame) => frame.name === name);
      if (at === -1) continue;
      const frame = stack[at];
      stack.length = at;
      if (frame.props) events.push(frame.props);
    } else {
      // Properties of nested components (VALARM inside VEVENT) never reach the event.
      const top = stack[stack.length - 1];
      if (!top?.props) continue;
      const list = top.props.get(prop.name);
      if (list) list.push(prop);
      else top.props.set(prop.name, [prop]);
    }
  }
  return { events, sawCalendar };
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i;

// A DATE or DATE-TIME value: { allDay, dn, h, mi, s, zone, ms } or null when malformed.
function parseDateValue(raw, params, ctx, floatingZone) {
  const value = raw.trim();
  const date = DATE_RE.exec(value);
  const dateTime = date ? null : DATE_TIME_RE.exec(value);
  const m = date ?? dateTime;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const dn = dayNumber(y, mo, d);
  if (date) return { allDay: true, dn, h: 0, mi: 0, s: 0, zone: ctx.zone, ms: wallMs(dn, 0, 0, 0, ctx.zone) };
  const [h, mi] = [Number(m[4]), Number(m[5])];
  const s = Math.min(Number(m[6] ?? 0), 59);
  if (h > 23 || mi > 59) return null;
  let zone = floatingZone;
  if (m[7]) zone = "UTC";
  else if (params.TZID) {
    zone = resolveTimeZoneId(params.TZID, null);
    if (!zone) {
      ctx.warn(`Unknown time zone "${params.TZID.slice(0, 60)}"; using ${ctx.zone}.`);
      zone = ctx.zone;
    }
  }
  return { allDay: false, dn, h, mi, s, zone, ms: wallMs(dn, h, mi, s, zone) };
}

function parseDateList(props, ctx, floatingZone) {
  const values = [];
  for (const prop of props ?? []) {
    for (const piece of prop.value.split(",")) {
      // RDATE may hold PERIOD values ("start/end"); only the start is used.
      const value = parseDateValue(piece.split("/")[0], prop.params, ctx, floatingZone);
      if (value) values.push(value);
    }
  }
  return values;
}

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

// Days are nominal (calendar days in the event's zone); hours, minutes, and seconds are exact.
function parseDuration(raw) {
  const m = DURATION_RE.exec(raw.trim());
  if (!m) return null;
  const [w, d, h, mi, s] = m.slice(2).map((v) => (v ? Number(v) : 0));
  if ([w, d, h, mi, s].some((v) => v > 100_000)) return null;
  if (m[1] === "-") return { days: 0, ms: 0 };
  return { days: w * 7 + d, ms: ((h * 60 + mi) * 60 + s) * 1000 };
}

function parseByDay(token) {
  const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim());
  if (!m) return null;
  const ord = m[1] ? Number(m[1]) : 0;
  if (Math.abs(ord) > 53) return null;
  return { ord, wd: WEEKDAYS[m[2].toUpperCase()] };
}

function parseRrule(value) {
  const parts = {};
  for (const piece of value.split(";")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts[piece.slice(0, eq).trim().toUpperCase()] = piece.slice(eq + 1).trim();
  }
  const freq = (parts.FREQ ?? "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return { unsupported: `FREQ=${parts.FREQ ?? "?"}` };
  for (const key of ["BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE", "BYSECOND"]) {
    if (parts[key]) return { unsupported: key };
  }
  const ints = (text, min, max) => text.split(",").map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v !== 0 && v >= min && v <= max);
  const rule = { freq, interval: 1, count: null, until: parts.UNTIL ?? null, byDay: null, byMonthDay: null, byMonth: null, bySetPos: null, wkst: 1 };
  const interval = Number(parts.INTERVAL);
  if (Number.isInteger(interval) && interval >= 1) rule.interval = Math.min(interval, 10_000);
  const count = Number(parts.COUNT);
  if (Number.isInteger(count) && count >= 1) rule.count = count;
  if (parts.WKST && parts.WKST.toUpperCase() in WEEKDAYS) rule.wkst = WEEKDAYS[parts.WKST.toUpperCase()];
  // Duplicates are dropped, which also bounds each list (at most 7 x 107 BYDAY values, 62 month
  // days, 732 set positions), since expansion walks the lists once per period.
  const unique = (list) => [...new Set(list)];
  const byDay = (t) => {
    const seen = new Set();
    return t.split(",").map(parseByDay).filter((entry) => {
      const key = entry && `${entry.ord}:${entry.wd}`;
      if (!entry || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const lists = [["BYDAY", "byDay", byDay],
    ["BYMONTHDAY", "byMonthDay", (t) => unique(ints(t, -31, 31))],
    ["BYMONTH", "byMonth", (t) => unique(ints(t, 1, 12)).sort((a, b) => a - b)],
    ["BYSETPOS", "bySetPos", (t) => unique(ints(t, -366, 366))]];
  for (const [key, field, read] of lists) {
    if (!parts[key]) continue;
    const list = read(parts[key]);
    if (!list.length) return { unsupported: `${key}=${parts[key].slice(0, 40)}` };
    rule[field] = list;
  }
  return rule;
}

// Recurrence expansion -------------------------------------------------------------------------

function applySetPos(days, setPos) {
  if (!setPos) return days;
  const picked = new Set();
  for (const pos of setPos) {
    const dn = pos > 0 ? days[pos - 1] : days[days.length + pos];
    if (dn !== undefined) picked.add(dn);
  }
  return [...picked].sort((a, b) => a - b);
}

// Days of one month matched by BYMONTHDAY and BYDAY (ordinals count within the month).
function monthDays(y, m, rule, defaultDay) {
  const dim = daysInMonth(y, m);
  const first = dayNumber(y, m, 1);
  let days = null;
  if (rule.byMonthDay) {
    days = new Set(rule.byMonthDay.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim));
  }
  if (rule.byDay) {
    const matched = new Set();
    for (const { ord, wd } of rule.byDay) {
      const occurrences = [];
      for (let d = 1 + ((wd - weekday(first) + 7) % 7); d <= dim; d += 7) occurrences.push(d);
      if (!ord) occurrences.forEach((d) => matched.add(d));
      else {
        const d = ord > 0 ? occurrences[ord - 1] : occurrences[occurrences.length + ord];
        if (d !== undefined) matched.add(d);
      }
    }
    days = days ? new Set([...days].filter((d) => matched.has(d))) : matched;
  }
  if (!days) days = defaultDay <= dim ? [defaultDay] : [];
  return [...days].sort((a, b) => a - b).map((d) => first + d - 1);
}

function yearDays(y, rule, startMonth, startDay) {
  if (rule.byMonth) return rule.byMonth.flatMap((m) => monthDays(y, m, rule, startDay));
  if (rule.byMonthDay) return Array.from({ length: 12 }, (_, i) => monthDays(y, i + 1, rule, startDay)).flat();
  if (rule.byDay) {
    // Without BYMONTH, ordinals count within the year ("20MO" is the 20th Monday).
    const first = dayNumber(y, 1, 1);
    const last = dayNumber(y, 12, 31);
    const matched = new Set();
    for (const { ord, wd } of rule.byDay) {
      const occurrences = [];
      for (let dn = first + ((wd - weekday(first) + 7) % 7); dn <= last; dn += 7) occurrences.push(dn);
      if (!ord) occurrences.forEach((dn) => matched.add(dn));
      else {
        const dn = ord > 0 ? occurrences[ord - 1] : occurrences[occurrences.length + ord];
        if (dn !== undefined) matched.add(dn);
      }
    }
    return [...matched].sort((a, b) => a - b);
  }
  return startDay <= daysInMonth(y, startMonth) ? [dayNumber(y, startMonth, startDay)] : [];
}

// Calls emit(dayNumber, startMs) for each RRULE instance, in order, until the rule ends, the
// instances pass the range, or the shared work budget runs out.
function expandRule(event, rule, ctx, emit) {
  const { start } = event;
  const startDn = start.dn;
  const [y0, m0, d0] = ymd(startDn);
  const { interval } = rule;

  let until = null;
  if (rule.until) {
    until = parseDateValue(rule.until, {}, ctx, start.zone);
    if (!until) ctx.warn(`Ignored an UNTIL value that isn't a date: "${rule.until.slice(0, 40)}".`);
  }
  const untilDn = !until ? Infinity : until.allDay ? until.dn : zonedDay(until.ms, start.zone);
  const untilMs = until && !until.allDay ? until.ms : Infinity;

  // Instances that start before lowDn end before the range starts, and those after highDn start
  // after it ends, so only the days in between are converted to instants.
  const span = event.duration.days * DAY_MS + event.duration.ms + DAY_MS;
  const lowDn = ctx.rangeStart === -Infinity ? -Infinity : zonedDay(ctx.rangeStart - span, start.zone) - 2;
  const highDn = ctx.rangeEnd === Infinity ? MAX_DAY : Math.min(MAX_DAY, zonedDay(ctx.rangeEnd, start.zone) + 2);

  const weekStart = startDn - ((weekday(startDn) - rule.wkst + 7) % 7);
  const weekOffsets = [...new Set((rule.byDay ?? [{ wd: weekday(startDn) }]).map(({ wd }) => (wd - rule.wkst + 7) % 7))]
    .sort((a, b) => a - b);
  const byDaySet = rule.byDay ? new Set(rule.byDay.map(({ wd }) => wd)) : null;
  const monthIndex0 = y0 * 12 + (m0 - 1);

  const period = (k) => {
    switch (rule.freq) {
      case "DAILY": {
        const dn = startDn + k * interval;
        const [y, m, d] = ymd(dn);
        const dim = daysInMonth(y, m);
        const ok = (!rule.byMonth || rule.byMonth.includes(m))
          && (!rule.byMonthDay || rule.byMonthDay.some((v) => (v > 0 ? v : dim + v + 1) === d))
          && (!byDaySet || byDaySet.has(weekday(dn)));
        return { first: dn, days: ok ? [dn] : [] };
      }
      case "WEEKLY": {
        const first = weekStart + k * 7 * interval;
        const days = weekOffsets.map((offset) => first + offset)
          .filter((dn) => !rule.byMonth || rule.byMonth.includes(ymd(dn)[1]));
        return { first, days: applySetPos(days, rule.bySetPos) };
      }
      case "MONTHLY": {
        const index = monthIndex0 + k * interval;
        const [y, m] = [Math.floor(index / 12), (index % 12) + 1];
        if (y > 9999) return null;
        const days = rule.byMonth && !rule.byMonth.includes(m) ? [] : monthDays(y, m, rule, d0);
        return { first: dayNumber(y, m, 1), days: applySetPos(days, rule.bySetPos) };
      }
      default: {
        const y = y0 + k * interval;
        if (y > 9999) return null;
        return { first: dayNumber(y, 1, 1), days: applySetPos(yearDays(y, rule, m0, d0), rule.bySetPos) };
      }
    }
  };

  // Without COUNT, nothing before the range affects the result, so skip straight to it.
  let k = 0;
  if (!rule.count && lowDn > startDn) {
    const [ly, lm] = ymd(lowDn);
    const periods = rule.freq === "DAILY" ? (lowDn - startDn) / interval
      : rule.freq === "WEEKLY" ? (lowDn - weekStart) / (7 * interval)
        : rule.freq === "MONTHLY" ? (ly * 12 + lm - 1 - monthIndex0) / interval
          : (ly - y0) / interval;
    k = Math.max(0, Math.floor(periods) - 1);
  }

  let count = 0;
  const take = (dn) => {
    if (dn > highDn || dn > untilDn) return false;
    if (!ctx.spend("steps")) return false;
    if (dn >= lowDn) {
      if (!ctx.spend("instances")) return false;
      const ms = wallMs(dn, start.h, start.mi, start.s, start.zone);
      if (ms > untilMs) return false;
      emit(dn, ms);
    }
    count++;
    return !(rule.count && count >= rule.count);
  };

  // DTSTART is always the first instance.
  if (k === 0 && !take(startDn)) return;
  for (; ; k++) {
    if (!ctx.spend("steps")) return;
    const p = period(k);
    if (!p || p.first > highDn || p.first > untilDn) return;
    for (const dn of p.days) {
      if (dn > startDn && !take(dn)) return;
    }
  }
}

// Events ---------------------------------------------------------------------------------------

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function readEvent(props, ctx) {
  const first = (name) => props.get(name)?.[0];
  const text = (name) => (first(name) ? unescapeText(first(name).value).trim() : null);

  const recurrenceProp = first("RECURRENCE-ID");
  const startProp = first("DTSTART") ?? recurrenceProp;
  if (!startProp) return null;
  const start = parseDateValue(startProp.value, startProp.params, ctx, ctx.zone);
  if (!start) {
    ctx.warn(`Skipped an event with a start that isn't a date: "${startProp.value.slice(0, 40)}".`);
    return null;
  }

  let duration = start.allDay ? { days: 1, ms: 0 } : { days: 0, ms: 0 };
  const endProp = first("DTEND");
  const end = endProp ? parseDateValue(endProp.value, endProp.params, ctx, start.zone) : null;
  if (end) {
    duration = start.allDay && end.allDay
      ? { days: Math.max(1, end.dn - start.dn), ms: 0 }
      : { days: 0, ms: Math.max(0, end.ms - start.ms) };
  } else if (first("DURATION")) {
    duration = parseDuration(first("DURATION").value) ?? duration;
  }

  const summary = text("SUMMARY");
  let uid = first("UID")?.value.trim() || `generated-${fnv1a(`${startProp.value}|${summary ?? ""}|${text("LOCATION") ?? ""}`)}`;
  // Real UIDs are short. A huge one is replaced by its digest, because it becomes part of a key
  // for every occurrence (thousands of copies of a 100 KB string otherwise).
  if (uid.length > MAX_UID_LENGTH) uid = `sha256-${createHash("sha256").update(uid).digest("hex")}`;
  const recurrence = recurrenceProp ? parseDateValue(recurrenceProp.value, recurrenceProp.params, ctx, start.zone) : null;
  const rruleProp = first("RRULE");
  let rule = null;
  if (rruleProp && !recurrenceProp) {
    rule = parseRrule(rruleProp.value);
    if (rule.unsupported) {
      ctx.warn(`Showed only the first date of a repeating event that uses ${rule.unsupported}.`);
      rule = null;
    }
  }

  return {
    uid,
    summary,
    location: text("LOCATION"),
    description: text("DESCRIPTION"),
    status: (first("STATUS")?.value ?? "").trim().toUpperCase(),
    cls: first("CLASS") ? first("CLASS").value.trim().toUpperCase() : null,
    sequence: Number(first("SEQUENCE")?.value) || 0,
    start,
    duration,
    rule,
    recurrence,
    exdates: rule ? parseDateList(props.get("EXDATE"), ctx, start.zone) : [],
    rdates: recurrenceProp ? [] : parseDateList(props.get("RDATE"), ctx, start.zone),
  };
}

function toMs(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (Number.isNaN(ms)) throw new TypeError(`${name} must be a Date.`);
  return ms;
}

/**
 * Parses an iCalendar feed (text or UTF-8 bytes) into occurrences that overlap
 * [rangeStart, rangeEnd], sorted by start:
 *   [{ uid, summary, location, description, start: Date, end: Date, allDay }]
 *
 * options.defaultTimeZone  zone for floating times, all-day dates, and unknown TZIDs ("UTC")
 * options.rangeStart/End   Dates; omit for an open range (recurrences then run to the caps)
 * options.onWarning(text)  called for skipped or simplified data and when a cap is reached
 * options.includePrivate   keep CLASS:PRIVATE and CONFIDENTIAL events (default false)
 * options.maxBytes, maxInstances, maxSteps  override the caps
 *
 * Cancelled events and cancelled instances are left out. Throws when the input is too large or
 * is not an iCalendar feed.
 */
export function parseIcs(input, options = {}) {
  const {
    defaultTimeZone = "UTC",
    rangeStart,
    rangeEnd,
    onWarning,
    includePrivate = false,
    maxBytes = MAX_ICS_BYTES,
    maxInstances = MAX_INSTANCES,
    maxSteps = MAX_STEPS,
  } = options;
  if (!isValidTimeZone(defaultTimeZone)) throw new RangeError(`Unknown time zone "${defaultTimeZone}".`);

  const warnings = new Set();
  const budget = { instances: maxInstances, steps: maxSteps };
  const ctx = {
    zone: defaultTimeZone,
    rangeStart: toMs(rangeStart, -Infinity, "rangeStart"),
    rangeEnd: toMs(rangeEnd, Infinity, "rangeEnd"),
    warn(message) {
      if (warnings.has(message) || warnings.size >= MAX_WARNINGS) return;
      warnings.add(message);
      onWarning?.(message);
    },
    spend(kind) {
      if (budget[kind] > 0) {
        budget[kind]--;
        return true;
      }
      ctx.warn(`Stopped expanding repeating events after ${kind === "steps" ? maxSteps : maxInstances} ${kind}; some dates may be missing.`);
      return false;
    },
  };

  const { events: components, sawCalendar } = readComponents(toText(input, maxBytes));
  if (!sawCalendar) throw new TypeError("This is not an iCalendar feed (no BEGIN:VCALENDAR).");

  const records = components.map((props) => readEvent(props, ctx)).filter(Boolean);
  const masters = new Map();
  const overrides = [];
  for (const record of records) {
    if (record.recurrence) overrides.push(record);
    else {
      const current = masters.get(record.uid);
      if (!current || record.sequence >= current.sequence) masters.set(record.uid, record);
    }
  }

  // Overridden instances, by master UID: exact instants, or days for date-only RECURRENCE-IDs.
  const replaced = new Map();
  for (const override of overrides) {
    let keys = replaced.get(override.uid);
    if (!keys) replaced.set(override.uid, (keys = { instants: new Set(), days: new Set() }));
    if (override.recurrence.allDay) keys.days.add(override.recurrence.dn);
    else keys.instants.add(override.recurrence.ms);
    const master = masters.get(override.uid);
    if (master) {
      for (const field of ["summary", "location", "description", "cls"]) override[field] ??= master[field];
    }
  }

  const hidden = (record) => record.status === "CANCELLED"
    || (!includePrivate && (record.cls === "PRIVATE" || record.cls === "CONFIDENTIAL"));
  const out = [];
  const seen = new Set();
  const add = (record, dn, ms) => {
    const key = `${record.uid}\n${ms}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { start, duration } = record;
    const endMs = Math.max(ms, (duration.days ? wallMs(dn + duration.days, start.h, start.mi, start.s, start.zone) : ms) + duration.ms);
    const overlaps = ms < ctx.rangeEnd && (endMs > ctx.rangeStart || (endMs === ms && ms >= ctx.rangeStart));
    if (!overlaps) return;
    out.push({
      uid: record.uid,
      summary: record.summary ?? "",
      location: record.location ?? "",
      description: record.description ?? "",
      start: new Date(ms),
      end: new Date(endMs),
      allDay: start.allDay,
    });
  };

  // Overrides first, so one that lands on the same instant as a generated instance wins.
  for (const override of overrides) {
    if (!hidden(override)) add(override, override.start.dn, override.start.ms);
  }

  for (const master of masters.values()) {
    if (hidden(master)) continue;
    if (!master.rule && !master.rdates.length) {
      add(master, master.start.dn, master.start.ms);
      continue;
    }
    const keys = replaced.get(master.uid);
    const exInstants = new Set(master.exdates.filter((v) => !v.allDay).map((v) => v.ms));
    const exDays = new Set(master.exdates.filter((v) => v.allDay).map((v) => v.dn));
    const emit = (dn, ms) => {
      if (exInstants.has(ms) || exDays.has(dn) || keys?.instants.has(ms) || keys?.days.has(dn)) return;
      add(master, dn, ms);
    };
    if (master.rule) expandRule(master, master.rule, ctx, emit);
    else emit(master.start.dn, master.start.ms);
    for (const rdate of master.rdates) {
      if (!ctx.spend("instances")) break;
      emit(rdate.allDay ? rdate.dn : zonedDay(rdate.ms, master.start.zone), rdate.ms);
    }
  }

  return out.sort((a, b) => a.start - b.start || a.end - b.end || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}
