// GET /api/menu: prices and stock for the drinks, from Square when it is connected.
//
// Square mode reads the catalog (ListCatalog, ITEM) and the IN_STOCK counts at
// SQUARE_LOCATION_ID (BatchRetrieveInventoryCounts) and maps each item to the SPEC shape:
//
// - Only the ten drinks in sample.mjs (matched by slugified name) are listed. Items that are
//   archived, not sold at the location, or not physical goods are left out.
// - Each item uses its variation named "Regular", or else its first variation at the location.
//   A variation without a fixed price above 0 can't be ordered online, so its item is left out
//   and the page shows it as not available.
// - The location's price override wins over the variation's price.
// - `available` is the IN_STOCK count rounded down when Square tracks inventory, else null.
//   `soldOut` is true when a tracked count is 0 or less, or when the location override marks
//   the variation sold out (and its sold_out_valid_until hasn't passed).
//
// The result is cached in memory for 60 seconds. Checkout asks for a fresh copy.

import { readConfig } from "./config.mjs";
import { json, requireMethod } from "./http.mjs";
import { DRINKS, sampleMenu } from "./sample.mjs";
import { createSquareClient } from "./square.mjs";

const CACHE_TTL_MS = 60_000;
const STALE_LIMIT_MS = 15 * 60_000;
const SELLABLE_PRODUCT_TYPES = new Set(["REGULAR", "FOOD_AND_BEV"]);
const DRINK_ORDER = new Map(DRINKS.map((drink, index) => [drink.key, index]));

const cache = new Map(); // key -> { fetchedAt, menu }
const inflight = new Map(); // key -> Promise<menu>
const warned = new Set();

function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[menu] ${message}`);
}

/** For tests: forgets cached menus and logged warnings. */
export function clearMenuCache() {
  cache.clear();
  inflight.clear();
  warned.clear();
}

/** Lowercase, accents removed, runs of anything but a-z and 0-9 become "-". */
export function slugify(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Whether a catalog object (item or variation) is enabled at a location. */
export function isPresentAt(object, locationId) {
  if (object?.present_at_all_locations !== false) {
    return !(object?.absent_at_location_ids ?? []).includes(locationId);
  }
  return (object?.present_at_location_ids ?? []).includes(locationId);
}

function chooseVariation(variations, locationId) {
  const usable = (Array.isArray(variations) ? variations : []).filter((variation) =>
    variation?.type === "ITEM_VARIATION"
    && typeof variation.id === "string" && variation.id
    && !variation.is_deleted
    && variation.item_variation_data
    && variation.item_variation_data.sellable !== false
    && isPresentAt(variation, locationId));
  return usable.find((variation) => String(variation.item_variation_data.name ?? "").trim().toLowerCase() === "regular")
    ?? usable[0]
    ?? null;
}

function moneyCents(money) {
  if (!money || typeof money !== "object") return null;
  const amount = Number(money.amount);
  if (!Number.isSafeInteger(amount) || amount < 0) return null;
  return { amount, currency: typeof money.currency === "string" && money.currency ? money.currency : "USD" };
}

function overrideSoldOut(override, nowMs) {
  if (override?.sold_out !== true) return false;
  const until = Date.parse(override.sold_out_valid_until ?? "");
  return !(Number.isFinite(until) && nowMs > until);
}

// One catalog item -> { key, name, variationId, price, tracked, soldOutByOverride } or null.
function readItem(object, locationId, nowMs) {
  if (object?.type !== "ITEM" || object.is_deleted) return null;
  const item = object.item_data;
  if (!item || item.is_archived === true || !isPresentAt(object, locationId)) return null;
  if (item.product_type && !SELLABLE_PRODUCT_TYPES.has(item.product_type)) return null;
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const key = slugify(name);
  // Only the ten drinks are sold online. The page shows nothing else, and checkout accepts only
  // what this menu lists, so another catalog item (a $0 staff drink, merchandise) can't be added
  // to an order by editing the request.
  if (!DRINK_ORDER.has(key)) return null;

  const variation = chooseVariation(item.variations, locationId);
  if (!variation) {
    warnOnce(`"${name}" has no variation available at this location, so it isn't offered online.`);
    return null;
  }
  const data = variation.item_variation_data;
  const override = (Array.isArray(data.location_overrides) ? data.location_overrides : [])
    .find((entry) => entry?.location_id === locationId);
  const pricingType = override?.pricing_type ?? data.pricing_type ?? "FIXED_PRICING";
  const price = pricingType === "FIXED_PRICING" ? moneyCents(override?.price_money) ?? moneyCents(data.price_money) : null;
  if (!price) {
    warnOnce(`"${name}" has no fixed price at this location, so it isn't offered online.`);
    return null;
  }
  if (price.amount <= 0) {
    warnOnce(`"${name}" has a price of 0 at this location, so it isn't offered online. Set its price in Square.`);
    return null;
  }
  return {
    key,
    name,
    variationId: variation.id,
    price,
    tracked: (override?.track_inventory ?? data.track_inventory ?? false) === true,
    soldOutByOverride: overrideSoldOut(override, nowMs),
  };
}

// Newest IN_STOCK count per variation at the location (Square sorts newest first).
function stockByVariation(counts, locationId) {
  const stock = new Map();
  for (const count of counts) {
    if (count?.state !== "IN_STOCK" || stock.has(count.catalog_object_id)) continue;
    if (count.location_id && count.location_id !== locationId) continue;
    const quantity = Number(count.quantity);
    stock.set(count.catalog_object_id, Number.isFinite(quantity) ? quantity : 0);
  }
  return stock;
}

function compareItems(a, b) {
  const rank = (item) => DRINK_ORDER.get(item.key) ?? DRINK_ORDER.size;
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

async function fetchSquareMenu(config, fetchImpl, nowMs) {
  const client = createSquareClient({ config, fetchImpl });
  const locationId = config.squareLocationId;
  const objects = await client.listCatalogItems();

  const entries = [];
  const keys = new Set();
  let currency = null;
  for (const object of objects) {
    const entry = readItem(object, locationId, nowMs);
    if (!entry) continue;
    if (keys.has(entry.key)) {
      warnOnce(`More than one Square item is named like "${entry.name}"; the site uses the first.`);
      continue;
    }
    currency ??= entry.price.currency;
    if (entry.price.currency !== currency) {
      warnOnce(`"${entry.name}" is priced in ${entry.price.currency}, not ${currency}, so it isn't offered online.`);
      continue;
    }
    keys.add(entry.key);
    entries.push(entry);
  }
  for (const drink of DRINKS) {
    if (!keys.has(drink.key)) warnOnce(`Square has no item named "${drink.name}" for sale at this location, so the site shows it as not available.`);
  }

  const tracked = entries.filter((entry) => entry.tracked).map((entry) => entry.variationId);
  const stock = tracked.length
    ? stockByVariation(await client.batchRetrieveInventoryCounts(tracked, locationId), locationId)
    : new Map();

  const items = entries.map((entry) => {
    let available = null;
    if (entry.tracked) {
      // A variation that has never been counted at the location has no IN_STOCK record: 0.
      available = entry.soldOutByOverride ? 0 : Math.max(0, Math.floor(stock.get(entry.variationId) ?? 0));
    }
    return {
      key: entry.key,
      name: entry.name,
      variationId: entry.variationId,
      priceCents: entry.price.amount,
      available,
      soldOut: entry.soldOutByOverride || (entry.tracked && available <= 0),
    };
  }).sort(compareItems);

  return { mode: "square", currency: currency ?? "USD", items };
}

const copy = (menu) => ({ ...menu, items: menu.items.map((item) => ({ ...item })) });

/**
 * The /api/menu body. Sample mode unless Square is configured. `fresh: true` skips the cache
 * (checkout uses it) and fails rather than serving an older copy.
 */
export async function buildMenu({ config, env, fetchImpl = fetch, now = Date.now(), fresh = false } = {}) {
  const settings = config ?? readConfig(env);
  if (!settings.squareConfigured) return sampleMenu();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const key = [settings.squareBaseUrl, settings.squareLocationId, settings.squareAccessToken].join("\n");
  const cached = cache.get(key);
  const age = cached ? nowMs - cached.fetchedAt : Infinity;
  if (!fresh && age >= 0 && age < CACHE_TTL_MS) return copy(cached.menu);

  let pending = fresh ? null : inflight.get(key);
  if (!pending) {
    pending = fetchSquareMenu(settings, fetchImpl, nowMs);
    if (!fresh) {
      inflight.set(key, pending);
      pending.then(() => inflight.delete(key), () => inflight.delete(key));
    }
  }
  try {
    const menu = await pending;
    cache.set(key, { fetchedAt: nowMs, menu });
    return copy(menu);
  } catch (error) {
    if (!fresh && age >= 0 && age < STALE_LIMIT_MS) {
      console.error(`[menu] ${error.describe?.() ?? error.message} Showing the menu from ${Math.round(age / 1000)} seconds ago.`);
      return copy(cached.menu);
    }
    throw error;
  }
}

/** GET /api/menu. The third argument is for tests. */
export async function handleMenu(request, env = {}, { fetchImpl = fetch, now = Date.now() } = {}) {
  requireMethod(request, "GET", "HEAD");
  let menu;
  try {
    menu = await buildMenu({ env, fetchImpl, now });
  } catch (error) {
    console.error(`[menu] ${error.describe?.() ?? error.message}`);
    return json(502, {
      error: "Prices and stock can't be loaded from Square right now. Try again in a moment.",
      code: "SQUARE_ERROR",
    });
  }
  return json(200, menu, { "cache-control": "public, max-age=30" });
}
