import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ICS_BYTES, WINDOWS_TIME_ZONES, parseIcs, resolveTimeZoneId, unescapeText } from "../ics.mjs";
import { isValidTimeZone, parseLocalDateTime, zonedWallTimeToUtc } from "../time.mjs";

const NY = "America/New_York";
const iso = (date) => date.toISOString();

// Wraps VEVENT lines in a calendar with CRLF line endings, as feeds send them.
function calendar(body) {
  const lines = body.replace(/^\n+|\s+$/g, "").split("\n").map((line) => line.trimStart());
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
}

const RANGE = { rangeStart: new Date("2026-10-01T00:00:00Z"), rangeEnd: new Date("2027-01-01T00:00:00Z") };

function parse(body, options = {}) {
  return parseIcs(calendar(body), { defaultTimeZone: NY, ...RANGE, ...options });
}

describe("time.mjs", () => {
  test("converts wall time in New York on both sides of daylight saving time", () => {
    assert.equal(iso(zonedWallTimeToUtc(2026, 10, 24, 9, 0, 0, NY)), "2026-10-24T13:00:00.000Z");
    assert.equal(iso(zonedWallTimeToUtc(2026, 11, 7, 9, 0, 0, NY)), "2026-11-07T14:00:00.000Z");
    assert.equal(iso(zonedWallTimeToUtc(2026, 6, 1, 9, 0, 0, "Asia/Kolkata")), "2026-06-01T03:30:00.000Z");
    assert.equal(iso(zonedWallTimeToUtc(2026, 1, 15, 12, 0, 0, "UTC")), "2026-01-15T12:00:00.000Z");
  });

  test("the repeated hour resolves to the first (daylight) occurrence", () => {
    assert.equal(iso(zonedWallTimeToUtc(2026, 11, 1, 1, 30, 0, NY)), "2026-11-01T05:30:00.000Z");
    assert.equal(iso(zonedWallTimeToUtc(2026, 4, 5, 2, 30, 0, "Australia/Sydney")), "2026-04-04T15:30:00.000Z");
  });

  test("the skipped hour moves forward by the size of the gap", () => {
    assert.equal(iso(zonedWallTimeToUtc(2026, 3, 8, 2, 30, 0, NY)), "2026-03-08T07:30:00.000Z"); // 3:30 EDT
    assert.equal(iso(zonedWallTimeToUtc(2026, 10, 4, 2, 30, 0, "Australia/Sydney")), "2026-10-03T16:30:00.000Z");
    // Lord Howe moves its clocks by 30 minutes.
    assert.equal(iso(zonedWallTimeToUtc(2026, 10, 4, 2, 15, 0, "Australia/Lord_Howe")), "2026-10-03T15:45:00.000Z");
  });

  test("parseLocalDateTime reads schedule.json times", () => {
    assert.equal(iso(parseLocalDateTime("2026-10-24T09:00", NY)), "2026-10-24T13:00:00.000Z");
    assert.equal(iso(parseLocalDateTime("2026-11-04T17:00:30", NY)), "2026-11-04T22:00:30.000Z");
    assert.equal(iso(parseLocalDateTime("2026-10-24", NY)), "2026-10-24T04:00:00.000Z");
    assert.equal(iso(parseLocalDateTime("2026-10-24T09:00Z", NY)), "2026-10-24T09:00:00.000Z");
    assert.equal(iso(parseLocalDateTime("2026-10-24T09:00-05:00", NY)), "2026-10-24T14:00:00.000Z");
    for (const bad of ["2026-02-30T09:00", "2026-10-24T24:00", "9am Saturday", "", null, "2026-13-01T09:00"]) {
      assert.throws(() => parseLocalDateTime(bad, NY), RangeError, String(bad));
    }
    assert.throws(() => parseLocalDateTime("2026-10-24T09:00", "Not/AZone"), RangeError);
  });

  test("isValidTimeZone", () => {
    assert.equal(isValidTimeZone(NY), true);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Eastern Standard Time"), false);
    assert.equal(isValidTimeZone(""), false);
    assert.equal(isValidTimeZone(undefined), false);
  });
});

describe("parseIcs basics", () => {
  test("unfolds CRLF and LF continuation lines and unescapes text", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:fold-1",
      "DTSTART:20261024T130000Z",
      "DTEND:20261024T170000Z",
      "SUMMARY:Fall Classic Soccer\r\n  Tournament",
      "LOCATION:Riverside Sports Complex\\, 1200 River Rd\\, Springfield",
      "DESCRIPTION:Line one\\nLine two\\; with semicolon\\, comma and \\\\ backslash",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n").replace("Line two", "Line\n\ttwo");
    const [event] = parseIcs(text, { defaultTimeZone: NY });
    assert.equal(event.summary, "Fall Classic Soccer Tournament");
    assert.equal(event.location, "Riverside Sports Complex, 1200 River Rd, Springfield");
    assert.equal(event.description, "Line one\nLinetwo; with semicolon, comma and \\ backslash");
    assert.equal(unescapeText("a\\Nb\\,c"), "a\nb,c");
  });

  test("unfolds bytes before decoding, so a fold inside a multi-byte character is safe", () => {
    const head = new TextEncoder().encode("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261024T130000Z\r\nSUMMARY:Caf");
    const e = new TextEncoder().encode("é"); // two bytes
    const tail = new TextEncoder().encode(" con leche\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
    const bytes = new Uint8Array([...head, e[0], 0x0d, 0x0a, 0x20, e[1], ...tail]);
    const [event] = parseIcs(bytes, { defaultTimeZone: NY });
    assert.equal(event.summary, "Café con leche");
  });

  test("UTC, TZID (plain and quoted), floating, and all-day values", () => {
    const events = parse(`
      BEGIN:VEVENT
      UID:utc
      DTSTART:20261024T130000Z
      DTEND:20261024T170000Z
      END:VEVENT
      BEGIN:VEVENT
      UID:tzid
      DTSTART;TZID=America/Chicago:20261025T090000
      DTEND;TZID="America/Chicago":20261025T120000
      END:VEVENT
      BEGIN:VEVENT
      UID:floating
      DTSTART:20261026T090000
      DTEND:20261026T110000
      END:VEVENT
      BEGIN:VEVENT
      UID:allday
      DTSTART;VALUE=DATE:20261027
      DTEND;VALUE=DATE:20261029
      END:VEVENT
      BEGIN:VEVENT
      UID:allday-no-end
      DTSTART;VALUE=DATE:20261030
      END:VEVENT
    `);
    const byUid = Object.fromEntries(events.map((e) => [e.uid, e]));
    assert.deepEqual([iso(byUid.utc.start), iso(byUid.utc.end), byUid.utc.allDay], ["2026-10-24T13:00:00.000Z", "2026-10-24T17:00:00.000Z", false]);
    assert.deepEqual([iso(byUid.tzid.start), iso(byUid.tzid.end)], ["2026-10-25T14:00:00.000Z", "2026-10-25T17:00:00.000Z"]);
    assert.deepEqual([iso(byUid.floating.start), iso(byUid.floating.end)], ["2026-10-26T13:00:00.000Z", "2026-10-26T15:00:00.000Z"]);
    assert.deepEqual([iso(byUid.allday.start), iso(byUid.allday.end), byUid.allday.allDay], ["2026-10-27T04:00:00.000Z", "2026-10-29T04:00:00.000Z", true]);
    assert.deepEqual([iso(byUid["allday-no-end"].start), iso(byUid["allday-no-end"].end)], ["2026-10-30T04:00:00.000Z", "2026-10-31T04:00:00.000Z"]);
  });

  test("maps Windows time zone ids from Outlook and falls back for unknown ones", () => {
    const warnings = [];
    const events = parse(`
      BEGIN:VEVENT
      UID:eastern
      DTSTART;TZID=Eastern Standard Time:20261024T090000
      END:VEVENT
      BEGIN:VEVENT
      UID:central
      DTSTART;TZID=Central Standard Time:20261024T090000
      END:VEVENT
      BEGIN:VEVENT
      UID:mountain
      DTSTART;TZID=Mountain Standard Time:20261024T090000
      END:VEVENT
      BEGIN:VEVENT
      UID:pacific
      DTSTART;TZID=Pacific Standard Time:20261024T090000
      END:VEVENT
      BEGIN:VEVENT
      UID:london
      DTSTART;TZID=GMT Standard Time:20261024T090000
      END:VEVENT
      BEGIN:VEVENT
      UID:display-name
      DTSTART;TZID="(UTC-06:00) Central Time (US & Canada)":20261024T090000
      END:VEVENT
      BEGIN:VEVENT
      UID:mozilla
      DTSTART;TZID=/mozilla.org/20050126_1/America/Denver:20261024T090000
      END:VEVENT
      BEGIN:VEVENT
      UID:unknown
      DTSTART;TZID=Customized Time Zone:20261024T090000
      END:VEVENT
    `, { onWarning: (message) => warnings.push(message) });
    const start = Object.fromEntries(events.map((e) => [e.uid, iso(e.start)]));
    assert.equal(start.eastern, "2026-10-24T13:00:00.000Z");
    assert.equal(start.central, "2026-10-24T14:00:00.000Z");
    assert.equal(start.mountain, "2026-10-24T15:00:00.000Z");
    assert.equal(start.pacific, "2026-10-24T16:00:00.000Z");
    assert.equal(start.london, "2026-10-24T08:00:00.000Z"); // British Summer Time
    assert.equal(start["display-name"], "2026-10-24T14:00:00.000Z");
    assert.equal(start.mozilla, "2026-10-24T15:00:00.000Z");
    assert.equal(start.unknown, "2026-10-24T13:00:00.000Z"); // default zone, New York
    assert.ok(warnings.some((w) => w.includes("Customized Time Zone")));
  });

  test("every Windows mapping is a time zone this runtime knows", () => {
    for (const [windows, iana] of Object.entries(WINDOWS_TIME_ZONES)) {
      assert.ok(isValidTimeZone(iana), `${windows} -> ${iana}`);
    }
    assert.equal(resolveTimeZoneId("eastern standard time", "UTC"), NY);
    assert.equal(resolveTimeZoneId("Nowhere/Special", "UTC"), "UTC");
  });

  test("uses DURATION when DTEND is missing", () => {
    const events = parse(`
      BEGIN:VEVENT
      UID:short
      DTSTART;TZID=America/New_York:20261024T090000
      DURATION:PT2H30M
      END:VEVENT
      BEGIN:VEVENT
      UID:day
      DTSTART;TZID=America/New_York:20261031T120000
      DURATION:P1D
      END:VEVENT
    `);
    const byUid = Object.fromEntries(events.map((e) => [e.uid, e]));
    assert.equal(iso(byUid.short.end), "2026-10-24T15:30:00.000Z");
    // A nominal day across the DST change ends at the same wall time: noon EST.
    assert.equal(iso(byUid.day.end), "2026-11-01T17:00:00.000Z");
  });

  test("drops cancelled and private events and ignores VALARM properties", () => {
    const events = parse(`
      BEGIN:VEVENT
      UID:keep
      DTSTART:20261024T130000Z
      SUMMARY:Keep me
      DESCRIPTION:Event notes
      BEGIN:VALARM
      ACTION:DISPLAY
      DESCRIPTION:Reminder text
      TRIGGER:-PT30M
      END:VALARM
      END:VEVENT
      BEGIN:VEVENT
      UID:cancelled
      DTSTART:20261025T130000Z
      STATUS:CANCELLED
      END:VEVENT
      BEGIN:VEVENT
      UID:private
      DTSTART:20261026T130000Z
      CLASS:PRIVATE
      END:VEVENT
    `);
    assert.deepEqual(events.map((e) => e.uid), ["keep"]);
    assert.equal(events[0].description, "Event notes");
  });

  test("returns only occurrences that overlap the range", () => {
    const events = parseIcs(calendar(`
      BEGIN:VEVENT
      UID:before
      DTSTART:20261020T130000Z
      DTEND:20261020T170000Z
      END:VEVENT
      BEGIN:VEVENT
      UID:straddles-start
      DTSTART:20261021T220000Z
      DTEND:20261022T020000Z
      END:VEVENT
      BEGIN:VEVENT
      UID:inside
      DTSTART:20261023T130000Z
      DTEND:20261023T170000Z
      END:VEVENT
      BEGIN:VEVENT
      UID:after
      DTSTART:20261101T130000Z
      DTEND:20261101T170000Z
      END:VEVENT
    `), { defaultTimeZone: NY, rangeStart: new Date("2026-10-22T00:00:00Z"), rangeEnd: new Date("2026-10-31T00:00:00Z") });
    assert.deepEqual(events.map((e) => e.uid), ["straddles-start", "inside"]);
  });

  test("refuses input that is too large or not a calendar", () => {
    assert.throws(() => parseIcs("x".repeat(MAX_ICS_BYTES + 1)), /larger than 2 MB/);
    assert.throws(() => parseIcs(new Uint8Array(MAX_ICS_BYTES + 1)), /larger than 2 MB/);
    assert.throws(() => parseIcs("<html><body>Not found</body></html>"), /not an iCalendar feed/);
  });
});

describe("recurrence", () => {
  test("a weekly 9 AM stop stays at 9 AM across the November 2026 DST change", () => {
    const events = parse(`
      BEGIN:VEVENT
      UID:weekly
      DTSTART;TZID=America/New_York:20261024T090000
      DTEND;TZID=America/New_York:20261024T130000
      RRULE:FREQ=WEEKLY;BYDAY=SA
      END:VEVENT
    `, { rangeEnd: new Date("2026-11-15T00:00:00Z") });
    assert.deepEqual(events.map((e) => iso(e.start)), [
      "2026-10-24T13:00:00.000Z",
      "2026-10-31T13:00:00.000Z",
      "2026-11-07T14:00:00.000Z",
      "2026-11-14T14:00:00.000Z",
    ]);
    assert.deepEqual(events.map((e) => (e.end - e.start) / 3600000), [4, 4, 4, 4]);
  });

  test("WEEKLY with several BYDAY values and INTERVAL", () => {
    const events = parse(`
      BEGIN:VEVENT
      UID:biweekly
      DTSTART;TZID=America/New_York:20261006T180000
      RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=6
      END:VEVENT
    `);
    assert.deepEqual(events.map((e) => iso(e.start).slice(0, 10)), [
      "2026-10-06", "2026-10-08", "2026-10-20", "2026-10-22", "2026-11-03", "2026-11-05",
    ]);
  });

  test("COUNT, UNTIL, and EXDATE (several, with TZID)", () => {
    const events = parse(`
      BEGIN:VEVENT
      UID:counted
      DTSTART;TZID=America/New_York:20261005T090000
      RRULE:FREQ=DAILY;COUNT=3
      END:VEVENT
      BEGIN:VEVENT
      UID:until
      DTSTART;TZID=America/New_York:20261010T090000
      RRULE:FREQ=DAILY;UNTIL=20261012T130000Z
      END:VEVENT
      BEGIN:VEVENT
      UID:excluded
      DTSTART;TZID=America/New_York:20261101T100000
      RRULE:FREQ=DAILY;COUNT=6
      EXDATE;TZID=America/New_York:20261102T100000,20261104T100000
      EXDATE:20261105T150000Z
      END:VEVENT
    `);
    const days = (uid) => events.filter((e) => e.uid === uid).map((e) => iso(e.start));
    assert.deepEqual(days("counted"), ["2026-10-05T13:00:00.000Z", "2026-10-06T13:00:00.000Z", "2026-10-07T13:00:00.000Z"]);
    assert.deepEqual(days("until"), ["2026-10-10T13:00:00.000Z", "2026-10-11T13:00:00.000Z", "2026-10-12T13:00:00.000Z"]);
    // COUNT counts the excluded dates too (RFC 5545): Nov 1-6, minus 2, 4, and 5.
    assert.deepEqual(days("excluded"), ["2026-11-01T15:00:00.000Z", "2026-11-03T15:00:00.000Z", "2026-11-06T15:00:00.000Z"]);
  });

  test("a RECURRENCE-ID override replaces its instance, and a cancelled one removes it", () => {
    const events = parse(`
      BEGIN:VEVENT
      UID:series@example.com
      DTSTART;TZID=America/New_York:20261024T090000
      DTEND;TZID=America/New_York:20261024T120000
      RRULE:FREQ=WEEKLY;COUNT=4
      SUMMARY:Saturday market
      LOCATION:Riverside Sports Complex
      END:VEVENT
      BEGIN:VEVENT
      UID:series@example.com
      RECURRENCE-ID;TZID=America/New_York:20261031T090000
      DTSTART;TZID=America/New_York:20261031T130000
      DTEND;TZID=America/New_York:20261031T170000
      SUMMARY:Saturday market (afternoon)
      END:VEVENT
      BEGIN:VEVENT
      UID:series@example.com
      RECURRENCE-ID;TZID=America/New_York:20261107T090000
      DTSTART;TZID=America/New_York:20261107T090000
      STATUS:CANCELLED
      END:VEVENT
    `);
    assert.deepEqual(events.map((e) => [iso(e.start), e.summary, e.location]), [
      ["2026-10-24T13:00:00.000Z", "Saturday market", "Riverside Sports Complex"],
      ["2026-10-31T17:00:00.000Z", "Saturday market (afternoon)", "Riverside Sports Complex"],
      ["2026-11-14T14:00:00.000Z", "Saturday market", "Riverside Sports Complex"],
    ]);
  });

  test("a cancelled recurring event is dropped entirely", () => {
    const events = parse(`
      BEGIN:VEVENT
      UID:gone
      DTSTART;TZID=America/New_York:20261024T090000
      RRULE:FREQ=WEEKLY
      STATUS:CANCELLED
      END:VEVENT
    `);
    assert.deepEqual(events, []);
  });

  test("MONTHLY by month day, by ordinal weekday, and BYSETPOS", () => {
    const events = parse(`
      BEGIN:VEVENT
      UID:mid-and-last
      DTSTART;VALUE=DATE:20261015
      RRULE:FREQ=MONTHLY;BYMONTHDAY=15,-1;COUNT=5
      END:VEVENT
      BEGIN:VEVENT
      UID:31st
      DTSTART;VALUE=DATE:20261031
      RRULE:FREQ=MONTHLY;COUNT=2
      END:VEVENT
      BEGIN:VEVENT
      UID:second-saturday
      DTSTART;TZID=America/New_York:20261010T100000
      RRULE:FREQ=MONTHLY;BYDAY=2SA
      END:VEVENT
      BEGIN:VEVENT
      UID:last-friday
      DTSTART;TZID=America/New_York:20261030T180000
      RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3
      END:VEVENT
      BEGIN:VEVENT
      UID:last-weekday
      DTSTART;TZID=America/New_York:20261030T170000
      RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3
      END:VEVENT
    `);
    const days = (uid) => events.filter((e) => e.uid === uid).map((e) => {
      const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: NY }).format(e.start).split("-");
      return `${y}-${m}-${d}`;
    });
    assert.deepEqual(days("mid-and-last"), ["2026-10-15", "2026-10-31", "2026-11-15", "2026-11-30", "2026-12-15"]);
    assert.deepEqual(days("31st"), ["2026-10-31", "2026-12-31"]); // November has no 31st
    assert.deepEqual(days("second-saturday"), ["2026-10-10", "2026-11-14", "2026-12-12"]);
    assert.deepEqual(days("last-friday"), ["2026-10-30", "2026-11-27", "2026-12-25"]);
    assert.deepEqual(days("last-weekday"), ["2026-10-30", "2026-11-30", "2026-12-31"]);
  });

  test("YEARLY repeats on the same date, skipping Feb 29 in common years", () => {
    const events = parseIcs(calendar(`
      BEGIN:VEVENT
      UID:anniversary
      DTSTART;VALUE=DATE:20201107
      RRULE:FREQ=YEARLY
      END:VEVENT
      BEGIN:VEVENT
      UID:leap
      DTSTART;VALUE=DATE:20240229
      RRULE:FREQ=YEARLY;COUNT=3
      END:VEVENT
    `), { defaultTimeZone: NY, rangeStart: new Date("2026-01-01T00:00:00Z"), rangeEnd: new Date("2033-01-01T00:00:00Z") });
    assert.deepEqual(events.filter((e) => e.uid === "anniversary").map((e) => iso(e.start).slice(0, 4)),
      ["2026", "2027", "2028", "2029", "2030", "2031", "2032"]);
    // COUNT=3 covers 2024, 2028, 2032; only 2028 and 2032 are in range.
    assert.deepEqual(events.filter((e) => e.uid === "leap").map((e) => iso(e.start).slice(0, 10)), ["2028-02-29", "2032-02-29"]);
  });

  test("a long-running daily event skips ahead to the range instead of using up the cap", () => {
    const warnings = [];
    const events = parse(`
      BEGIN:VEVENT
      UID:since-2001
      DTSTART;TZID=America/New_York:20010101T070000
      DTEND;TZID=America/New_York:20010101T080000
      RRULE:FREQ=DAILY
      END:VEVENT
    `, { rangeStart: new Date("2026-10-20T00:00:00Z"), rangeEnd: new Date("2026-10-27T00:00:00Z"), maxInstances: 50, onWarning: (w) => warnings.push(w) });
    assert.equal(events.length, 7);
    assert.equal(iso(events[0].start), "2026-10-20T11:00:00.000Z");
    assert.deepEqual(warnings, []);
  });

  test("expansion is capped so a hostile feed cannot hang the server", () => {
    const warnings = [];
    const started = performance.now();
    const events = parseIcs(calendar(`
      BEGIN:VEVENT
      UID:every-day-forever
      DTSTART:20260101T120000Z
      RRULE:FREQ=DAILY;COUNT=100000000
      END:VEVENT
      BEGIN:VEVENT
      UID:never-matches
      DTSTART:20260101T120000Z
      RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30
      END:VEVENT
    `), { defaultTimeZone: NY, onWarning: (w) => warnings.push(w) }); // no range at all
    assert.ok(events.length <= 5000, `${events.length} occurrences`);
    assert.ok(warnings.some((w) => w.startsWith("Stopped expanding")));
    assert.ok(performance.now() - started < 5000, "took too long");

    // Thousands of yearly rules starting in year 1000 share one step budget.
    const many = Array.from({ length: 2000 }, (_, i) =>
      `BEGIN:VEVENT\nUID:old-${i}\nDTSTART:10000101T120000Z\nRRULE:FREQ=YEARLY;COUNT=9000\nEND:VEVENT`).join("\n");
    const start2 = performance.now();
    parseIcs(calendar(many), { defaultTimeZone: NY, ...RANGE });
    assert.ok(performance.now() - start2 < 5000, "shared budget took too long");
  });
});

describe("hostile input stays fast", () => {
  // Each of these took from several seconds to hours before the parser bounded the work.
  const timed = (fn) => {
    const started = performance.now();
    const result = fn();
    return { result, ms: performance.now() - started };
  };

  test("a TZID made of thousands of path segments", () => {
    const tzid = Array.from({ length: 40_000 }, () => "a").join("/");
    const warnings = [];
    const { result: events, ms } = timed(() => parse(`
      BEGIN:VEVENT
      UID:many-segments
      DTSTART;TZID=${tzid}:20261024T090000
      DTEND;TZID=${tzid}:20261024T170000
      EXDATE;TZID=${tzid}:20261024T090000
      END:VEVENT
    `, { onWarning: (w) => warnings.push(w) }));
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
    assert.equal(iso(events[0].start), "2026-10-24T13:00:00.000Z"); // unknown zone: New York
    assert.ok(warnings.some((w) => w.startsWith("Unknown time zone")));
    assert.ok(warnings.every((w) => w.length < 200), "warnings quote only the start of the TZID");
  });

  test("BYDAY, BYMONTHDAY, and BYSETPOS lists with thousands of repeated values", () => {
    const repeat = (value, n) => Array.from({ length: n }, () => value).join(",");
    const { result: events, ms } = timed(() => parse(`
      BEGIN:VEVENT
      UID:yearly-mondays
      DTSTART;TZID=America/New_York:10000106T090000
      RRULE:FREQ=YEARLY;COUNT=100000000;BYDAY=${repeat("MO", 10_000)}
      END:VEVENT
      BEGIN:VEVENT
      UID:daily-24th
      DTSTART;TZID=America/New_York:10000101T090000
      RRULE:FREQ=DAILY;COUNT=100000000;BYMONTHDAY=${repeat("24", 10_000)}
      END:VEVENT
      BEGIN:VEVENT
      UID:monthly-last
      DTSTART;TZID=America/New_York:10000101T090000
      RRULE:FREQ=MONTHLY;COUNT=100000000;BYDAY=${repeat("SA", 5_000)};BYSETPOS=${repeat("-1", 5_000)}
      END:VEVENT
    `));
    assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
    assert.ok(Array.isArray(events));

    // The rules still mean what they say, with duplicates ignored.
    const dates = parse(`
      BEGIN:VEVENT
      UID:monthly-last-saturday
      DTSTART;TZID=America/New_York:20261003T090000
      RRULE:FREQ=MONTHLY;COUNT=4;BYDAY=${repeat("SA", 50)},-1SA,-1SA;BYSETPOS=-1,-1,-1
      END:VEVENT
      BEGIN:VEVENT
      UID:mondays
      DTSTART;TZID=America/New_York:20261005T090000
      RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=MO,MO,MO
      END:VEVENT
    `).map((e) => `${e.uid} ${iso(e.start).slice(0, 10)}`);
    assert.deepEqual(dates, [
      "monthly-last-saturday 2026-10-03", // DTSTART always counts
      "mondays 2026-10-05",
      "mondays 2026-10-12",
      "mondays 2026-10-19",
      "monthly-last-saturday 2026-10-31",
      "monthly-last-saturday 2026-11-28",
      "monthly-last-saturday 2026-12-26",
    ]);
  });
});
