// A small Square REST client: just the four calls this site makes, with no SDK.
//
// - Every request sends the bearer token, the pinned Square-Version, and JSON.
// - Each attempt has a 10-second limit.
// - Reads (GET, and the read-only inventory POST) are retried once after a short pause when
//   Square answers 429 or 5xx, or the connection fails before any answer. Writes are never
//   retried here; a failed checkout is reported to the customer instead.
// - Failures become a SquareError that carries the HTTP status and Square's errors[] list
//   ({ category, code, detail, field }). The access token never appears in a message.

export const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 400;
const MAX_RETRY_AFTER_MS = 2_000;
const MAX_PAGES = 50;
const INVENTORY_BATCH = 100;

export class SquareError extends Error {
  constructor(message, { status = 0, errors = [], method = "", path = "" } = {}) {
    super(message);
    this.name = "SquareError";
    this.status = status;
    this.errors = errors;
    this.method = method;
    this.path = path;
    this.code = errors[0]?.code ?? (status ? `HTTP_${status}` : "NETWORK_ERROR");
    this.category = errors[0]?.category ?? "";
  }

  /** One line for server logs: status, then each error's code, field, and detail. */
  describe() {
    const parts = this.errors.map((e) => [e.code, e.field && `field ${e.field}`, e.detail].filter(Boolean).join(" "));
    return `Square ${this.method} ${this.path} failed${this.status ? ` with HTTP ${this.status}` : ""}: ${parts.join("; ") || this.message}`;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response) {
  const header = response.headers.get("retry-after");
  if (!header) return RETRY_DELAY_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : RETRY_DELAY_MS;
}

function normalizeErrors(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      category: String(e.category ?? ""),
      code: String(e.code ?? ""),
      ...(e.detail != null ? { detail: String(e.detail).slice(0, 500) } : {}),
      ...(e.field != null ? { field: String(e.field).slice(0, 200) } : {}),
    }));
}

/**
 * createSquareClient({ config, fetchImpl }) where config comes from readConfig().
 * `sleep` and `timeoutMs` can be replaced in tests.
 */
export function createSquareClient({ config, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, sleep = delay } = {}) {
  if (!config?.squareConfigured) throw new Error("Square isn't configured (SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID).");
  const base = config.squareBaseUrl;

  async function attempt(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.squareAccessToken}`,
          "Square-Version": config.squareVersion,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const raw = await response.text();
      let data = null;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = null;
      }
      return { response, data };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const cause = error?.cause?.code ? ` (${error.cause.code})` : "";
      throw new SquareError(
        timedOut ? `Square didn't answer within ${timeoutMs / 1000} seconds.` : `Couldn't reach Square: ${error?.message ?? error}${cause}`,
        { method, path, errors: [{ category: "API_ERROR", code: timedOut ? "TIMEOUT" : "NETWORK_ERROR" }] },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends one request and returns the parsed JSON body. `retry` defaults to true for GET only;
   * pass { retry: true } for a POST that only reads.
   */
  async function request(method, path, body, { retry = method === "GET" } = {}) {
    let result;
    try {
      result = await attempt(method, path, body);
    } catch (error) {
      // A connection that failed before any answer is safe to retry for reads; a timeout is not
      // worth a second 10-second wait.
      if (!retry || error.code === "TIMEOUT") throw error;
      await sleep(RETRY_DELAY_MS);
      result = await attempt(method, path, body);
    }
    const retryable = (status) => status === 429 || status >= 500;
    if (retry && retryable(result.response.status)) {
      const wait = retryAfterMs(result.response);
      if (wait <= MAX_RETRY_AFTER_MS) {
        await sleep(Math.max(wait, 100) + Math.floor(Math.random() * 100));
        result = await attempt(method, path, body);
      }
    }
    const { response, data } = result;
    const errors = normalizeErrors(data?.errors);
    if (!response.ok || data === null || errors.length) {
      const detail = errors.length ? errors.map((e) => e.code).join(", ") : data === null ? "a reply that isn't JSON" : "no details";
      throw new SquareError(`Square answered HTTP ${response.status} (${detail}).`, {
        status: response.status,
        errors: errors.length ? errors : [{ category: "API_ERROR", code: response.ok ? "BAD_RESPONSE" : `HTTP_${response.status}` }],
        method,
        path,
      });
    }
    return data;
  }

  // Follows `cursor` until Square stops sending one. `send(cursor)` returns one page.
  async function paginate(send, pick) {
    const results = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await send(cursor);
      results.push(...(Array.isArray(pick(data)) ? pick(data) : []));
      cursor = typeof data.cursor === "string" && data.cursor ? data.cursor : undefined;
      if (!cursor) return results;
      if (seen.has(cursor)) throw new SquareError("Square repeated a page cursor.", { errors: [{ category: "API_ERROR", code: "BAD_RESPONSE" }] });
      seen.add(cursor);
    }
    throw new SquareError(`Square returned more than ${MAX_PAGES} pages.`, { errors: [{ category: "API_ERROR", code: "TOO_MANY_PAGES" }] });
  }

  /** Every ITEM in the catalog (ListCatalog excludes deleted objects), variations nested. */
  function listCatalogItems() {
    return paginate(
      (cursor) => request("GET", `/v2/catalog/list?types=ITEM${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
      (data) => data.objects,
    );
  }

  /** IN_STOCK counts for these variations at one location, as Square's InventoryCount objects. */
  async function batchRetrieveInventoryCounts(variationIds, locationId) {
    const ids = [...new Set(variationIds.filter(Boolean))];
    const counts = [];
    for (let i = 0; i < ids.length; i += INVENTORY_BATCH) {
      const body = {
        catalog_object_ids: ids.slice(i, i + INVENTORY_BATCH),
        location_ids: [locationId],
        states: ["IN_STOCK"],
        limit: 1000,
      };
      counts.push(...await paginate(
        (cursor) => request("POST", "/v2/inventory/counts/batch-retrieve", cursor ? { ...body, cursor } : body, { retry: true }),
        (data) => data.counts,
      ));
    }
    return counts;
  }

  /** CreatePaymentLink. Not retried: the caller decides what a failure means. */
  function createPaymentLink(body) {
    return request("POST", "/v2/online-checkout/payment-links", body, { retry: false });
  }

  return { request, listCatalogItems, batchRetrieveInventoryCounts, createPaymentLink };
}
