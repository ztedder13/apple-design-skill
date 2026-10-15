import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleCheckout, normalizePhone, parseIsoInstant } from "../checkout.mjs";
import { buildMenu, clearMenuCache } from "../menu.mjs";
import { DRINKS } from "../sample.mjs";
import { clearScheduleCache } from "../schedule.mjs";
import netlifyCheckout, { config as netlifyConfig } from "../../netlify/functions/checkout.mjs";

const ORIGIN = "https://matchdayfuel.example";
const LOC = "LQ7Z4N2M8KXRA";
const TOKEN = "EAAAl-test-secret-token-0123456789";
const SANDBOX = "https://connect.squareupsandbox.com";
const ENV = Object.freeze({
  SQUARE_ACCESS_TOKEN: TOKEN,
  SQUARE_LOCATION_ID: LOC,
  SQUARE_ENVIRONMENT: "sandbox",
  SITE_URL: "https://matchdayfuel.example/",
  BUSINESS_TIMEZONE: "America/New_York",
});
const scheduleFile = await readFile(new URL("../../public/data/schedule.json", import.meta.url), "utf8");

// The soccer stop runs 8:00 AM to 6:00 PM EDT (12:00 to 22:00 UTC) on Saturday, October 24.
const SOCCER = "sample-2026-10-24-riverside-soccer";
const FOOTBALL = "sample-2026-10-30-memorial-football";
const DURING = new Date("2026-10-24T14:00:00Z"); // 10:00 AM
const BEFORE = new Date("2026-10-24T10:00:00Z"); // 6:00 AM

// Square fixtures --------------------------------------------------------------------------------

const varId = (key) => `V${key.toUpperCase().replace(/-/g, "")}`.slice(0, 24);
const STOCK = { "hat-trick": 0, "red-zone": 3, "buzzer-beater": 1 };

function catalogObjects() {
  return DRINKS.map((drink) => {
    const itemId = `I${varId(drink.key).slice(1)}`;
    return {
      type: "ITEM",
      id: itemId,
      version: 1,
      is_deleted: false,
      present_at_all_locations: true,
      item_data: {
        name: drink.name,
        product_type: "REGULAR",
        variations: [{
          type: "ITEM_VARIATION",
          id: varId(drink.key),
          version: 1,
          is_deleted: false,
          present_at_all_locations: true,
          item_variation_data: {
            item_id: itemId,
            name: "Regular",
            pricing_type: "FIXED_PRICING",
            price_money: { amount: drink.line === "Cold brew" ? 600 : 650, currency: "USD" },
            track_inventory: true,
          },
        }],
      },
    };
  });
}

const counts = () => DRINKS.map((drink) => ({
  catalog_object_id: varId(drink.key),
  catalog_object_type: "ITEM_VARIATION",
  state: "IN_STOCK",
  location_id: LOC,
  quantity: String(STOCK[drink.key] ?? 24),
  calculated_at: "2026-10-24T13:00:00.000Z",
}));

const squareJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function paymentLinkReply(body) {
  const lineItems = body.order.line_items.map((line, index) => ({
    uid: `uid-${index}`,
    catalog_object_id: line.catalog_object_id,
    quantity: line.quantity,
    base_price_money: { amount: 600, currency: "USD" },
  }));
  return squareJson({
    payment_link: {
      id: "PLK7Q2XZ4M5N6P7R",
      version: 1,
      order_id: "ORD0n7Wq3XyZ1aBcDeFgHiJkLmNo",
      checkout_options: body.checkout_options,
      url: "https://sandbox.square.link/u/Ab3dEf7h",
      long_url: "https://sandbox.square.link/u/Ab3dEf7h?src=sheet",
      created_at: "2026-10-24T14:00:01Z",
      payment_note: body.payment_note,
    },
    related_resources: {
      orders: [{
        id: "ORD0n7Wq3XyZ1aBcDeFgHiJkLmNo",
        location_id: LOC,
        line_items: lineItems,
        total_money: { amount: 1850, currency: "USD" },
        state: "DRAFT",
      }],
    },
  });
}

// A stand-in for Square and the site's own /data/schedule.json.
function mockFetch({ paymentLink = (call) => paymentLinkReply(call.body), catalog, schedule } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = new URL(String(url));
    const method = init.method ?? "GET";
    const call = { method, url: target, path: target.pathname, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (target.pathname === "/data/schedule.json") {
      return schedule ? schedule() : new Response(scheduleFile, { headers: { "content-type": "application/json" } });
    }
    if (target.origin !== SANDBOX) throw new TypeError(`fetch failed: unexpected host ${target.origin}`);
    if (method === "GET" && target.pathname === "/v2/catalog/list") return catalog ? catalog(call) : squareJson({ objects: catalogObjects() });
    if (method === "POST" && target.pathname === "/v2/inventory/counts/batch-retrieve") return squareJson({ counts: counts() });
    if (method === "POST" && target.pathname === "/v2/online-checkout/payment-links") return paymentLink(call, calls.filter((c) => c.path === target.pathname).length);
    throw new TypeError(`fetch failed: no route for ${method} ${target.href}`);
  };
  impl.calls = calls;
  impl.links = () => calls.filter((c) => c.path === "/v2/online-checkout/payment-links");
  return impl;
}

const validOrder = (overrides = {}) => ({
  eventId: SOCCER,
  pickupTime: "asap",
  items: [{ variationId: varId("stoppage-time"), quantity: 2 }, { variationId: varId("golden-boot"), quantity: 1 }],
  customer: { name: "Sam Lee", email: "sam@example.com", phone: "(312) 248-0123" },
  ...overrides,
});

function post(body, { url = `${ORIGIN}/api/checkout`, method = "POST", raw } = {}) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body: raw ?? JSON.stringify(body) }),
  });
}

async function checkout(body, { env = ENV, now = DURING, fetchImpl = mockFetch(), ...requestOptions } = {}) {
  const response = await handleCheckout(post(body, requestOptions), env, { now, fetchImpl });
  return { response, status: response.status, data: await response.json(), fetchImpl };
}

let logged;
beforeEach((t) => {
  clearMenuCache();
  clearScheduleCache();
  logged = { log: [], warn: [], error: [] };
  for (const level of ["log", "warn", "error"]) t.mock.method(console, level, (...args) => logged[level].push(args.join(" ")));
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOTE = "Online order. Pickup as soon as possible at Fall Classic Soccer Tournament, Riverside Sports Complex, Sat, Oct 24, 8:00 AM to 6:00 PM. For Sam Lee.";

describe("happy path", () => {
  test("creates a payment link with a PICKUP fulfillment, exactly as Square documents it", async () => {
    const { status, data, fetchImpl } = await checkout(validOrder());
    assert.equal(status, 200);
    assert.deepEqual(data, { checkoutUrl: "https://sandbox.square.link/u/Ab3dEf7h", orderId: "ORD0n7Wq3XyZ1aBcDeFgHiJkLmNo" });

    const [link, ...more] = fetchImpl.links();
    assert.equal(more.length, 0);
    assert.equal(link.url.href, `${SANDBOX}/v2/online-checkout/payment-links`);
    assert.deepEqual(link.headers, {
      Authorization: `Bearer ${TOKEN}`,
      "Square-Version": "2026-08-19",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    const { idempotency_key: key, order, ...rest } = link.body;
    assert.match(key, UUID);
    assert.match(order.reference_id, /^mf-20261024-[0-9a-f]{8}$/);
    assert.ok(order.reference_id.length <= 40);
    assert.deepEqual({ ...order, reference_id: "(checked above)" }, {
      location_id: LOC,
      reference_id: "(checked above)",
      line_items: [
        { catalog_object_id: varId("stoppage-time"), quantity: "2" },
        { catalog_object_id: varId("golden-boot"), quantity: "1" },
      ],
      ticket_name: "Sam L · ASAP",
      fulfillments: [{
        type: "PICKUP",
        state: "PROPOSED",
        pickup_details: {
          recipient: { display_name: "Sam Lee", email_address: "sam@example.com", phone_number: "+13122480123" },
          schedule_type: "ASAP",
          prep_time_duration: "PT10M",
          note: NOTE,
        },
      }],
      metadata: { source: "website", event_id: SOCCER, pickup: "asap" },
    });
    assert.deepEqual(rest, {
      checkout_options: { redirect_url: "https://matchdayfuel.example/?order=placed", ask_for_shipping_address: false, allow_tipping: false },
      payment_note: NOTE,
    });
    // Square can refuse pre_populated_data next to a fulfillment, so it isn't sent.
    assert.equal("pre_populated_data" in link.body, false);

    // Schedule and a fresh menu (catalog + inventory) were read before the link was made.
    assert.deepEqual(fetchImpl.calls.map((c) => c.path).sort(), [
      "/data/schedule.json", "/v2/catalog/list", "/v2/inventory/counts/batch-retrieve", "/v2/online-checkout/payment-links",
    ]);
    assert.ok(logged.log.some((line) => line.includes("ORD0n7Wq3XyZ1aBcDeFgHiJkLmNo") && line.includes("1850 USD")));
    assert.ok([...logged.log, ...logged.warn, ...logged.error].every((line) => !line.includes(TOKEN) && !line.includes("sam@example.com")));
  });

  test("every request gets its own idempotency key and reference", async () => {
    const fetchImpl = mockFetch();
    await checkout(validOrder(), { fetchImpl });
    await checkout(validOrder(), { fetchImpl });
    const [a, b] = fetchImpl.links().map((c) => c.body);
    assert.notEqual(a.idempotency_key, b.idempotency_key);
    assert.notEqual(a.order.reference_id, b.order.reference_id);
  });

  test("a chosen pickup time becomes a SCHEDULED pickup", async () => {
    for (const pickupTime of ["2026-10-24T16:30:00.000Z", "2026-10-24T12:30:00-04:00", "2026-10-24T16:30Z"]) {
      clearMenuCache();
      const { status, fetchImpl } = await checkout(validOrder({ pickupTime }));
      assert.equal(status, 200, pickupTime);
      const { order, payment_note: note } = fetchImpl.links()[0].body;
      const details = order.fulfillments[0].pickup_details;
      assert.equal(details.schedule_type, "SCHEDULED");
      assert.equal(details.pickup_at, "2026-10-24T16:30:00Z");
      assert.equal("prep_time_duration" in details, false);
      assert.equal(order.ticket_name, "Sam L · 12:30 PM");
      assert.equal(order.metadata.pickup, "2026-10-24T16:30:00.000Z");
      assert.match(note, /^Online order\. Pickup 12:30 PM at Fall Classic Soccer Tournament, Riverside Sports Complex, Sat, Oct 24, 8:00 AM to 6:00 PM\./);
    }
  });

  test("ASAP before the stand opens means pickup at opening time", async () => {
    const { status, fetchImpl } = await checkout(validOrder({ eventId: FOOTBALL }), { now: new Date("2026-10-29T12:00:00Z") });
    assert.equal(status, 200);
    const { order, payment_note: note } = fetchImpl.links()[0].body;
    assert.deepEqual(
      { ...order.fulfillments[0].pickup_details, recipient: undefined, note: undefined },
      { recipient: undefined, note: undefined, schedule_type: "SCHEDULED", pickup_at: "2026-10-30T21:30:00Z" },
    );
    assert.equal(order.ticket_name, "Sam L · 5:30 PM");
    assert.equal(order.metadata.pickup, "asap");
    assert.equal(note, "Online order. Pickup when the stand opens (5:30 PM) at Friday Night Football, Memorial Stadium, Fri, Oct 30, 5:30 PM to 10:00 PM. For Sam Lee.");
    assert.match(order.reference_id, /^mf-20261029-/);
  });

  test("an email alone or a phone alone is enough, and phones become E.164", async () => {
    const emailOnly = await checkout(validOrder({ customer: { name: "Ana", email: "ana.b+stand@mail.example.org" } }));
    assert.equal(emailOnly.status, 200);
    assert.deepEqual(emailOnly.fetchImpl.links()[0].body.order.fulfillments[0].pickup_details.recipient,
      { display_name: "Ana", email_address: "ana.b+stand@mail.example.org" });
    assert.equal(emailOnly.fetchImpl.links()[0].body.order.ticket_name, "Ana · ASAP");

    clearMenuCache();
    const phoneOnly = await checkout(validOrder({ customer: { name: "  Jo   Ann\tSmith ", email: "", phone: "1-312-248-0123" } }));
    assert.equal(phoneOnly.status, 200);
    assert.deepEqual(phoneOnly.fetchImpl.links()[0].body.order.fulfillments[0].pickup_details.recipient,
      { display_name: "Jo Ann Smith", phone_number: "+13122480123" });
    assert.equal(phoneOnly.fetchImpl.links()[0].body.order.ticket_name, "Jo S · ASAP");
  });

  test("ignores prices and names sent by the page", async () => {
    const items = [{ variationId: varId("stoppage-time"), quantity: 1, priceCents: 1, name: "Free drink", base_price_money: { amount: 1 } }];
    const { status, fetchImpl } = await checkout({ ...validOrder({ items }), total: 1 });
    assert.equal(status, 200);
    assert.deepEqual(fetchImpl.links()[0].body.order.line_items, [{ catalog_object_id: varId("stoppage-time"), quantity: "1" }]);
    assert.doesNotMatch(JSON.stringify(fetchImpl.links()[0].body), /Free drink|price/);
  });

  test("returns to the request's own address when SITE_URL isn't set", async () => {
    const { SITE_URL, ...env } = ENV;
    const plain = await checkout(validOrder(), { env, url: "https://preview--matchdayfuel.netlify.app/api/checkout" });
    assert.equal(plain.fetchImpl.links()[0].body.checkout_options.redirect_url, "https://preview--matchdayfuel.netlify.app/?order=placed");
    clearMenuCache();
    const nested = await checkout(validOrder(), { env: { ...env, SITE_URL: "https://example.com/shop/" } });
    assert.equal(nested.fetchImpl.links()[0].body.checkout_options.redirect_url, "https://example.com/shop/?order=placed");
  });
});

describe("validation", () => {
  const long = (n) => "x".repeat(n);
  const cases = [
    ["a body that isn't an object", [], undefined, /JSON object/],
    ["no stop", validOrder({ eventId: undefined }), "eventId", /Choose a stop/],
    ["a blank stop", validOrder({ eventId: "   " }), "eventId", /Choose a stop/],
    ["no pickup time", validOrder({ pickupTime: undefined }), "pickupTime", /Choose a pickup time\./],
    ["a pickup time in words", validOrder({ pickupTime: "noon" }), "pickupTime", /from the list/],
    ["a pickup time without a zone", validOrder({ pickupTime: "2026-10-24T12:30" }), "pickupTime", /from the list/],
    ["an impossible date", validOrder({ pickupTime: "2026-02-30T12:30:00Z" }), "pickupTime", /from the list/],
    ["no items", validOrder({ items: undefined }), "items", /Add at least one drink/],
    ["an empty order", validOrder({ items: [] }), "items", /Add at least one drink/],
    ["eleven lines", validOrder({ items: Array.from({ length: 11 }, (_, i) => ({ variationId: `V${i}`, quantity: 1 })) }), "items", /up to 10 different drinks/],
    ["a line that isn't an object", validOrder({ items: ["VSTOPPAGETIME"] }), "items[0]", /isn't a drink/],
    ["a missing variation id", validOrder({ items: [{ quantity: 1 }] }), "items[0].variationId", /isn't on the menu/],
    ["a variation id with odd characters", validOrder({ items: [{ variationId: "../../v2", quantity: 1 }] }), "items[0].variationId", /isn't on the menu/],
    ["the same drink twice", validOrder({ items: [{ variationId: "VA", quantity: 1 }, { variationId: "VA", quantity: 2 }] }), "items[1].variationId", /only once/],
    ["a quantity of 0", validOrder({ items: [{ variationId: "VA", quantity: 0 }] }), "items[0].quantity", /from 1 to 12/],
    ["a quantity of 13", validOrder({ items: [{ variationId: "VA", quantity: 13 }] }), "items[0].quantity", /from 1 to 12/],
    ["a fractional quantity", validOrder({ items: [{ variationId: "VA", quantity: 1.5 }] }), "items[0].quantity", /from 1 to 12/],
    ["a quantity as text", validOrder({ items: [{ variationId: "VA", quantity: "2" }] }), "items[0].quantity", /from 1 to 12/],
    ["25 bottles", validOrder({ items: [{ variationId: "VA", quantity: 12 }, { variationId: "VB", quantity: 12 }, { variationId: "VC", quantity: 1 }] }), "items", /limited to 24 bottles\. This one has 25/],
    ["no customer", validOrder({ customer: undefined }), "customer.name", /Enter a name/],
    ["a blank name", validOrder({ customer: { name: " \t ", email: "sam@example.com" } }), "customer.name", /Enter a name/],
    ["a 61-character name", validOrder({ customer: { name: long(61), email: "sam@example.com" } }), "customer.name", /60 characters or fewer/],
    ["a name without letters", validOrder({ customer: { name: "!!!", email: "sam@example.com" } }), "customer.name", /using letters/],
    ["no email or phone", validOrder({ customer: { name: "Sam", email: " ", phone: "" } }), "customer.email", /email address or a phone number/],
    ["an unfinished email", validOrder({ customer: { name: "Sam", email: "sam@" } }), "customer.email", /like name@example\.com/],
    ["an email with a space", validOrder({ customer: { name: "Sam", email: "sam lee@example.com" } }), "customer.email", /like name@example\.com/],
    ["an email without a dot", validOrder({ customer: { name: "Sam", email: "sam@localhost" } }), "customer.email", /like name@example\.com/],
    ["an email that's a number", validOrder({ customer: { name: "Sam", email: 5 } }), "customer.email", /like name@example\.com/],
    ["a phone in words", validOrder({ customer: { name: "Sam", phone: "call me" } }), "customer.phone", /10-digit phone number/],
    ["a short phone", validOrder({ customer: { name: "Sam", phone: "248-0123" } }), "customer.phone", /10-digit phone number/],
    ["a 555 area code", validOrder({ customer: { name: "Sam", phone: "+15555550123" } }), "customer.phone", /area code/],
    ["an area code starting with 1", validOrder({ customer: { name: "Sam", phone: "(123) 456-7890" } }), "customer.phone", /area code/],
    ["a pickup time before opening", validOrder({ pickupTime: "2026-10-24T11:30:00Z" }), "pickupTime", /stand opens at 8:00 AM/, BEFORE],
    ["a pickup time that has passed", validOrder({ pickupTime: "2026-10-24T13:30:00Z" }), "pickupTime", /has passed/],
    ["a pickup time after the cutoff", validOrder({ pickupTime: "2026-10-24T21:50:00Z" }), "pickupTime", /by 5:45 PM, when orders close/],
    ["a variation that isn't on the menu", validOrder({ items: [{ variationId: "sample-hat-trick", quantity: 1 }] }), "items[0].variationId", /isn't on the menu anymore/],
  ];

  for (const [label, body, field, message, now = DURING] of cases) {
    test(`rejects ${label}`, async () => {
      const { status, data, fetchImpl } = await checkout(body, { now });
      assert.equal(status, 400, JSON.stringify(data));
      assert.equal(data.code, "INVALID");
      assert.equal(data.field, field);
      assert.match(data.error, message);
      assert.equal(fetchImpl.links().length, 0);
    });
  }

  test("rejects a body that isn't JSON", async () => {
    const { status, data } = await checkout(null, { raw: "{not json" });
    assert.deepEqual([status, data.code], [400, "INVALID"]);
    assert.match(data.error, /must be JSON/);
  });

  test("accepts a pickup slot from a browser clock up to a minute behind", async () => {
    const { status, fetchImpl } = await checkout(validOrder({ pickupTime: "2026-10-24T13:59:30Z" }));
    assert.equal(status, 200);
    assert.equal(fetchImpl.links()[0].body.order.fulfillments[0].pickup_details.pickup_at, "2026-10-24T14:00:00Z");
  });

  test("normalizes phone numbers typed common ways", () => {
    for (const input of ["3122480123", "(312) 248-0123", "312.248.0123", "1 312 248 0123", "+1 (312) 248-0123", "+13122480123"]) {
      assert.deepEqual(normalizePhone(input), { phone: "+13122480123" }, input);
    }
    assert.deepEqual(normalizePhone("+44 20 7946 0958"), { phone: "+442079460958" });
    for (const input of ["312-248-01234", "12-34", "3122480123 ext 5", "31+22480123", "+0123456789", "(312) 048-0123", "(312) 911-0123"]) {
      assert.ok(normalizePhone(input).problem, input);
    }
    assert.deepEqual(normalizePhone("(911) 248-0123"), { problem: "area" });
  });

  test("parses ISO times strictly", () => {
    assert.equal(parseIsoInstant("2026-10-24T16:30:00.000Z"), Date.parse("2026-10-24T16:30:00Z"));
    assert.equal(parseIsoInstant("2026-10-24T12:30:00-04:00"), Date.parse("2026-10-24T16:30:00Z"));
    assert.equal(parseIsoInstant("2028-02-29T00:00:00Z"), Date.parse("2028-02-29T00:00:00Z"));
    for (const text of ["2026-02-29T00:00:00Z", "2026-10-24T24:00:00Z", "2026-10-24 16:30Z", "2026-10-24T16:30:00+15:00", "2026-13-01T00:00Z"]) {
      assert.equal(parseIsoInstant(text), null, text);
    }
  });
});

describe("stock and stop checks", () => {
  test("409 OUT_OF_STOCK lists each short drink with what's left", async () => {
    const items = [
      { variationId: varId("stoppage-time"), quantity: 2 },
      { variationId: varId("hat-trick"), quantity: 1 },
      { variationId: varId("red-zone"), quantity: 5 },
    ];
    const { status, data, fetchImpl } = await checkout(validOrder({ items }));
    assert.equal(status, 409);
    assert.deepEqual(data, {
      error: "Hat Trick is sold out. Only 3 Red Zone are left. Update your order and try again.",
      code: "OUT_OF_STOCK",
      items: [{ variationId: varId("hat-trick"), available: 0 }, { variationId: varId("red-zone"), available: 3 }],
    });
    assert.equal(fetchImpl.links().length, 0);
  });

  test("an order for exactly what's left goes through; one more doesn't", async () => {
    assert.equal((await checkout(validOrder({ items: [{ variationId: varId("red-zone"), quantity: 3 }] }))).status, 200);
    clearMenuCache();
    const { status, data } = await checkout(validOrder({ items: [{ variationId: varId("buzzer-beater"), quantity: 2 }] }));
    assert.equal(status, 409);
    assert.equal(data.error, "Only 1 Buzzer Beater is left. Update your order and try again.");
  });

  test("409 EVENT_CLOSED after the cutoff, using ORDER_CUTOFF_MINUTES", async () => {
    const late = await checkout(validOrder(), { now: new Date("2026-10-24T21:46:00Z") });
    assert.equal(late.status, 409);
    assert.deepEqual(late.data, { error: "Orders for this stop closed at 5:45 PM. Choose another stop.", code: "EVENT_CLOSED" });
    assert.equal(late.fetchImpl.links().length, 0);

    clearMenuCache();
    const early = await checkout(validOrder(), { now: new Date("2026-10-24T21:10:00Z"), env: { ...ENV, ORDER_CUTOFF_MINUTES: "60" } });
    assert.equal(early.status, 409);
    assert.match(early.data.error, /closed at 5:00 PM/);

    clearMenuCache();
    const open = await checkout(validOrder(), { now: new Date("2026-10-24T21:10:00Z"), env: { ...ENV, ORDER_CUTOFF_MINUTES: "0" } });
    assert.equal(open.status, 200);
  });

  test("409 EVENT_CLOSED for a stop that isn't on the schedule (or has ended)", async () => {
    for (const [eventId, now] of [["no-such-stop", DURING], [SOCCER, new Date("2026-10-25T00:00:00Z")]]) {
      const { status, data } = await checkout(validOrder({ eventId }), { now });
      assert.equal(status, 409);
      assert.equal(data.code, "EVENT_CLOSED");
      assert.match(data.error, /isn't taking orders anymore/);
    }
  });
});

describe("Square failures", () => {
  test("503 NOT_CONNECTED in sample mode, before anything else", async () => {
    const fetchImpl = mockFetch();
    const response = await handleCheckout(post(validOrder()), { SITE_URL: ORIGIN }, { now: DURING, fetchImpl });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Online ordering isn't connected to Square yet.", code: "NOT_CONNECTED" });
    assert.deepEqual(fetchImpl.calls, []);
  });

  test("502 SQUARE_ERROR when Square fails to make the link, with details only in the log", async () => {
    const fetchImpl = mockFetch({
      paymentLink: () => squareJson({ errors: [{ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR", detail: "An internal error has occurred." }] }, 500),
    });
    const { status, data } = await checkout(validOrder(), { fetchImpl });
    assert.equal(status, 502);
    assert.deepEqual(data, { error: "Square couldn't start checkout, so no payment was taken. Try again in a moment.", code: "SQUARE_ERROR" });
    assert.equal(fetchImpl.links().length, 1, "a payment link is never retried");
    assert.ok(logged.error.some((line) => line.includes("INTERNAL_SERVER_ERROR")));
    assert.ok(logged.error.every((line) => !line.includes(TOKEN)));
  });

  test("an authentication failure logs a setup hint", async () => {
    const fetchImpl = mockFetch({
      paymentLink: () => squareJson({ errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: "This request could not be authorized." }] }, 401),
    });
    const { status } = await checkout(validOrder(), { fetchImpl });
    assert.equal(status, 502);
    assert.ok(logged.error.some((line) => line.includes("UNAUTHORIZED") && line.includes("Check SQUARE_ACCESS_TOKEN")));
  });

  test("502 when stock can't be checked", async () => {
    const fetchImpl = mockFetch({ catalog: () => squareJson({ errors: [{ category: "API_ERROR", code: "SERVICE_UNAVAILABLE" }] }, 503) });
    const { status, data } = await checkout(validOrder(), { fetchImpl });
    assert.equal(status, 502);
    assert.equal(data.code, "SQUARE_ERROR");
    assert.match(data.error, /check stock/);
    assert.equal(fetchImpl.links().length, 0);
  });

  test("Square's phone and email complaints point at the field", async () => {
    for (const [code, field] of [["INVALID_PHONE_NUMBER", "customer.phone"], ["INVALID_EMAIL_ADDRESS", "customer.email"]]) {
      clearMenuCache();
      const fetchImpl = mockFetch({
        paymentLink: () => squareJson({ errors: [{ category: "INVALID_REQUEST_ERROR", code, field: "order.fulfillments[0].pickup_details.recipient" }] }, 400),
      });
      const { status, data } = await checkout(validOrder(), { fetchImpl });
      assert.equal(status, 400);
      assert.equal(data.field, field);
      assert.match(data.error, /^Square couldn't use that/);
      assert.equal(fetchImpl.links().length, 1);
    }
  });

  test("falls back to a link without the fulfillment when Square rejects it", async () => {
    const fetchImpl = mockFetch({
      paymentLink: (call, attempt) => (attempt === 1
        ? squareJson({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "INVALID_VALUE", detail: "Fulfillments are not supported for payment links.", field: "order.fulfillments" }] }, 400)
        : paymentLinkReply(call.body)),
    });
    const { status, data } = await checkout(validOrder(), { fetchImpl });
    assert.equal(status, 200);
    assert.equal(data.checkoutUrl, "https://sandbox.square.link/u/Ab3dEf7h");
    const [first, second] = fetchImpl.links().map((c) => c.body);
    assert.ok(first.order.fulfillments);
    assert.notEqual(first.idempotency_key, second.idempotency_key);
    const { idempotency_key: key, order, ...rest } = second;
    assert.match(key, UUID);
    assert.deepEqual({ ...order, reference_id: undefined }, {
      location_id: LOC,
      reference_id: undefined,
      line_items: [
        { catalog_object_id: varId("stoppage-time"), quantity: "2", note: NOTE },
        { catalog_object_id: varId("golden-boot"), quantity: "1" },
      ],
    });
    assert.deepEqual(rest, {
      checkout_options: { redirect_url: "https://matchdayfuel.example/?order=placed", ask_for_shipping_address: false, allow_tipping: false },
      payment_note: NOTE,
      pre_populated_data: { buyer_email: "sam@example.com", buyer_phone_number: "+13122480123" },
    });
    assert.ok(logged.warn.some((line) => line.includes("without the pickup fulfillment")));
  });

  test("502 when Square's reply has no checkout URL", async () => {
    const fetchImpl = mockFetch({ paymentLink: () => squareJson({ payment_link: { id: "PL", version: 1, order_id: "O" } }) });
    const { status, data } = await checkout(validOrder(), { fetchImpl });
    assert.equal(status, 502);
    assert.equal(data.code, "SQUARE_ERROR");
  });
});

describe("HTTP", () => {
  test("413 for a request over 16 KB", async () => {
    const body = validOrder({ customer: { name: "Sam", email: "sam@example.com", padding: "x".repeat(17 * 1024) } });
    const { status, data, fetchImpl } = await checkout(body);
    assert.deepEqual([status, data.code], [413, "TOO_LARGE"]);
    assert.deepEqual(fetchImpl.calls, []);
  });

  test("405 for anything but POST", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const { status, data } = await checkout(validOrder(), { method });
      assert.deepEqual([status, data.code], [405, "METHOD_NOT_ALLOWED"], method);
    }
  });

  test("the Netlify function routes /api/checkout", async () => {
    assert.deepEqual(netlifyConfig, { path: "/api/checkout" });
    const response = await netlifyCheckout(new Request(`${ORIGIN}/api/checkout`));
    assert.equal(response.status, 405);
    assert.equal((await response.json()).code, "METHOD_NOT_ALLOWED");
  });
});

describe("adversarial review", () => {
  const extraItem = (id, name, amount, productType = "FOOD_AND_BEV") => ({
    type: "ITEM",
    id: `I${id}`,
    present_at_all_locations: true,
    item_data: {
      name,
      product_type: productType,
      variations: [{
        type: "ITEM_VARIATION",
        id: `V${id}`,
        present_at_all_locations: true,
        item_variation_data: { name: "Regular", pricing_type: "FIXED_PRICING", price_money: { amount, currency: "USD" } },
      }],
    },
  });

  test("only the ten drinks, at a price above zero, can be ordered", async () => {
    // Square catalogs hold more than the drinks: a $0 staff drink, merchandise. The menu used to
    // list them (with variation IDs), so a crafted order could add 12 free staff drinks.
    const catalog = () => {
      const objects = catalogObjects();
      objects.find((o) => o.item_data.name === "Hat Trick").item_data.variations[0].item_variation_data.price_money.amount = 0;
      objects.push(extraItem("STAFF", "Staff Drink", 0), extraItem("TEE", "Logo Tee", 2500, "REGULAR"));
      return squareJson({ objects });
    };
    const menu = await buildMenu({ env: ENV, fetchImpl: mockFetch({ catalog }), now: DURING.getTime(), fresh: true });
    assert.deepEqual(menu.items.map((item) => item.key), DRINKS.map((d) => d.key).filter((key) => key !== "hat-trick"));
    assert.ok(menu.items.every((item) => item.priceCents > 0));

    for (const variationId of ["VSTAFF", "VTEE", varId("hat-trick")]) {
      clearMenuCache();
      const items = [{ variationId: varId("stoppage-time"), quantity: 1 }, { variationId, quantity: 12 }];
      const { status, data, fetchImpl } = await checkout(validOrder({ items }), { fetchImpl: mockFetch({ catalog }) });
      assert.equal(status, 400, `${variationId}: ${JSON.stringify(data)}`);
      assert.equal(data.field, "items[1].variationId");
      assert.equal(fetchImpl.links().length, 0);
    }
    assert.ok(logged.warn.some((line) => line.includes("Hat Trick") && /price/.test(line)));
  });

  test("example stops from the sample schedule don't take real payments", async () => {
    // public/data/schedule.json ships with "sample": true stops. With production Square
    // connected and the file not yet replaced, customers would pay for a stop that isn't real.
    const sandboxMock = mockFetch();
    const production = async (url, init) => sandboxMock(String(url).replace("https://connect.squareup.com", SANDBOX), init);
    const env = { ...ENV, SQUARE_ENVIRONMENT: "production" };
    const { status, data } = await checkout(validOrder(), { env, fetchImpl: production });
    assert.equal(status, 409, JSON.stringify(data));
    assert.equal(data.code, "EVENT_CLOSED");
    assert.match(data.error, /example/i);
    assert.equal(sandboxMock.links().length, 0);

    // In sandbox the sample stops stay orderable, for testing.
    clearMenuCache();
    assert.equal((await checkout(validOrder())).status, 200);
  });

  test("a schedule outage isn't reported as 503, which the page reads as 'not connected'", async () => {
    const fetchImpl = mockFetch({ schedule: () => new Response("oops", { status: 500 }) });
    const { status, data } = await checkout(validOrder(), { fetchImpl });
    assert.notEqual(status, 503);
    assert.equal(status, 502);
    assert.equal(data.code, "SCHEDULE_UNAVAILABLE");
    assert.match(data.error, /no payment was taken/);
    assert.equal(fetchImpl.links().length, 0);
  });

  test("notes stay within Square's 500-character limits however they're counted", async () => {
    const emoji = (n) => "🏟️".repeat(n); // two code points, three UTF-16 units each
    const schedule = () => new Response(JSON.stringify({
      timezone: "America/New_York",
      events: [{ id: "emoji-stop", title: `Cup ${emoji(60)}`, venue: `Park ${emoji(60)}`, start: "2026-10-24T08:00", end: "2026-10-24T18:00" }],
    }));
    const customer = { name: `A ${"𝓐".repeat(58)}`, email: "sam@example.com" };
    const { status, fetchImpl } = await checkout(validOrder({ eventId: "emoji-stop", customer }), { fetchImpl: mockFetch({ schedule }) });
    assert.equal(status, 200);
    const body = fetchImpl.links()[0].body;
    const details = body.order.fulfillments[0].pickup_details;
    for (const [label, text, max] of [["payment_note", body.payment_note, 500], ["pickup note", details.note, 500], ["ticket_name", body.order.ticket_name, 255]]) {
      assert.ok(text.length <= max, `${label} is ${text.length} UTF-16 units`);
      assert.ok(new TextEncoder().encode(text).length <= max * 3, label);
      assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `${label} has a broken character`);
    }
    assert.match(body.payment_note, /…$/);
  });

  test("a name with a lone surrogate never reaches Square as broken text", async () => {
    const { status, fetchImpl } = await checkout(validOrder({ customer: { name: "Sam\uD800 Lee\uDC00", email: "sam@example.com" } }));
    assert.equal(status, 200);
    const sent = JSON.stringify(fetchImpl.links()[0].body);
    assert.doesNotMatch(sent, /\\ud[89a-f][0-9a-f]{2}/i);
    assert.equal(fetchImpl.links()[0].body.order.fulfillments[0].pickup_details.recipient.display_name, "Sam Lee");
  });

  test("an oversized body is refused without reading all of it", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`{"padding":"${"x".repeat(64 * 1024)}`);
    const stream = new ReadableStream({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 32 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request(`${ORIGIN}/api/checkout`, { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/json" } });
    const response = await handleCheckout(request, ENV, { now: DURING, fetchImpl: mockFetch() });
    assert.equal(response.status, 413);
    assert.ok(pulled <= 256 * 1024, `read ${pulled} bytes`);
  });
});

describe("logs", () => {
  test("Square error details that quote the customer's contact details are logged without them", async () => {
    const fetchImpl = mockFetch({
      paymentLink: (call, attempt) => (attempt === 1
        ? squareJson({ errors: [{
          category: "INVALID_REQUEST_ERROR",
          code: "INVALID_VALUE",
          field: "order.fulfillments[0].pickup_details.recipient",
          detail: "Recipient Sam Lee <sam@example.com> +13122480123 is not valid for fulfillments.",
        }] }, 400)
        : squareJson({ errors: [{ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR", detail: "Failed for sam@example.com / 3122480123" }] }, 500)),
    });
    const { status } = await checkout(validOrder(), { fetchImpl });
    assert.equal(status, 502);
    assert.equal(fetchImpl.links().length, 2);
    const lines = [...logged.log, ...logged.warn, ...logged.error];
    assert.ok(lines.some((line) => line.includes("INVALID_VALUE")), lines.join("\n"));
    for (const secret of ["sam@example.com", "+13122480123", "3122480123", "Sam Lee"]) {
      assert.ok(lines.every((line) => !line.includes(secret)), `${secret} in:\n${lines.join("\n")}`);
    }
  });
});
