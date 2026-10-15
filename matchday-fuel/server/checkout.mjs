// POST /api/checkout: checks an order and creates a Square payment link for it.
//
// Nothing in the request is trusted except the choices it names: variation IDs are checked
// against a fresh read of the Square menu (prices, names, and stock come from there), the stop is
// checked against the live schedule, and the pickup time against the stop's hours and the order
// cutoff. The buyer then pays on Square's hosted checkout page (CreatePaymentLink).
//
// The Square order carries one PICKUP fulfillment, which is what makes a paid order show up in
// Square's order manager for the stand. Square's checkout docs don't say outright that payment
// links accept fulfillments, so if Square rejects the fulfillment (or the beta ticket_name and
// metadata fields), the link is created again without them, with the pickup details carried in
// the payment note and the first line's note instead.

import { randomBytes, randomUUID } from "node:crypto";
import { readConfig } from "./config.mjs";
import { errorResponse, HttpError, json, readJson, requireMethod } from "./http.mjs";
import { buildMenu } from "./menu.mjs";
import { findEvent, loadSchedule } from "./schedule.mjs";
import { createSquareClient } from "./square.mjs";

export const LIMITS = Object.freeze({ lines: 10, perLine: 12, bottles: 24, name: 60, email: 254 });
const PREP_TIME = "PT10M";
// The page offers pickup slots from the browser's clock; allow that much drift against ours.
const CLOCK_GRACE_MS = 60_000;
const MINUTE_MS = 60_000;

const invalid = (field, message) => new HttpError(400, "INVALID", message, { field });

// Text helpers ----------------------------------------------------------------------------------

/** Removes unpaired surrogates, control and bidi characters, collapses whitespace, trims. */
function cleanInput(value) {
  return value
    .replace(/[\uD800-\uDFFF]/gu, "") // with the u flag this matches only unpaired halves
    .normalize("NFC")
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Square documents limits such as "max 500" without saying how characters are counted. UTF-16
// units are the strictest count short of bytes (an emoji is 2 or more), so text is cut to fit
// that, never inside a surrogate pair.
function truncate(text, max) {
  if (text.length <= max) return text;
  let cut = max - 1;
  if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}…`;
}

// Intl puts narrow and thin spaces around times ("9:00 AM"); Square's apps show plain text.
const plainSpaces = (text) => text.replace(/[   ]/g, " ");

function formatTime(ms, timeZone) {
  return plainSpaces(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(ms));
}

function formatDay(ms, timeZone) {
  return plainSpaces(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(ms));
}

function formatWindow(startMs, endMs, timeZone) {
  const startDay = formatDay(startMs, timeZone);
  const endDay = formatDay(endMs, timeZone);
  const end = endDay === startDay ? formatTime(endMs, timeZone) : `${endDay}, ${formatTime(endMs, timeZone)}`;
  return `${startDay}, ${formatTime(startMs, timeZone)} to ${end}`;
}

function listNames(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Field checks ----------------------------------------------------------------------------------

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/i;

/** Milliseconds for an ISO 8601 time with a Z or ±hh:mm offset, or null (also for Feb 30). */
export function parseIsoInstant(text) {
  const match = ISO_INSTANT.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0));
  const millis = match[7] ? Number(match[7].slice(0, 3).padEnd(3, "0")) : 0;
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (match[8].toUpperCase() !== "Z") {
    const sign = match[8][0] === "-" ? -1 : 1;
    const [oh, om] = match[8].slice(1).split(":").map(Number);
    if (oh > 14 || om > 59) return null;
    offsetMinutes = sign * (oh * 60 + om);
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * MINUTE_MS;
  return Number.isFinite(ms) ? ms : null;
}

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9]$/;

export function isValidEmail(email) {
  if (email.length > LIMITS.email) return false;
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return local.length <= 64 && EMAIL_LOCAL.test(local) && EMAIL_DOMAIN.test(domain);
}

/**
 * E.164 for a phone number typed any common way. US and Canadian numbers may be 10 digits,
 * 1 plus 10 digits, or +1 plus 10 digits; other countries need a leading + and country code.
 * Returns { phone } or { problem: "format" | "area" }.
 */
export function normalizePhone(input) {
  if (input.length > 30 || /[^0-9+().\-\s]/.test(input) || /.\+/.test(input)) return { problem: "format" };
  const digits = input.replace(/\D/g, "");
  let national;
  if (input.startsWith("+")) {
    if (!digits.startsWith("1")) {
      return /^[2-9]\d{7,14}$/.test(digits) ? { phone: `+${digits}` } : { problem: "format" };
    }
    national = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith("1")) {
    national = digits.slice(1);
  } else {
    national = digits;
  }
  if (!/^\d{10}$/.test(national)) return { problem: "format" };
  // North American numbers: area code and exchange start with 2-9; N11 codes are service
  // numbers, and 555 isn't an area code (Square rejects it).
  const area = national.slice(0, 3);
  const exchange = national.slice(3, 6);
  if (!/^[2-9]/.test(area) || area.endsWith("11") || area === "555") return { problem: "area" };
  if (!/^[2-9]/.test(exchange) || exchange.endsWith("11")) return { problem: "format" };
  return { phone: `+1${national}` };
}

function optionalString(value, field, message) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid(field, message);
  return value.trim();
}

function readCustomer(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("customer.name", "Enter a name for pickup.");
  if (typeof raw.name !== "string") throw invalid("customer.name", "Enter a name for pickup.");
  const name = cleanInput(raw.name);
  if (!name) throw invalid("customer.name", "Enter a name for pickup.");
  if (Array.from(name).length > LIMITS.name) throw invalid("customer.name", `Use ${LIMITS.name} characters or fewer for the pickup name.`);
  if (!/[\p{L}\p{N}]/u.test(name)) throw invalid("customer.name", "Enter a name for pickup, using letters.");

  const email = optionalString(raw.email, "customer.email", "Enter an email address like name@example.com.");
  const phoneInput = optionalString(raw.phone, "customer.phone", "Enter a 10-digit phone number, including the area code.");
  if (!email && !phoneInput) {
    throw invalid("customer.email", "Enter an email address or a phone number for updates about your order.");
  }
  if (email && !isValidEmail(email)) throw invalid("customer.email", "Enter an email address like name@example.com.");
  let phone = "";
  if (phoneInput) {
    const result = normalizePhone(phoneInput);
    if (result.problem === "area") throw invalid("customer.phone", "Check the area code. That phone number isn't valid.");
    if (result.problem) throw invalid("customer.phone", "Enter a 10-digit phone number, including the area code.");
    phone = result.phone;
  }
  return { name, email, phone };
}

function readLines(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid("items", "Add at least one drink.");
  if (raw.length > LIMITS.lines) throw invalid("items", `An order can include up to ${LIMITS.lines} different drinks.`);
  const seen = new Set();
  let bottles = 0;
  const lines = raw.map((line, index) => {
    const path = `items[${index}]`;
    if (!line || typeof line !== "object" || Array.isArray(line)) throw invalid(path, "Something in your order isn't a drink. Refresh the page and try again.");
    const { variationId, quantity } = line;
    if (typeof variationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(variationId)) {
      throw invalid(`${path}.variationId`, "A drink in your order isn't on the menu. Refresh the page and try again.");
    }
    if (seen.has(variationId)) throw invalid(`${path}.variationId`, "Each drink can be listed only once. Combine the quantities and try again.");
    seen.add(variationId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.perLine) {
      throw invalid(`${path}.quantity`, `Choose from 1 to ${LIMITS.perLine} of each drink.`);
    }
    bottles += quantity;
    return { variationId, quantity };
  });
  if (bottles > LIMITS.bottles) throw invalid("items", `Orders are limited to ${LIMITS.bottles} bottles. This one has ${bottles}.`);
  return lines;
}

/** Checks the request body's shape and contact details; nothing here needs Square. */
export function readOrderRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "INVALID", "The request body must be a JSON object.");
  const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
  if (!eventId || eventId.length > 200) throw invalid("eventId", "Choose a stop for pickup.");

  let pickup;
  if (typeof body.pickupTime !== "string" || !body.pickupTime.trim()) throw invalid("pickupTime", "Choose a pickup time.");
  const pickupText = body.pickupTime.trim();
  if (pickupText.toLowerCase() === "asap") {
    pickup = { asap: true };
  } else {
    const at = parseIsoInstant(pickupText);
    if (at === null) throw invalid("pickupTime", "Choose a pickup time from the list.");
    pickup = { asap: false, at };
  }
  const lines = readLines(body.items);
  const customer = readCustomer(body.customer);
  return { eventId, pickup, lines, customer };
}

// Stop and pickup time --------------------------------------------------------------------------

function checkStop(event, { nowMs, cutoffMinutes, timeZone, live }) {
  if (!event) throw new HttpError(409, "EVENT_CLOSED", "This stop isn't taking orders anymore. Choose another stop.");
  // schedule.json ships with example stops ("sample": true). Sandbox may use them for testing; a
  // production store must not take real payments for a stop that isn't real.
  if (live && event.sample === true) {
    throw new HttpError(409, "EVENT_CLOSED", "This stop is an example and isn't taking orders. Choose another stop.");
  }
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);
  const closesMs = endMs - cutoffMinutes * MINUTE_MS;
  if (!(nowMs < closesMs)) {
    const when = closesMs > nowMs - 12 * 60 * MINUTE_MS ? ` at ${formatTime(closesMs, timeZone)}` : "";
    throw new HttpError(409, "EVENT_CLOSED", `Orders for this stop closed${when}. Choose another stop.`);
  }
  return { startMs, endMs, closesMs };
}

// -> { scheduleType: "ASAP" } or { scheduleType: "SCHEDULED", atMs }, plus text for notes.
function resolvePickup(pickup, { nowMs, startMs, closesMs, timeZone }) {
  if (pickup.asap) {
    if (nowMs < startMs) {
      const opens = formatTime(startMs, timeZone);
      return { scheduleType: "SCHEDULED", atMs: startMs, text: `when the stand opens (${opens})`, short: opens, value: "asap" };
    }
    return { scheduleType: "ASAP", text: "as soon as possible", short: "ASAP", value: "asap" };
  }
  const earliest = Math.max(nowMs, startMs);
  if (pickup.at < earliest - CLOCK_GRACE_MS) {
    if (pickup.at < startMs) {
      throw invalid("pickupTime", `The stand opens at ${formatTime(startMs, timeZone)}. Choose a pickup time after that.`);
    }
    throw invalid("pickupTime", "That pickup time has passed. Choose a later time.");
  }
  if (pickup.at > closesMs) {
    throw invalid("pickupTime", `Choose a pickup time by ${formatTime(closesMs, timeZone)}, when orders close for this stop.`);
  }
  const atMs = Math.max(pickup.at, earliest);
  const time = formatTime(atMs, timeZone);
  return { scheduleType: "SCHEDULED", atMs, text: time, short: time, value: new Date(atMs).toISOString() };
}

// Stock -----------------------------------------------------------------------------------------

function checkStock(lines, menu) {
  const byId = new Map(menu.items.map((item) => [item.variationId, item]));
  lines.forEach((line, index) => {
    if (!byId.has(line.variationId)) {
      throw invalid(`items[${index}].variationId`, "A drink in your order isn't on the menu anymore. Refresh the page and try again.");
    }
  });
  const short = [];
  for (const line of lines) {
    const item = byId.get(line.variationId);
    if (item.soldOut) short.push({ item, available: 0 });
    else if (item.available !== null && line.quantity > item.available) short.push({ item, available: item.available });
  }
  if (!short.length) return lines.map((line) => ({ ...line, item: byId.get(line.variationId) }));

  const soldOut = short.filter((entry) => entry.available <= 0).map((entry) => entry.item.name);
  const low = short.filter((entry) => entry.available > 0);
  const parts = [];
  if (soldOut.length) parts.push(`${listNames(soldOut)} ${soldOut.length === 1 ? "is" : "are"} sold out.`);
  if (low.length) {
    const verb = low.length === 1 && low[0].available === 1 ? "is" : "are";
    parts.push(`Only ${listNames(low.map((entry) => `${entry.available} ${entry.item.name}`))} ${verb} left.`);
  }
  throw new HttpError(409, "OUT_OF_STOCK", `${parts.join(" ")} Update your order and try again.`, {
    items: short.map((entry) => ({ variationId: entry.item.variationId, available: entry.available })),
  });
}

// Payment link ----------------------------------------------------------------------------------

function ticketName(name, pickupShort) {
  const words = name.split(" ");
  const short = words.length > 1 ? `${words[0]} ${Array.from(words[words.length - 1])[0]}` : words[0];
  return truncate(`${truncate(short, 40)} · ${pickupShort}`, 255);
}

function referenceId(nowMs, timeZone) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(nowMs).replace(/\D/g, "");
  return `mf-${day}-${randomBytes(4).toString("hex")}`;
}

/**
 * The CreatePaymentLink body. `withFulfillment: false` builds the fallback: no PICKUP
 * fulfillment and no beta fields, with the pickup details in notes and the buyer's contact
 * details pre-filled instead.
 */
export function buildPaymentLinkBody({ config, event, timeZone, pickup, lines, customer, redirectUrl, nowMs, withFulfillment = true }) {
  const stop = [event.title, event.venue && event.venue !== event.title ? event.venue : ""].filter(Boolean).join(", ");
  const hours = formatWindow(Date.parse(event.start), Date.parse(event.end), timeZone);
  const pickupNote = truncate(`Online order. Pickup ${pickup.text} at ${stop}, ${hours}. For ${customer.name}.`, 500);

  const order = {
    location_id: config.squareLocationId,
    reference_id: referenceId(nowMs, timeZone),
    line_items: lines.map((line) => ({ catalog_object_id: line.variationId, quantity: String(line.quantity) })),
  };
  const body = {
    idempotency_key: randomUUID(),
    order,
    checkout_options: { redirect_url: redirectUrl, ask_for_shipping_address: false, allow_tipping: false },
    payment_note: pickupNote,
  };

  if (withFulfillment) {
    order.ticket_name = ticketName(customer.name, pickup.short);
    order.fulfillments = [{
      type: "PICKUP",
      state: "PROPOSED",
      pickup_details: {
        recipient: {
          display_name: customer.name,
          ...(customer.email ? { email_address: customer.email } : {}),
          ...(customer.phone ? { phone_number: customer.phone } : {}),
        },
        schedule_type: pickup.scheduleType,
        ...(pickup.scheduleType === "ASAP"
          ? { prep_time_duration: PREP_TIME }
          : { pickup_at: new Date(pickup.atMs).toISOString().replace(/\.\d{3}Z$/, "Z") }),
        note: pickupNote,
      },
    }];
    order.metadata = { source: "website", event_id: truncate(event.id, 255), pickup: pickup.value };
    // Square has refused pre_populated_data.buyer_email alongside a fulfillment; the recipient's
    // email and phone fill in the checkout form instead.
  } else {
    order.line_items[0].note = pickupNote;
    const prefill = {
      ...(customer.email ? { buyer_email: customer.email } : {}),
      ...(customer.phone ? { buyer_phone_number: customer.phone } : {}),
    };
    if (Object.keys(prefill).length) body.pre_populated_data = prefill;
  }
  return body;
}

function contactErrorFrom(error) {
  const codes = new Set((error.errors ?? []).map((e) => e.code));
  if (codes.has("INVALID_PHONE_NUMBER")) {
    return invalid("customer.phone", "Square couldn't use that phone number. Check it, or leave it blank and enter an email address.");
  }
  if (codes.has("INVALID_EMAIL_ADDRESS")) return invalid("customer.email", "Square couldn't use that email address. Check it and try again.");
  return null;
}

// True when a 400 points at the parts of the order Square's checkout docs don't confirm.
function rejectsOptionalParts(error) {
  if (error.status !== 400) return false;
  return (error.errors ?? []).some((e) => /fulfillment|pickup|recipient|metadata|ticket_name/i.test(`${e.field ?? ""} ${e.detail ?? ""}`));
}

function setupHint(error) {
  const codes = new Set((error.errors ?? []).map((e) => e.code));
  if (error.status === 401 || error.category === "AUTHENTICATION_ERROR") return " Check SQUARE_ACCESS_TOKEN and SQUARE_ENVIRONMENT (sandbox and production tokens differ).";
  if (codes.has("INSUFFICIENT_SCOPES") || error.status === 403) return " The access token needs the PAYMENTS_WRITE, ORDERS_WRITE, and ORDERS_READ permissions.";
  if (error.status === 404 || codes.has("NOT_FOUND")) return " Check SQUARE_LOCATION_ID and that the items exist in this Square account.";
  return "";
}

const squareFailure = () => new HttpError(502, "SQUARE_ERROR", "Square couldn't start checkout, so no payment was taken. Try again in a moment.");

// Square's error details can quote what was sent, including the buyer's contact details; logs
// keep the error codes and drop those.
function describeForLog(error, customer) {
  let text = String(error?.describe?.() ?? error?.message ?? error);
  const secrets = [customer.email, customer.phone, customer.phone.replace(/^\+1(?=\d{10}$)/, ""), Array.from(customer.name).length >= 3 ? customer.name : ""];
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
  return text.replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[A-Za-z]{2,}/g, "[email]");
}

async function createLink(client, input) {
  try {
    return await client.createPaymentLink(buildPaymentLinkBody(input));
  } catch (error) {
    const contactError = contactErrorFrom(error);
    if (contactError) throw contactError;
    if (!input.withFulfillment || !rejectsOptionalParts(error)) throw error;
    console.warn(`[checkout] ${describeForLog(error, input.customer)} Trying again without the pickup fulfillment.`);
  }
  try {
    return await client.createPaymentLink(buildPaymentLinkBody({ ...input, withFulfillment: false }));
  } catch (error) {
    throw contactErrorFrom(error) ?? error;
  }
}

// Handler ---------------------------------------------------------------------------------------

/** POST /api/checkout. The third argument is for tests. */
export async function handleCheckout(request, env = {}, { now = new Date(), fetchImpl = fetch } = {}) {
  try {
    requireMethod(request, "POST");
    const config = readConfig(env);
    if (!config.squareConfigured) {
      return json(503, { error: "Online ordering isn't connected to Square yet.", code: "NOT_CONNECTED" });
    }
    const order = readOrderRequest(await readJson(request));
    const nowMs = now instanceof Date ? now.getTime() : Number(now);

    // The schedule and a fresh menu are independent, so read them together.
    const [scheduleResult, menuResult] = await Promise.allSettled([
      loadSchedule({ env, request, now: new Date(nowMs), fetchImpl }),
      buildMenu({ config, fetchImpl, now: nowMs, fresh: true }),
    ]);
    if (scheduleResult.status === "rejected") {
      const error = scheduleResult.reason;
      // /api/schedule answers 503 here, but for checkout SPEC.md keeps 503 for NOT_CONNECTED, and
      // the page shows "isn't connected to Square" for any 503.
      if (error instanceof HttpError && error.code === "SCHEDULE_UNAVAILABLE") {
        throw new HttpError(502, "SCHEDULE_UNAVAILABLE", "We couldn't load the schedule to check your stop, so no payment was taken. Try again in a moment.");
      }
      throw error;
    }
    const schedule = scheduleResult.value;
    const timeZone = schedule.timezone || config.businessTimezone;
    const event = findEvent(schedule, order.eventId);
    const live = config.squareEnvironment === "production";
    const hours = checkStop(event, { nowMs, cutoffMinutes: config.orderCutoffMinutes, timeZone, live });
    const pickup = resolvePickup(order.pickup, { nowMs, ...hours, timeZone });

    if (menuResult.status === "rejected") {
      const error = menuResult.reason;
      console.error(`[checkout] Couldn't check stock: ${error.describe?.() ?? error.message}${setupHint(error)}`);
      throw new HttpError(502, "SQUARE_ERROR", "We couldn't reach Square to check stock, so no payment was taken. Try again in a moment.");
    }
    const lines = checkStock(order.lines, menuResult.value);

    const redirectUrl = `${config.siteUrl || new URL(request.url).origin}/?order=placed`;
    const client = createSquareClient({ config, fetchImpl });
    let data;
    try {
      data = await createLink(client, {
        config, event, timeZone, pickup, lines, customer: order.customer, redirectUrl, nowMs, withFulfillment: true,
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error(`[checkout] ${describeForLog(error, order.customer)}${setupHint(error)}`);
      throw squareFailure();
    }

    const link = data?.payment_link;
    const checkoutUrl = typeof link?.url === "string" && /^https:\/\//.test(link.url) ? link.url
      : typeof link?.long_url === "string" && /^https:\/\//.test(link.long_url) ? link.long_url : "";
    const orderId = link?.order_id ?? data?.related_resources?.orders?.[0]?.id ?? "";
    if (!checkoutUrl) {
      console.error("[checkout] Square's CreatePaymentLink reply had no https checkout URL.");
      throw squareFailure();
    }
    const total = data?.related_resources?.orders?.[0]?.total_money;
    console.log(`[checkout] Payment link ready for order ${orderId || "(no id)"}${total ? `, total ${total.amount} ${total.currency}` : ""}.`);
    return json(200, { checkoutUrl, orderId });
  } catch (error) {
    return errorResponse(error);
  }
}
