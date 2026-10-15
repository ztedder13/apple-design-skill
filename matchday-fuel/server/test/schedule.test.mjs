import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HttpError } from "../http.mjs";
import { clearScheduleCache, cleanText, findEvent, handleSchedule, loadSchedule, splitLocation } from "../schedule.mjs";
import netlifySchedule, { config as netlifyConfig } from "../../netlify/functions/schedule.mjs";

const ORIGIN = "https://matchdayfuel.example";
const FILE_URL = `${ORIGIN}/data/schedule.json`;
const FEED_URL = "https://calendar.example.com/calendar/ical/private-s3cr3t/basic.ics";
const request = new Request(`${ORIGIN}/api/schedule`);
const scheduleFile = await readFile(new URL("../../public/data/schedule.json", import.meta.url), "utf8");
const NOW = new Date("2026-10-14T16:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const EVENT_KEYS = ["id", "title", "venue", "address", "start", "end", "notes", "sample"];

function ics(body) {
  const lines = body.replace(/^\n+|\s+$/g, "").split("\n").map((line) => line.trimStart());
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR", ""].join("\r\n");
}

const FEED = ics(`
  BEGIN:VEVENT
  UID:fall-classic@example.com
  DTSTART;TZID=America/New_York:20261024T090000
  DTEND;TZID=America/New_York:20261024T160000
  SUMMARY:Fall Classic Soccer Tournament [stand]
  LOCATION:Riverside Sports Complex\\, 1200 River Rd\\, Springfield
  DESCRIPTION:<p>Find us by <b>Field 3</b>.</p><p>Cash &amp; cards</p>
  END:VEVENT
  BEGIN:VEVENT
  UID:hockey@example.com
  DTSTART;TZID=America/New_York:20261104T170000
  DTEND;TZID=America/New_York:20261104T210000
  SUMMARY:Youth Hockey Night
  LOCATION:Northside Ice Arena\\n77 Rink Ln\\nSpringfield
  DESCRIPTION:Lobby by skate rental [STAND]
  END:VEVENT
  BEGIN:VEVENT
  UID:dentist@example.com
  DTSTART;TZID=America/New_York:20261020T100000
  DTEND;TZID=America/New_York:20261020T110000
  SUMMARY:Dentist
  END:VEVENT
  BEGIN:VEVENT
  UID:weekly-market@example.com
  DTSTART;TZID=America/New_York:20261017T080000
  DTEND;TZID=America/New_York:20261017T120000
  RRULE:FREQ=WEEKLY;COUNT=3
  SUMMARY:[stand] Saturday Farmers Market
  LOCATION:Town Green
  END:VEVENT
`);

// A fetch stand-in: routes maps a URL to a function returning a Response (or throwing).
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes[String(url)];
    if (!route) throw new TypeError(`fetch failed: no route for ${url}`);
    return route(init);
  };
  impl.calls = calls;
  impl.count = (url) => calls.filter((call) => call.url === url).length;
  return impl;
}

const fileRoute = () => new Response(scheduleFile, { headers: { "content-type": "application/json" } });
const feedRoute = (text = FEED) => () => new Response(text, { headers: { "content-type": "text/calendar" } });
const calendarEnv = (extra = {}) => ({ CALENDAR_ICS_URL: FEED_URL, BUSINESS_TIMEZONE: "America/New_York", ...extra });

let logged;
beforeEach((t) => {
  clearScheduleCache();
  logged = { error: [], warn: [] };
  t.mock.method(console, "error", (...args) => logged.error.push(args.join(" ")));
  t.mock.method(console, "warn", (...args) => logged.warn.push(args.join(" ")));
});
afterEach(() => clearScheduleCache());

describe("file mode", () => {
  test("converts the sample schedule's wall times with its time zone", async () => {
    const fetchImpl = fakeFetch({ [FILE_URL]: fileRoute });
    const schedule = await loadSchedule({ env: {}, request, now: NOW, fetchImpl });
    assert.equal(schedule.mode, "file");
    assert.equal(schedule.timezone, "America/New_York");
    assert.deepEqual(Object.keys(schedule), ["mode", "timezone", "events"]);
    assert.equal(schedule.events.length, 5);
    for (const event of schedule.events) {
      assert.deepEqual(Object.keys(event), EVENT_KEYS);
      assert.equal(event.sample, true);
      assert.ok(event.start >= "2026-10-24" && event.end < "2026-11-15", event.start);
    }
    const [soccer, football, hockey] = schedule.events;
    // 8:00 AM to 6:00 PM EDT, the all-day tournament.
    assert.deepEqual([soccer.start, soccer.end], ["2026-10-24T12:00:00.000Z", "2026-10-24T22:00:00.000Z"]);
    assert.deepEqual([football.start, football.end], ["2026-10-30T21:30:00.000Z", "2026-10-31T02:00:00.000Z"]);
    // After the November 1 change, 5:00 PM is EST.
    assert.deepEqual([hockey.start, hockey.end], ["2026-11-04T22:00:00.000Z", "2026-11-05T02:00:00.000Z"]);
    const titles = schedule.events.map((e) => e.title).join(" ");
    for (const sport of ["Soccer", "Football", "Hockey", "Basketball", "Baseball"]) assert.match(titles, new RegExp(sport));
    assert.equal(fetchImpl.calls[0].init.headers.accept, "application/json");
  });

  test("keeps stops in progress, drops ended ones, and looks 90 days ahead", async () => {
    const fetchImpl = fakeFetch({ [FILE_URL]: fileRoute });
    const during = await loadSchedule({ env: {}, request, now: new Date("2026-10-31T01:00:00Z"), fetchImpl });
    assert.equal(during.events[0].title, "Friday Night Football");
    assert.equal(during.events.length, 4);
    const after = await loadSchedule({ env: {}, request, now: new Date("2026-11-15T00:00:00Z"), fetchImpl });
    assert.deepEqual(after.events, []);
    // 90 days from August 1 ends October 30 at midnight UTC: only the October 24 stop starts before then.
    const early = await loadSchedule({ env: {}, request, now: new Date("2026-08-01T00:00:00Z"), fetchImpl });
    assert.deepEqual(early.events.map((e) => e.title), ["Fall Classic Soccer Tournament"]);
  });

  test("sanitizes text, skips bad entries, and repairs ids", async () => {
    const data = {
      timezone: "Not/AZone",
      events: [
        { id: "a", title: `  Big\n\tGame ${"x".repeat(300)}`, venue: "Arena‮", address: "1 Main St", start: "2026-10-20T18:00", end: "2026-10-20T21:00", notes: "<b>Bring</b> cash\u0007", sample: false },
        { id: "a", title: "Second with same id", start: "2026-10-21T18:00", end: "2026-10-21T21:00" },
        { title: "No id here", start: "2026-10-22T18:00", end: "2026-10-22T21:00" },
        { id: "bad", title: "Bad date", start: "2026-02-30T18:00", end: "2026-02-30T21:00" },
        { id: "backwards", title: "Ends first", start: "2026-10-23T18:00", end: "2026-10-23T17:00" },
        "not an object",
      ],
    };
    const fetchImpl = fakeFetch({ [FILE_URL]: () => new Response(JSON.stringify(data)) });
    const schedule = await loadSchedule({ env: { BUSINESS_TIMEZONE: "America/Chicago" }, request, now: NOW, fetchImpl });
    assert.equal(schedule.timezone, "America/Chicago"); // file zone invalid, so the business zone
    assert.deepEqual(schedule.events.map((e) => e.id), ["a", "a-2", "no-id-here-20261022T230000Z"]);
    const [first] = schedule.events;
    assert.equal(first.start, "2026-10-20T23:00:00.000Z");
    assert.equal(Array.from(first.title).length, 120);
    assert.ok(first.title.startsWith("Big Game xxx") && first.title.endsWith("…"));
    assert.equal(first.venue, "Arena");
    assert.equal(first.notes, "Bring cash");
    assert.equal(first.sample, false);
    assert.ok(logged.warn.some((w) => w.includes("event 4") && w.includes("event 5") && w.includes("event 6")));
  });

  test("a missing schedule file is a 503, not a crash", async () => {
    const fetchImpl = fakeFetch({ [FILE_URL]: () => new Response("Not found", { status: 404 }) });
    await assert.rejects(loadSchedule({ env: {}, request, now: NOW, fetchImpl }),
      (error) => error instanceof HttpError && error.status === 503 && error.code === "SCHEDULE_UNAVAILABLE");
  });
});

describe("calendar mode", () => {
  test("maps SUMMARY, LOCATION, and DESCRIPTION to stops", async () => {
    const fetchImpl = fakeFetch({ [FEED_URL]: feedRoute() });
    const schedule = await loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl });
    assert.equal(schedule.mode, "calendar");
    assert.equal(schedule.timezone, "America/New_York");
    const soccer = schedule.events.find((e) => e.title.startsWith("Fall Classic"));
    assert.deepEqual(Object.keys(soccer), EVENT_KEYS);
    assert.equal(soccer.title, "Fall Classic Soccer Tournament [stand]"); // no keyword set, so nothing removed
    assert.equal(soccer.venue, "Riverside Sports Complex");
    assert.equal(soccer.address, "1200 River Rd, Springfield");
    assert.equal(soccer.notes, "Find us by Field 3. Cash & cards");
    assert.deepEqual([soccer.start, soccer.end], ["2026-10-24T13:00:00.000Z", "2026-10-24T20:00:00.000Z"]);
    assert.equal(soccer.sample, false);
    assert.match(soccer.id, /^[0-9a-f]{12}-20261024T130000Z$/);
    const hockey = schedule.events.find((e) => e.title === "Youth Hockey Night");
    assert.deepEqual([hockey.venue, hockey.address], ["Northside Ice Arena", "77 Rink Ln, Springfield"]);
    assert.equal(schedule.events.length, 6); // 1 + 1 + dentist + 3 market Saturdays
    assert.deepEqual(schedule.events.map((e) => e.start), [...schedule.events.map((e) => e.start)].sort());
    assert.equal(fetchImpl.calls[0].init.headers.accept.split(",")[0], "text/calendar");
  });

  test("ids stay the same across requests and differ per occurrence", async () => {
    const fetchImpl = fakeFetch({ [FEED_URL]: feedRoute() });
    const first = await loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl });
    clearScheduleCache();
    const second = await loadSchedule({ env: calendarEnv(), request, now: new Date(NOW.getTime() + 3 * MINUTE), fetchImpl });
    assert.equal(fetchImpl.count(FEED_URL), 2);
    assert.deepEqual(second.events.map((e) => e.id), first.events.map((e) => e.id));
    assert.equal(new Set(first.events.map((e) => e.id)).size, first.events.length);
    assert.equal(findEvent(second, first.events[2].id).title, first.events[2].title);
  });

  test("CALENDAR_KEYWORD keeps matching events and removes the keyword from the text", async () => {
    const fetchImpl = fakeFetch({ [FEED_URL]: feedRoute() });
    const schedule = await loadSchedule({ env: calendarEnv({ CALENDAR_KEYWORD: "[stand]" }), request, now: NOW, fetchImpl });
    assert.deepEqual(schedule.events.map((e) => [e.start.slice(0, 10), e.title]), [
      ["2026-10-17", "Saturday Farmers Market"],
      ["2026-10-24", "Saturday Farmers Market"], // 8 AM, before the 9 AM tournament
      ["2026-10-24", "Fall Classic Soccer Tournament"],
      ["2026-10-31", "Saturday Farmers Market"],
      ["2026-11-04", "Youth Hockey Night"],
    ]);
    assert.equal(schedule.events.find((e) => e.title === "Youth Hockey Night").notes, "Lobby by skate rental");
    assert.ok(!schedule.events.some((e) => e.title === "Dentist"));
  });

  test("splitLocation splits at the first comma or line break", () => {
    assert.deepEqual(splitLocation("Memorial Stadium, 500 Stadium Dr, Springfield"), { venue: "Memorial Stadium", address: " 500 Stadium Dr, Springfield" });
    assert.deepEqual(splitLocation("Memorial Stadium\n500 Stadium Dr\nSpringfield"), { venue: "Memorial Stadium", address: "500 Stadium Dr, Springfield" });
    assert.deepEqual(splitLocation("Town Green"), { venue: "Town Green", address: "" });
    assert.deepEqual(splitLocation(""), { venue: "", address: "" });
    assert.equal(cleanText(splitLocation("A,  1 Main St ").address, 200), "1 Main St");
  });

  test("webcal:// addresses are fetched over https://", async () => {
    const fetchImpl = fakeFetch({ [FEED_URL]: feedRoute() });
    const schedule = await loadSchedule({ env: calendarEnv({ CALENDAR_ICS_URL: FEED_URL.replace("https://", "webcal://") }), request, now: NOW, fetchImpl });
    assert.equal(schedule.mode, "calendar");
    assert.deepEqual(fetchImpl.calls.map((c) => c.url), [FEED_URL]);
  });

  test("caches the parsed feed for five minutes", async () => {
    const fetchImpl = fakeFetch({ [FEED_URL]: feedRoute() });
    const at = (minutes) => loadSchedule({ env: calendarEnv(), request, now: new Date(NOW.getTime() + minutes * MINUTE), fetchImpl });
    await at(0);
    await at(4);
    assert.equal(fetchImpl.count(FEED_URL), 1);
    await at(6);
    assert.equal(fetchImpl.count(FEED_URL), 2);
  });

  test("shares one fetch between simultaneous requests", async () => {
    const fetchImpl = fakeFetch({ [FEED_URL]: feedRoute() });
    const results = await Promise.all([1, 2, 3].map(() => loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl })));
    assert.equal(fetchImpl.count(FEED_URL), 1);
    assert.ok(results.every((r) => r.mode === "calendar" && r.events.length === 6));
  });

  test("returns at most 50 stops, all within 90 days", async () => {
    const feed = ics(`
      BEGIN:VEVENT
      UID:daily
      DTSTART;TZID=America/New_York:20261015T090000
      DTEND;TZID=America/New_York:20261015T100000
      RRULE:FREQ=DAILY
      END:VEVENT
    `);
    const fetchImpl = fakeFetch({ [FEED_URL]: feedRoute(feed) });
    const schedule = await loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl });
    assert.equal(schedule.events.length, 50);
    assert.equal(schedule.events[0].start, "2026-10-15T13:00:00.000Z");

    clearScheduleCache();
    const far = ics(`
      BEGIN:VEVENT
      UID:far
      DTSTART:20270201T130000Z
      DTEND:20270201T170000Z
      END:VEVENT
      BEGIN:VEVENT
      UID:ended
      DTSTART:20261014T100000Z
      DTEND:20261014T150000Z
      END:VEVENT
      BEGIN:VEVENT
      UID:on-now
      DTSTART:20261014T150000Z
      DTEND:20261014T170000Z
      END:VEVENT
    `);
    const fetchFar = fakeFetch({ [FEED_URL]: feedRoute(far) });
    const near = await loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl: fetchFar });
    assert.deepEqual(near.events.map((e) => e.start), ["2026-10-14T15:00:00.000Z"]);
  });

  test("uses BUSINESS_TIMEZONE for floating times and as the reported zone", async () => {
    const feed = ics(`
      BEGIN:VEVENT
      UID:floating
      DTSTART:20261024T090000
      DTEND:20261024T120000
      SUMMARY:Floating
      END:VEVENT
    `);
    const fetchImpl = fakeFetch({ [FEED_URL]: feedRoute(feed) });
    const schedule = await loadSchedule({ env: calendarEnv({ BUSINESS_TIMEZONE: "America/Denver" }), request, now: NOW, fetchImpl });
    assert.equal(schedule.timezone, "America/Denver");
    assert.equal(schedule.events[0].start, "2026-10-24T15:00:00.000Z");
  });
});

describe("calendar failures fall back", () => {
  test("a network error falls back to schedule.json and logs without the secret path", async () => {
    const fetchImpl = fakeFetch({
      [FEED_URL]: () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); },
      [FILE_URL]: fileRoute,
    });
    const schedule = await loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl });
    assert.equal(schedule.mode, "file");
    assert.equal(schedule.events.length, 5);
    assert.equal(logged.error.length, 1);
    assert.match(logged.error[0], /calendar\.example\.com.*fetch failed \(ECONNRESET\).*schedule\.json/);
    assert.ok(!logged.error[0].includes("s3cr3t"));
  });

  for (const [name, route] of [
    ["an HTTP error", () => new Response("Gone", { status: 404 })],
    ["a page that isn't a calendar", () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } })],
    ["a feed over 2 MB", () => new Response("BEGIN:VCALENDAR\r\n".padEnd(2 * 1024 * 1024 + 10, "X"))],
  ]) {
    test(`${name} falls back to schedule.json`, async () => {
      const fetchImpl = fakeFetch({ [FEED_URL]: route, [FILE_URL]: fileRoute });
      const schedule = await loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl });
      assert.equal(schedule.mode, "file");
      assert.equal(logged.error.length, 1);
    });
  }

  test("an http:// address is refused without fetching it", async () => {
    const fetchImpl = fakeFetch({ [FILE_URL]: fileRoute });
    const schedule = await loadSchedule({ env: calendarEnv({ CALENDAR_ICS_URL: "http://calendar.example.com/feed.ics" }), request, now: NOW, fetchImpl });
    assert.equal(schedule.mode, "file");
    assert.deepEqual(fetchImpl.calls.map((c) => c.url), [FILE_URL]);
    assert.match(logged.error[0], /must start with https:\/\/ or webcal:\/\//);
  });

  test("gives up after 8 seconds", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const fetchImpl = fakeFetch({
      [FEED_URL]: (init) => { signal = init.signal; return new Promise(() => {}); },
      [FILE_URL]: fileRoute,
    });
    const pending = loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl });
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(7999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    const schedule = await pending;
    assert.equal(signal.aborted, true);
    assert.equal(schedule.mode, "file");
    assert.ok(logged.error.some((line) => /longer than 8 seconds/.test(line)), logged.error.join("\n"));
  });

  test("waits a minute before retrying a failed feed", async () => {
    const fetchImpl = fakeFetch({ [FEED_URL]: () => new Response("err", { status: 500 }), [FILE_URL]: fileRoute });
    const at = (seconds) => loadSchedule({ env: calendarEnv(), request, now: new Date(NOW.getTime() + seconds * 1000), fetchImpl });
    await at(0);
    await at(30);
    assert.equal(fetchImpl.count(FEED_URL), 1);
    assert.equal(logged.error.length, 1);
    await at(61);
    assert.equal(fetchImpl.count(FEED_URL), 2);
  });

  test("serves the last good copy of the feed when a refresh fails", async () => {
    let up = true;
    const fetchImpl = fakeFetch({
      [FEED_URL]: () => (up ? new Response(FEED) : new Response("err", { status: 503 })),
      [FILE_URL]: fileRoute,
    });
    const first = await loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl });
    up = false;
    const later = await loadSchedule({ env: calendarEnv(), request, now: new Date(NOW.getTime() + 10 * MINUTE), fetchImpl });
    assert.equal(later.mode, "calendar");
    assert.deepEqual(later.events.map((e) => e.id), first.events.map((e) => e.id));
    assert.match(logged.error[0], /copy from 10 minutes ago/);
    const muchLater = await loadSchedule({ env: calendarEnv(), request, now: new Date(NOW.getTime() + 7 * 60 * MINUTE), fetchImpl });
    assert.equal(muchLater.mode, "file");
  });
});

describe("handlers", () => {
  test("findEvent", () => {
    const schedule = { mode: "file", timezone: "UTC", events: [{ id: "a", title: "A" }] };
    assert.equal(findEvent(schedule, "a").title, "A");
    assert.equal(findEvent(schedule, "b"), null);
    assert.equal(findEvent(schedule, 1), null);
    assert.equal(findEvent(null, "a"), null);
  });

  test("handleSchedule answers GET with JSON that browsers may cache for a minute", async (t) => {
    t.mock.method(globalThis, "fetch", fakeFetch({ [FILE_URL]: fileRoute }));
    const response = await handleSchedule(request, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
    assert.match(response.headers.get("content-type"), /^application\/json/);
    const body = await response.json();
    assert.equal(body.mode, "file");
    assert.ok(Array.isArray(body.events));
  });

  test("handleSchedule sends the order cutoff checkout uses, so the page offers the same stops", async (t) => {
    t.mock.method(globalThis, "fetch", fakeFetch({ [FILE_URL]: fileRoute }));
    assert.equal((await (await handleSchedule(request, {})).json()).orderCutoffMinutes, 15);
    clearScheduleCache();
    assert.equal((await (await handleSchedule(request, { ORDER_CUTOFF_MINUTES: "30" })).json()).orderCutoffMinutes, 30);
  });

  test("handleSchedule refuses other methods", async () => {
    await assert.rejects(handleSchedule(new Request(`${ORIGIN}/api/schedule`, { method: "POST" }), {}),
      (error) => error instanceof HttpError && error.status === 405);
  });

  test("the Netlify function wraps the handler and turns errors into JSON", async (t) => {
    assert.deepEqual(netlifyConfig, { path: "/api/schedule" });
    const refused = await netlifySchedule(new Request(`${ORIGIN}/api/schedule`, { method: "POST" }));
    assert.equal(refused.status, 405);
    assert.equal((await refused.json()).code, "METHOD_NOT_ALLOWED");

    const saved = process.env.CALENDAR_ICS_URL;
    delete process.env.CALENDAR_ICS_URL;
    t.after(() => { if (saved !== undefined) process.env.CALENDAR_ICS_URL = saved; });
    t.mock.method(globalThis, "fetch", fakeFetch({ [FILE_URL]: () => new Response("nope", { status: 500 }) }));
    const failed = await netlifySchedule(request);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).code, "SCHEDULE_UNAVAILABLE");
  });
});

describe("hostile feeds", () => {
  const rdates = (count) => Array.from({ length: count }, (_, i) =>
    new Date(Date.parse("2026-10-15T00:00:00Z") + i * 15 * MINUTE).toISOString().replace(/[-:]|\.\d{3}/g, "")).join(",");

  test("an unclosed tag run in a description doesn't take quadratic time", async () => {
    const feed = ics(`
      BEGIN:VEVENT
      UID:tags@example.com
      DTSTART:20261020T130000Z
      DTEND:20261020T200000Z
      SUMMARY:Stop
      DESCRIPTION:${"<a".repeat(60_000)}
      END:VEVENT
    `);
    const started = performance.now();
    const schedule = await loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl: fakeFetch({ [FEED_URL]: feedRoute(feed) }) });
    const ms = performance.now() - started;
    assert.equal(schedule.mode, "calendar");
    assert.equal(schedule.events.length, 1);
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  });

  test("long text shared by thousands of occurrences is cleaned once, not per occurrence", async () => {
    const words = "word ".repeat(30_000); // 150 KB
    const feed = ics(`
      BEGIN:VEVENT
      UID:${"u".repeat(100_000)}
      DTSTART:20261015T000000Z
      DURATION:PT1H
      RDATE:${rdates(4999)}
      SUMMARY:[stand] ${words}
      LOCATION:Field 3, ${words}
      DESCRIPTION:<p>${words}</p>
      END:VEVENT
    `);
    const started = performance.now();
    const schedule = await loadSchedule({ env: calendarEnv({ CALENDAR_KEYWORD: "[stand]" }), request, now: NOW, fetchImpl: fakeFetch({ [FEED_URL]: feedRoute(feed) }) });
    const ms = performance.now() - started;
    assert.equal(schedule.mode, "calendar");
    assert.equal(schedule.events.length, 50);
    const [first] = schedule.events;
    assert.ok(first.title.startsWith("word word") && first.title.endsWith("…") && Array.from(first.title).length === 120, first.title);
    assert.equal(first.venue, "Field 3");
    assert.ok(Array.from(first.notes).length === 500);
    assert.match(first.id, /^[0-9a-f]{12}-20261015T000000Z$/);
    assert.equal(new Set(schedule.events.map((e) => e.id)).size, 50);
    assert.ok(ms < 4000, `took ${Math.round(ms)} ms`);
  });

  test("a feed address with a user name and password is refused without logging it", async () => {
    const secretUrl = "https://user:hunter2@calendar.example.com/calendar/ical/private-s3cr3t/basic.ics";
    const fetchImpl = fakeFetch({ [FILE_URL]: fileRoute });
    const schedule = await loadSchedule({ env: calendarEnv({ CALENDAR_ICS_URL: secretUrl }), request, now: NOW, fetchImpl });
    assert.equal(schedule.mode, "file");
    assert.deepEqual(fetchImpl.calls.map((c) => c.url), [FILE_URL]);
    assert.equal(logged.error.length, 1);
    assert.ok(!/s3cr3t|hunter2/.test(logged.error[0]), logged.error[0]);
  });

  test("errors that quote the feed address are logged without its secret path", async () => {
    const fetchImpl = fakeFetch({
      [FEED_URL]: () => { throw new TypeError(`fetch failed for ${FEED_URL}`); },
      [FILE_URL]: fileRoute,
    });
    await loadSchedule({ env: calendarEnv(), request, now: NOW, fetchImpl });
    assert.equal(logged.error.length, 1);
    assert.ok(!logged.error[0].includes("s3cr3t"), logged.error[0]);
    assert.match(logged.error[0], /calendar\.example\.com/);
  });
});
