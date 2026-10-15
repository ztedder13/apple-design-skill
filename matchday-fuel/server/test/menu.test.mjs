import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readConfig, SQUARE_VERSION } from "../config.mjs";
import { buildMenu, clearMenuCache, handleMenu, isPresentAt, slugify } from "../menu.mjs";
import { DRINKS, sampleMenu } from "../sample.mjs";
import { createSquareClient, SquareError } from "../square.mjs";
import netlifyMenu, { config as netlifyConfig } from "../../netlify/functions/menu.mjs";

const LOC = "LQ7Z4N2M8KXRA";
const OTHER_LOC = "LOTHERLOC0001";
const TOKEN = "EAAAl-test-secret-token-0123456789";
const SANDBOX = "https://connect.squareupsandbox.com";
const PRODUCTION = "https://connect.squareup.com";
const NOW = Date.parse("2026-10-14T16:00:00Z");
const ENV = { SQUARE_ACCESS_TOKEN: TOKEN, SQUARE_LOCATION_ID: LOC, SQUARE_ENVIRONMENT: "sandbox" };
const MENU_KEYS = ["key", "name", "variationId", "priceCents", "available", "soldOut"];

// Catalog fixtures, shaped like ListCatalog's raw (snake_case) JSON --------------------------

const varId = (key, suffix = "") => `V${key.toUpperCase().replace(/-/g, "")}${suffix}`.slice(0, 24);

function variation(itemId, id, { name = "Regular", price = 600, track = true, overrides, extra = {}, data = {} } = {}) {
  return {
    type: "ITEM_VARIATION",
    id,
    updated_at: "2026-10-01T12:00:00.000Z",
    version: 1727784000000,
    is_deleted: false,
    present_at_all_locations: true,
    ...extra,
    item_variation_data: {
      item_id: itemId,
      name,
      ordinal: 0,
      pricing_type: price === null ? "VARIABLE_PRICING" : "FIXED_PRICING",
      ...(price === null ? {} : { price_money: { amount: price, currency: "USD" } }),
      ...(track === undefined ? {} : { track_inventory: track }),
      ...(overrides ? { location_overrides: overrides } : {}),
      sellable: true,
      stockable: true,
      ...data,
    },
  };
}

function item(id, name, variations, { extra = {}, data = {} } = {}) {
  return {
    type: "ITEM",
    id,
    updated_at: "2026-10-01T12:00:00.000Z",
    version: 1727784000000,
    is_deleted: false,
    present_at_all_locations: true,
    ...extra,
    item_data: { name, product_type: "REGULAR", is_archived: false, variations, ...data },
  };
}

function drinkItem(key, options = {}) {
  const drink = DRINKS.find((d) => d.key === key);
  const price = drink.line === "Cold brew" ? 600 : 650;
  const itemId = `I${varId(key).slice(1)}`;
  return item(itemId, drink.name, [variation(itemId, varId(key), { price, ...options })]);
}

const count = (id, quantity, extra = {}) => ({
  catalog_object_id: id,
  catalog_object_type: "ITEM_VARIATION",
  state: "IN_STOCK",
  location_id: LOC,
  quantity: String(quantity),
  calculated_at: "2026-10-14T15:00:00.000Z",
  ...extra,
});

const squareJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "square-version": SQUARE_VERSION, ...headers },
});

// A stand-in for Square. Pages are served by cursor; `routes` overrides an endpoint.
function mockSquare({ catalogPages = [[]], countPages = [[]], routes = {} } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = new URL(String(url));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { method, url: target, path: target.pathname, headers: init.headers ?? {}, body };
    calls.push(call);
    const route = routes[`${method} ${target.pathname}`];
    if (route) return route(call, calls.filter((c) => c.path === target.pathname).length);
    if (method === "GET" && target.pathname === "/v2/catalog/list") {
      const cursor = target.searchParams.get("cursor");
      const index = cursor ? Number(cursor.replace("catalog-page-", "")) : 0;
      const next = index + 1 < catalogPages.length ? { cursor: `catalog-page-${index + 1}` } : {};
      return squareJson({ objects: catalogPages[index], ...next });
    }
    if (method === "POST" && target.pathname === "/v2/inventory/counts/batch-retrieve") {
      const index = body.cursor ? Number(body.cursor.replace("count-page-", "")) : 0;
      const next = index + 1 < countPages.length ? { cursor: `count-page-${index + 1}` } : {};
      const wanted = new Set(body.catalog_object_ids);
      return squareJson({ counts: countPages[index].filter((c) => wanted.has(c.catalog_object_id)), ...next });
    }
    throw new TypeError(`fetch failed: no route for ${method} ${target.href}`);
  };
  impl.calls = calls;
  impl.paths = () => calls.map((c) => `${c.method} ${c.path}`);
  return impl;
}

const fullCatalog = () => DRINKS.map((d) => drinkItem(d.key));
const fullCounts = () => DRINKS.map((d) => count(varId(d.key), d.key === "hat-trick" ? 0 : d.key === "red-zone" ? 3 : 24));

let logged;
beforeEach((t) => {
  clearMenuCache();
  logged = { warn: [], error: [] };
  t.mock.method(console, "warn", (...args) => logged.warn.push(args.join(" ")));
  t.mock.method(console, "error", (...args) => logged.error.push(args.join(" ")));
});

describe("sample mode", () => {
  test("serves the ten drinks with sample prices and stock, without calling Square", async () => {
    const fetchImpl = mockSquare();
    const menu = await buildMenu({ env: {}, fetchImpl });
    assert.deepEqual(fetchImpl.calls, []);
    assert.equal(menu.mode, "sample");
    assert.equal(menu.currency, "USD");
    assert.deepEqual(menu.items.map((i) => i.key), DRINKS.map((d) => d.key));
    for (const entry of menu.items) assert.deepEqual(Object.keys(entry), MENU_KEYS);
    const byKey = Object.fromEntries(menu.items.map((i) => [i.key, i]));
    assert.deepEqual(byKey["stoppage-time"], {
      key: "stoppage-time", name: "Stoppage Time", variationId: "sample-stoppage-time", priceCents: 600, available: 24, soldOut: false,
    });
    assert.equal(byKey["golden-boot"].priceCents, 650);
    assert.deepEqual([byKey["hat-trick"].available, byKey["hat-trick"].soldOut], [0, true]);
    assert.deepEqual([byKey["red-zone"].available, byKey["red-zone"].soldOut], [3, false]);
    assert.equal(menu.items.filter((i) => i.soldOut).length, 1);
  });

  test("needs both the token and the location", async () => {
    for (const env of [{ SQUARE_ACCESS_TOKEN: TOKEN }, { SQUARE_LOCATION_ID: LOC }, { SQUARE_ACCESS_TOKEN: "  ", SQUARE_LOCATION_ID: LOC }]) {
      const menu = await buildMenu({ env, fetchImpl: mockSquare() });
      assert.equal(menu.mode, "sample");
    }
    assert.deepEqual(sampleMenu(), sampleMenu());
  });
});

describe("Square mode", () => {
  test("maps the catalog and inventory into the SPEC shape", async () => {
    const regularSecond = item("IREGULAR", "Golden Boot", [
      variation("IREGULAR", "VGOLDENSMALL", { name: "Small", price: 500 }),
      variation("IREGULAR", "VGOLDENREGULAR", { name: "Regular", price: 650 }),
    ]);
    const catalogPages = [
      [
        drinkItem("hat-trick"),
        drinkItem("stoppage-time", { overrides: [{ location_id: OTHER_LOC, price_money: { amount: 900, currency: "USD" } }, { location_id: LOC, price_money: { amount: 550, currency: "USD" } }] }),
        drinkItem("power-play", { track: false }), // untracked: available null
        item("ISEVENTH", "Seventh-Inning Stretch", [variation("ISEVENTH", varId("seventh-inning-stretch"))]),
        drinkItem("hail-mary", { overrides: [{ location_id: LOC, sold_out: true }] }), // sold out by hand
        drinkItem("full-court-press", { overrides: [{ location_id: LOC, sold_out: true, sold_out_valid_until: "2026-10-14T12:00:00Z" }] }), // expired
      ],
      [
        regularSecond,
        drinkItem("grand-slam", { track: undefined, overrides: [{ location_id: LOC, track_inventory: true }] }), // tracked only here
        drinkItem("red-zone"),
        drinkItem("buzzer-beater", { overrides: [{ location_id: LOC, track_inventory: false }] }), // tracking off here
        // Left out: an item that isn't one of the ten drinks, archived, not at this location, only
        // at another location, variable price, gift card, deleted variation, nameless.
        item("IEXTRA", "  Café Olé!! (16.9 oz) ", [variation("IEXTRA", "VEXTRA", { price: 300, track: false })]),
        item("IARCH", "Archived Drink", [variation("IARCH", "VARCH")], { data: { is_archived: true } }),
        item("IABSENT", "Absent Here", [variation("IABSENT", "VABSENT")], { extra: { absent_at_location_ids: [LOC] } }),
        item("IOTHER", "Other Location", [variation("IOTHER", "VOTHER")], { extra: { present_at_all_locations: false, present_at_location_ids: [OTHER_LOC] } }),
        item("IVAR", "Pay What You Want", [variation("IVAR", "VVAR", { price: null })]),
        item("IGIFT", "Gift Card", [variation("IGIFT", "VGIFT")], { data: { product_type: "GIFT_CARD" } }),
        item("IDELVAR", "Deleted Variation", [variation("IDELVAR", "VDELVAR", { extra: { is_deleted: true } })]),
        item("INONAME", "   ", [variation("INONAME", "VNONAME")]),
      ],
    ];
    const countPages = [
      [
        count(varId("hat-trick"), 0),
        count(varId("stoppage-time"), "24"),
        count(varId("stoppage-time"), "99", { calculated_at: "2026-10-13T15:00:00.000Z" }), // older duplicate: ignored
        count(varId("hail-mary"), 12),
      ],
      [
        count(varId("seventh-inning-stretch"), "3.5"),
        count(varId("full-court-press"), "-2"),
        count("VGOLDENREGULAR", 40),
        count(varId("red-zone"), 3),
        // grand-slam has no IN_STOCK record: tracked, so 0.
      ],
    ];
    const fetchImpl = mockSquare({ catalogPages, countPages });
    const menu = await buildMenu({ env: ENV, fetchImpl, now: NOW });

    assert.equal(menu.mode, "square");
    assert.equal(menu.currency, "USD");
    for (const entry of menu.items) assert.deepEqual(Object.keys(entry), MENU_KEYS);
    assert.deepEqual(menu.items, [
      { key: "stoppage-time", name: "Stoppage Time", variationId: varId("stoppage-time"), priceCents: 550, available: 24, soldOut: false },
      { key: "power-play", name: "Power Play", variationId: varId("power-play"), priceCents: 600, available: null, soldOut: false },
      { key: "seventh-inning-stretch", name: "Seventh-Inning Stretch", variationId: varId("seventh-inning-stretch"), priceCents: 600, available: 3, soldOut: false },
      { key: "hail-mary", name: "Hail Mary", variationId: varId("hail-mary"), priceCents: 600, available: 0, soldOut: true },
      { key: "full-court-press", name: "Full Court Press", variationId: varId("full-court-press"), priceCents: 600, available: 0, soldOut: true },
      { key: "golden-boot", name: "Golden Boot", variationId: "VGOLDENREGULAR", priceCents: 650, available: 40, soldOut: false },
      { key: "grand-slam", name: "Grand Slam", variationId: varId("grand-slam"), priceCents: 650, available: 0, soldOut: true },
      { key: "red-zone", name: "Red Zone", variationId: varId("red-zone"), priceCents: 650, available: 3, soldOut: false },
      { key: "buzzer-beater", name: "Buzzer Beater", variationId: varId("buzzer-beater"), priceCents: 650, available: null, soldOut: false },
      { key: "hat-trick", name: "Hat Trick", variationId: varId("hat-trick"), priceCents: 650, available: 0, soldOut: true },
    ]);

    // Two catalog pages, then two inventory pages.
    assert.deepEqual(fetchImpl.paths(), [
      "GET /v2/catalog/list", "GET /v2/catalog/list",
      "POST /v2/inventory/counts/batch-retrieve", "POST /v2/inventory/counts/batch-retrieve",
    ]);
    const [first, second, inventory, inventory2] = fetchImpl.calls;
    assert.equal(first.url.href, `${SANDBOX}/v2/catalog/list?types=ITEM`);
    assert.equal(second.url.href, `${SANDBOX}/v2/catalog/list?types=ITEM&cursor=catalog-page-1`);
    for (const call of fetchImpl.calls) {
      assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(call.headers["Square-Version"], "2026-08-19");
      assert.equal(call.headers.Accept, "application/json");
    }
    assert.equal(inventory.headers["Content-Type"], "application/json");
    // Only tracked variations are counted; the untracked ones are left out of the request.
    assert.deepEqual(inventory.body, {
      catalog_object_ids: [
        varId("hat-trick"), varId("stoppage-time"), varId("seventh-inning-stretch"), varId("hail-mary"),
        varId("full-court-press"), "VGOLDENREGULAR", varId("grand-slam"), varId("red-zone"),
      ],
      location_ids: [LOC],
      states: ["IN_STOCK"],
      limit: 1000,
    });
    assert.deepEqual(inventory2.body, { ...inventory.body, cursor: "count-page-1" });
    // Items that aren't drinks are skipped quietly; a catalog can hold many.
    assert.ok(!logged.warn.some((line) => line.includes("Pay What You Want") || line.includes("Café")));
  });

  test("a drink without a fixed price above 0 is left out, with a warning", async () => {
    const catalog = fullCatalog().filter((o) => !["power-play", "red-zone"].includes(slugify(o.item_data.name)));
    catalog.push(drinkItem("power-play", { price: null }), drinkItem("red-zone", { price: 0 }));
    const menu = await buildMenu({ env: ENV, fetchImpl: mockSquare({ catalogPages: [catalog], countPages: [fullCounts()] }), now: NOW });
    assert.deepEqual(menu.items.map((i) => i.key), DRINKS.map((d) => d.key).filter((k) => k !== "power-play" && k !== "red-zone"));
    assert.ok(logged.warn.some((line) => line.includes("Power Play") && line.includes("fixed price")));
    assert.ok(logged.warn.some((line) => line.includes("Red Zone") && line.includes("price of 0")));
  });

  test("slugs item names the way the page keys them", () => {
    assert.equal(slugify("Seventh-Inning Stretch"), "seventh-inning-stretch");
    assert.equal(slugify("  Full   Court Press "), "full-court-press");
    assert.equal(slugify("Hat Trick's — Berry!"), "hat-trick-s-berry");
    assert.equal(slugify("Crème Brûlée"), "creme-brulee");
    assert.equal(slugify("!!!"), "");
  });

  test("reads location presence the way Square defines it", () => {
    assert.equal(isPresentAt({}, LOC), true);
    assert.equal(isPresentAt({ present_at_all_locations: true, absent_at_location_ids: [LOC] }, LOC), false);
    assert.equal(isPresentAt({ present_at_all_locations: false, present_at_location_ids: [LOC] }, LOC), true);
    assert.equal(isPresentAt({ present_at_all_locations: false }, LOC), false);
  });

  test("skips the inventory call when nothing is tracked, and uses production when asked", async () => {
    const fetchImpl = mockSquare({ catalogPages: [DRINKS.map((d) => drinkItem(d.key, { track: false }))] });
    const menu = await buildMenu({ env: { ...ENV, SQUARE_ENVIRONMENT: " Production " }, fetchImpl, now: NOW });
    assert.deepEqual(fetchImpl.paths(), ["GET /v2/catalog/list"]);
    assert.equal(fetchImpl.calls[0].url.origin, PRODUCTION);
    assert.ok(menu.items.every((i) => i.available === null && !i.soldOut));
  });

  test("warns once for a drink Square doesn't sell at the location", async () => {
    const fetchImpl = mockSquare({ catalogPages: [fullCatalog().filter((o) => o.item_data.name !== "Red Zone")], countPages: [fullCounts()] });
    const menu = await buildMenu({ env: ENV, fetchImpl, now: NOW });
    assert.equal(menu.items.length, 9);
    await buildMenu({ env: ENV, fetchImpl, now: NOW + 61_000 });
    assert.equal(logged.warn.filter((line) => line.includes('"Red Zone"')).length, 1);
  });

  test("keeps the first of two items with the same name", async () => {
    const twin = item("ITWIN", "stoppage  time", [variation("ITWIN", "VTWIN", { price: 100 })]);
    const fetchImpl = mockSquare({ catalogPages: [[...fullCatalog(), twin]], countPages: [fullCounts()] });
    const menu = await buildMenu({ env: ENV, fetchImpl, now: NOW });
    assert.equal(menu.items.find((i) => i.key === "stoppage-time").variationId, varId("stoppage-time"));
    assert.ok(logged.warn.some((line) => line.includes("More than one")));
  });
});

describe("caching", () => {
  test("reuses the menu for 60 seconds; fresh reads skip the cache", async () => {
    const fetchImpl = mockSquare({ catalogPages: [fullCatalog()], countPages: [fullCounts()] });
    const first = await buildMenu({ env: ENV, fetchImpl, now: NOW });
    first.items[0].priceCents = 1; // callers get copies
    const second = await buildMenu({ env: ENV, fetchImpl, now: NOW + 59_000 });
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(second.items[0].priceCents, 600);
    await buildMenu({ env: ENV, fetchImpl, now: NOW + 60_000 });
    assert.equal(fetchImpl.calls.length, 4);
    await buildMenu({ env: ENV, fetchImpl, now: NOW + 61_000, fresh: true });
    assert.equal(fetchImpl.calls.length, 6);
  });

  test("shares one Square read between simultaneous requests", async () => {
    const fetchImpl = mockSquare({ catalogPages: [fullCatalog()], countPages: [fullCounts()] });
    await Promise.all([1, 2, 3].map(() => buildMenu({ env: ENV, fetchImpl, now: NOW })));
    assert.equal(fetchImpl.calls.length, 2);
  });

  test("serves the last good menu when Square fails, but not to a fresh read", async () => {
    let down = false;
    const fetchImpl = mockSquare({
      catalogPages: [fullCatalog()],
      countPages: [fullCounts()],
      routes: {
        "GET /v2/catalog/list": () => (down
          ? squareJson({ errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: "This request could not be authorized." }] }, 401)
          : squareJson({ objects: fullCatalog() })),
      },
    });
    await buildMenu({ env: ENV, fetchImpl, now: NOW });
    down = true;
    const stale = await buildMenu({ env: ENV, fetchImpl, now: NOW + 5 * 60_000 });
    assert.equal(stale.mode, "square");
    assert.ok(logged.error.some((line) => line.includes("UNAUTHORIZED") && line.includes("Showing the menu from")));
    await assert.rejects(buildMenu({ env: ENV, fetchImpl, now: NOW + 5 * 60_000, fresh: true }), SquareError);
    await assert.rejects(buildMenu({ env: ENV, fetchImpl, now: NOW + 16 * 60_000 }), SquareError);
  });
});

describe("Square client", () => {
  const config = readConfig(ENV);

  test("retries a read once after a 5xx or 429, never a write", async () => {
    let attempts = 0;
    const flaky = mockSquare({
      routes: {
        "GET /v2/catalog/list": () => (++attempts === 1
          ? squareJson({ errors: [{ category: "API_ERROR", code: "SERVICE_UNAVAILABLE" }] }, 503)
          : squareJson({ objects: [] })),
        "POST /v2/online-checkout/payment-links": () => squareJson({ errors: [{ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR" }] }, 500),
      },
    });
    const sleeps = [];
    const client = createSquareClient({ config, fetchImpl: flaky, sleep: async (ms) => sleeps.push(ms) });
    assert.deepEqual(await client.listCatalogItems(), []);
    assert.equal(attempts, 2);
    assert.equal(sleeps.length, 1);
    await assert.rejects(client.createPaymentLink({ idempotency_key: "k" }), (error) => {
      assert.ok(error instanceof SquareError);
      assert.equal(error.status, 500);
      assert.equal(error.code, "INTERNAL_SERVER_ERROR");
      return true;
    });
    assert.equal(flaky.calls.filter((c) => c.path === "/v2/online-checkout/payment-links").length, 1);

    const limited = mockSquare({ routes: { "GET /v2/catalog/list": () => squareJson({ errors: [{ category: "RATE_LIMIT_ERROR", code: "RATE_LIMITED" }] }, 429, { "retry-after": "60" }) } });
    const patient = createSquareClient({ config, fetchImpl: limited, sleep: async () => {} });
    await assert.rejects(patient.listCatalogItems(), { status: 429, code: "RATE_LIMITED" });
    assert.equal(limited.calls.length, 1, "a long Retry-After isn't waited out");
  });

  test("turns Square's errors into a SquareError without the token", async () => {
    const fetchImpl = mockSquare({
      routes: {
        "GET /v2/catalog/list": () => squareJson({
          errors: [{ category: "INVALID_REQUEST_ERROR", code: "INVALID_VALUE", detail: "Invalid types", field: "types" }],
        }, 400),
      },
    });
    const client = createSquareClient({ config, fetchImpl });
    const error = await client.listCatalogItems().catch((e) => e);
    assert.ok(error instanceof SquareError);
    assert.equal(error.status, 400);
    assert.equal(error.category, "INVALID_REQUEST_ERROR");
    assert.deepEqual(error.errors, [{ category: "INVALID_REQUEST_ERROR", code: "INVALID_VALUE", detail: "Invalid types", field: "types" }]);
    assert.match(error.describe(), /GET \/v2\/catalog\/list\?types=ITEM failed with HTTP 400: INVALID_VALUE field types Invalid types/);
    assert.ok(!`${error.message} ${error.describe()} ${JSON.stringify(error)}`.includes(TOKEN));
  });

  test("reports a reply that isn't JSON, a dropped connection, and a timeout", async () => {
    const html = mockSquare({ routes: { "GET /v2/catalog/list": () => new Response("<html>Bad gateway</html>", { status: 502 }) } });
    await assert.rejects(createSquareClient({ config, fetchImpl: html, sleep: async () => {} }).listCatalogItems(), { status: 502, code: "HTTP_502" });
    assert.equal(html.calls.length, 2);

    let dropped = 0;
    const offline = async () => {
      dropped += 1;
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    };
    await assert.rejects(createSquareClient({ config, fetchImpl: offline, sleep: async () => {} }).listCatalogItems(), { code: "NETWORK_ERROR" });
    assert.equal(dropped, 2);

    let hung = 0;
    const slow = (url, init) => new Promise((_, reject) => {
      hung += 1;
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    await assert.rejects(createSquareClient({ config, fetchImpl: slow, timeoutMs: 20 }).listCatalogItems(), { code: "TIMEOUT" });
    assert.equal(hung, 1, "a timeout isn't retried");
  });

  test("batches inventory lookups and skips empty ones", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `V${i}`);
    const fetchImpl = mockSquare({ countPages: [ids.map((id) => count(id, 1))] });
    const client = createSquareClient({ config, fetchImpl });
    assert.equal((await client.batchRetrieveInventoryCounts(ids, LOC)).length, 150);
    assert.deepEqual(fetchImpl.calls.map((c) => c.body.catalog_object_ids.length), [100, 50]);
    assert.deepEqual(await client.batchRetrieveInventoryCounts([], LOC), []);
    assert.equal(fetchImpl.calls.length, 2);
  });

  test("stops on a repeated page cursor", async () => {
    const fetchImpl = mockSquare({ routes: { "GET /v2/catalog/list": () => squareJson({ objects: [], cursor: "same" }) } });
    await assert.rejects(createSquareClient({ config, fetchImpl }).listCatalogItems(), /repeated a page cursor/);
  });
});

describe("GET /api/menu", () => {
  test("answers with the menu and a 30-second cache header", async () => {
    const fetchImpl = mockSquare({ catalogPages: [fullCatalog()], countPages: [fullCounts()] });
    const response = await handleMenu(new Request("https://matchdayfuel.example/api/menu"), ENV, { fetchImpl, now: NOW });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=30");
    assert.match(response.headers.get("content-type"), /^application\/json/);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["mode", "currency", "items"]);
    assert.equal(body.items.length, 10);
  });

  test("answers 502 SQUARE_ERROR when Square can't be read, without details", async () => {
    const fetchImpl = mockSquare({ routes: { "GET /v2/catalog/list": () => squareJson({ errors: [{ category: "AUTHENTICATION_ERROR", code: "ACCESS_TOKEN_REVOKED" }] }, 401) } });
    const response = await handleMenu(new Request("https://matchdayfuel.example/api/menu"), ENV, { fetchImpl, now: NOW });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.code, "SQUARE_ERROR");
    assert.doesNotMatch(body.error, /TOKEN|401/);
    assert.ok(logged.error.some((line) => line.includes("ACCESS_TOKEN_REVOKED")));
    assert.ok(logged.error.every((line) => !line.includes(TOKEN)));
  });

  test("the Netlify function routes /api/menu and rejects other methods", async () => {
    assert.deepEqual(netlifyConfig, { path: "/api/menu" });
    const response = await netlifyMenu(new Request("https://matchdayfuel.example/api/menu", { method: "POST", body: "{}" }));
    assert.equal(response.status, 405);
    assert.equal((await response.json()).code, "METHOD_NOT_ALLOWED");
  });
});
