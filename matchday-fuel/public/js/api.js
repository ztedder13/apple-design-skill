// Data for the page: the menu (prices and stock from Square), the schedule, and checkout.
// When the site runs without its server (opened as a file or in a preview), the menu and
// schedule fall back to samples so the page still works, and `mode` tells the page to say so.
// When the server is there but reports a problem, the page shows that problem instead of
// pretending with samples.

import { DEFAULT_TIME_ZONE, isValidTimeZone, parseLocalDateTime, zonedWallTimeToUtc } from "./format.js";

const SAMPLE_STOCK = { "hat-trick": 0, "red-zone": 3 };
export const DEFAULT_CUTOFF_MINUTES = 15;

// Resolves to { response, data } when the server answered with JSON, whatever the status.
// Throws when there is no server or the reply isn't JSON.
async function getJson(url, options) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, ...options });
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    const error = new Error(`Unexpected response from ${url}`);
    error.status = response.status;
    throw error;
  }
  return { response, data: await response.json() };
}

// Menu ----------------------------------------------------------------------------------------

function sampleMenu() {
  const items = [...document.querySelectorAll(".drink[data-drink]")].map((card) => {
    const key = card.dataset.drink;
    const available = key in SAMPLE_STOCK ? SAMPLE_STOCK[key] : 24;
    return {
      key,
      name: card.dataset.name,
      variationId: `sample-${key}`,
      priceCents: Number(card.dataset.samplePrice) || 600,
      available,
      soldOut: available <= 0,
    };
  });
  return { mode: "preview", currency: "USD", items };
}

export async function loadMenu() {
  let result;
  try {
    result = await getJson("/api/menu");
  } catch {
    return sampleMenu();
  }
  const { response, data } = result;
  if (response.ok && Array.isArray(data.items)) return data;
  return {
    mode: "unavailable",
    currency: "USD",
    items: [],
    error: data?.error || "Prices and stock can’t be loaded right now. Try again in a moment.",
  };
}

// Schedule ------------------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

function normalizeFileSchedule(file, now) {
  const timeZone = isValidTimeZone(file.timezone) ? file.timezone : DEFAULT_TIME_ZONE;
  const events = (Array.isArray(file.events) ? file.events : [])
    .map((event, index) => ({
      id: String(event.id || `stop-${index}`),
      title: String(event.title || "Matchday Fuel stand"),
      venue: String(event.venue || ""),
      address: String(event.address || ""),
      notes: String(event.notes || ""),
      sample: Boolean(event.sample),
      start: parseLocalDateTime(event.start, timeZone),
      end: parseLocalDateTime(event.end, timeZone),
    }))
    .filter((event) => event.start && event.end && event.end > now && event.start - now < 90 * DAY)
    .sort((a, b) => a.start - b.start)
    .slice(0, 50);
  return { mode: "file", timezone: timeZone, events };
}

// Five example stops spread over the next two weeks, so a preview always has upcoming dates.
function sampleSchedule(now) {
  const timeZone = DEFAULT_TIME_ZONE;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now).split("-").map(Number);
  const base = Date.UTC(today[0], today[1] - 1, today[2]);
  const stops = [
    [0, 9, 0, 21, 0, "Weeknight Rec League Basketball", "Westside Rec Center", "48 Elm St, Springfield"],
    [2, 18, 0, 22, 0, "Friday Night Football", "Memorial Stadium", "500 Stadium Dr, Springfield"],
    [3, 8, 0, 16, 0, "Fall Classic Soccer Tournament", "Riverside Sports Complex", "1200 River Rd, Springfield"],
    [5, 7, 30, 13, 0, "Youth Hockey Showcase", "Northside Ice Arena", "77 Rink Ln, Springfield"],
    [9, 11, 0, 17, 0, "Fall Ball Doubleheader", "Lakeview Ballpark", "300 Shore Ave, Springfield"],
  ];
  const events = stops.map(([days, sh, sm, eh, em, title, venue, address]) => {
    const day = new Date(base + days * DAY);
    const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    return {
      id: `sample-${venue.toLowerCase().replace(/[^a-z]+/g, "-")}`,
      title, venue, address, notes: "", sample: true,
      start: zonedWallTimeToUtc(y, mo, d, sh, sm, timeZone),
      end: zonedWallTimeToUtc(y, mo, d, eh, em, timeZone),
    };
  }).filter((event) => event.end > now);
  return { mode: "sample", timezone: timeZone, events };
}

export async function loadSchedule(now = new Date()) {
  let result = null;
  try {
    result = await getJson("/api/schedule");
  } catch {
    // No server: try the schedule file next.
  }
  if (result) {
    const { response, data } = result;
    if (response.ok && Array.isArray(data.events)) {
      return {
        ...data,
        orderCutoffMinutes: Number.isFinite(data.orderCutoffMinutes) ? data.orderCutoffMinutes : DEFAULT_CUTOFF_MINUTES,
        events: data.events.map((event) => ({ ...event, start: new Date(event.start), end: new Date(event.end) })),
      };
    }
    return {
      mode: "unavailable",
      timezone: DEFAULT_TIME_ZONE,
      orderCutoffMinutes: DEFAULT_CUTOFF_MINUTES,
      events: [],
      error: data?.error || "The schedule can’t be loaded right now. Try again in a moment.",
    };
  }
  try {
    const { response, data } = await getJson("data/schedule.json");
    if (response.ok) {
      const schedule = normalizeFileSchedule(data, now);
      if (schedule.events.length) return { ...schedule, orderCutoffMinutes: DEFAULT_CUTOFF_MINUTES };
    }
  } catch {
    // No file either (for example a preview): use samples.
  }
  return { ...sampleSchedule(now), orderCutoffMinutes: DEFAULT_CUTOFF_MINUTES };
}

// Checkout ------------------------------------------------------------------------------------

// Resolves to { status, data }. status is 0 when the server can't be reached and -1 when it
// took too long; data is null when the reply wasn't JSON.
export async function startCheckout(payload, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { response, data } = await getJson("/api/checkout", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { status: response.status, data };
  } catch (error) {
    if (error.name === "AbortError") return { status: -1, data: null };
    return { status: error.status || 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}
