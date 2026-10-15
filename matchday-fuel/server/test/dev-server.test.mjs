import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile, parseEnvFile, startDevServer } from "../dev-server.mjs";
import { clearMenuCache } from "../menu.mjs";
import { clearScheduleCache } from "../schedule.mjs";

// Raw HTTP, so paths like /../ reach the server exactly as written.
function raw(base, pathname, { method = "GET", headers = {}, body } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("static files", () => {
  let dir;
  let root;
  let site;
  const SECRET = "outside-the-public-folder";

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mf-dev-"));
    root = path.join(dir, "public");
    await mkdir(path.join(root, "sub"), { recursive: true });
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(dir, "secret.txt"), SECRET);
    await writeFile(path.join(dir, "public-other.txt"), SECRET); // shares the "public" prefix
    await writeFile(path.join(root, "index.html"), "<!doctype html><title>Home</title>");
    await writeFile(path.join(root, "sub", "index.html"), "<!doctype html><title>Sub</title>");
    await writeFile(path.join(root, "module.mjs"), "export const a = 1;");
    await writeFile(path.join(root, "app.js"), "console.log(1);");
    await writeFile(path.join(root, "data.json"), "{\"ok\":true}");
    await writeFile(path.join(root, "styles.css"), "body{}");
    await writeFile(path.join(root, "assets", "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await writeFile(path.join(root, "assets", "bottle.webp"), Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1"));
    await writeFile(path.join(root, "assets", "photo.JPG"), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(path.join(root, "file name.txt"), "spaces");
    await writeFile(path.join(root, ".env"), `SQUARE_ACCESS_TOKEN=${SECRET}`);
    await writeFile(path.join(root, "unknown.bin"), "bin");
    await symlink(path.join(dir, "secret.txt"), path.join(root, "escape.txt"));
    site = await startDevServer({ port: 0, host: "127.0.0.1", root, env: {} });
  });

  after(async () => {
    await site?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("serves index.html for / and for directories", async () => {
    const home = await raw(site.url, "/");
    assert.equal(home.status, 200);
    assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
    assert.match(home.body, /<title>Home/);
    const redirect = await raw(site.url, "/sub");
    assert.deepEqual([redirect.status, redirect.headers.location], [301, "/sub/"]);
    assert.match((await raw(site.url, "/sub/?x=1")).body, /<title>Sub/);
  });

  test("sends the right content type for each file", async () => {
    const expected = {
      "/module.mjs": "text/javascript; charset=utf-8",
      "/app.js": "text/javascript; charset=utf-8",
      "/data.json": "application/json; charset=utf-8",
      "/styles.css": "text/css; charset=utf-8",
      "/assets/logo.svg": "image/svg+xml",
      "/assets/bottle.webp": "image/webp",
      "/assets/photo.JPG": "image/jpeg",
      "/file%20name.txt": "text/plain; charset=utf-8",
      "/unknown.bin": "application/octet-stream",
    };
    for (const [pathname, type] of Object.entries(expected)) {
      const response = await raw(site.url, pathname);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers["content-type"], type, pathname);
      assert.equal(response.headers["x-content-type-options"], "nosniff");
    }
  });

  test("answers HEAD with headers only", async () => {
    const response = await raw(site.url, "/data.json", { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-length"], "11");
    assert.equal(response.body, "");
    assert.equal((await raw(site.url, "/data.json", { method: "POST" })).status, 405);
  });

  test("blocks path traversal, dot-files, and symlinks out of the folder", async () => {
    const attempts = [
      "/../secret.txt",
      "/../../secret.txt",
      "/sub/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/sub/..%2f..%2fsecret.txt",
      "/..%5csecret.txt",
      "/%2e%2e%5csecret.txt",
      "/../public-other.txt",
      "/.env",
      "/%2eenv",
      "/sub/%2e%2e/.env",
      "/escape.txt",
      "/index.html%00.txt",
      "/%E0%A4%A",
      `/${"a/".repeat(50)}`,
    ];
    for (const pathname of attempts) {
      const response = await raw(site.url, pathname);
      assert.ok([400, 404].includes(response.status), `${pathname} -> ${response.status}`);
      assert.ok(!response.body.includes(SECRET), pathname);
    }
  });

  test("a folder redirect never points at another host", async () => {
    // "/.//sub" normalizes to the path "//sub"; a Location of "//sub/" would send the browser
    // to http://sub/.
    for (const pathname of ["/.//sub", "/sub/..//sub", "/./%2fsub"]) {
      const response = await raw(site.url, pathname);
      assert.equal(response.status, 301, pathname);
      const target = new URL(response.headers.location, site.url);
      assert.equal(target.origin, new URL(site.url).origin, `${pathname} -> ${response.headers.location}`);
    }
  });

  test("shows a 404 page for missing files", async () => {
    const response = await raw(site.url, "/nope.html");
    assert.equal(response.status, 404);
    assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
    assert.match(response.body, /Page not found/);
    assert.match(response.body, /href="\/"/);
  });
});

describe("API routes on the real site", () => {
  let site;

  before(async () => {
    clearMenuCache();
    clearScheduleCache();
    site = await startDevServer({ port: 0, host: "127.0.0.1", env: { BUSINESS_TIMEZONE: "America/New_York" } });
  });

  after(async () => {
    await site?.close();
    clearMenuCache();
    clearScheduleCache();
  });

  test("serves the page and its scripts from public/", async () => {
    const home = await raw(site.url, "/");
    assert.equal(home.status, 200);
    assert.match(home.body, /Matchday Fuel/);
    assert.equal((await raw(site.url, "/js/app.js")).headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal((await raw(site.url, "/data/schedule.json")).headers["content-type"], "application/json; charset=utf-8");
  });

  test("/api/menu answers with the sample menu", async () => {
    const response = await fetch(`${site.url}/api/menu`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=30");
    const menu = await response.json();
    assert.equal(menu.mode, "sample");
    assert.equal(menu.items.length, 10);
  });

  test("/api/schedule reads the site's own schedule.json, even with a forged Host header", async () => {
    const plain = await fetch(`${site.url}/api/schedule`);
    assert.equal(plain.status, 200);
    const schedule = await plain.json();
    assert.equal(schedule.mode, "file");
    assert.equal(schedule.timezone, "America/New_York");

    clearScheduleCache();
    const forged = await raw(site.url, "/api/schedule", { headers: { host: "attacker.invalid" } });
    assert.equal(forged.status, 200);
    assert.equal(JSON.parse(forged.body).mode, "file");
  });

  test("/api/checkout: 503 in sample mode, 405 for GET, 413 for a huge body", async () => {
    const post = await fetch(`${site.url}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "x", pickupTime: "asap", items: [], customer: {} }),
    });
    assert.equal(post.status, 503);
    assert.equal((await post.json()).code, "NOT_CONNECTED");

    const get = await fetch(`${site.url}/api/checkout`);
    assert.equal(get.status, 405);
    assert.equal((await get.json()).code, "METHOD_NOT_ALLOWED");

    const huge = await raw(site.url, "/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`,
    }).catch((error) => ({ status: error.code }));
    // The server answers 413 and closes; depending on timing the client sees the 413 or a reset.
    assert.ok([413, "ECONNRESET", "EPIPE"].includes(huge.status), String(huge.status));
  });

  test("an absolute or protocol-relative request target can't point the schedule fetch elsewhere", async () => {
    // A second local server plays another site. Without the fix the dev server fetched its
    // /data/schedule.json and served that schedule.
    const hits = [];
    const other = createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ timezone: "UTC", events: [{ id: "elsewhere", title: "Not our stop", start: "2026-10-14T00:00", end: "2099-01-01T00:00" }] }));
    });
    await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const elsewhere = `127.0.0.1:${other.address().port}`;
      for (const target of [`http://${elsewhere}/api/schedule`, `//${elsewhere}/api/schedule`]) {
        clearScheduleCache();
        const response = await raw(site.url, target);
        assert.equal(response.status, 200, target);
        const schedule = JSON.parse(response.body);
        assert.ok(schedule.events.every((event) => event.id !== "elsewhere"), target);
      }
      assert.deepEqual(hits, []);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  test("unknown API paths answer 404 JSON", async () => {
    const response = await fetch(`${site.url}/api/nothing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "There's no API at this address.", code: "NOT_FOUND" });
  });
});

describe("checkout through the dev server", () => {
  let site;
  const links = [];

  before(async () => {
    clearMenuCache();
    clearScheduleCache();
    // Square calls go to a stand-in; the schedule file is fetched from the dev server itself.
    const fetchImpl = async (url, init = {}) => {
      const target = new URL(String(url));
      if (target.hostname !== "connect.squareupsandbox.com") return fetch(url, init);
      const reply = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (target.pathname === "/v2/catalog/list") {
        return reply({
          objects: [{
            type: "ITEM", id: "IGB", present_at_all_locations: true,
            item_data: { name: "Golden Boot", variations: [{ type: "ITEM_VARIATION", id: "VGB", present_at_all_locations: true, item_variation_data: { name: "Regular", pricing_type: "FIXED_PRICING", price_money: { amount: 650, currency: "USD" } } }] },
          }],
        });
      }
      if (target.pathname === "/v2/online-checkout/payment-links") {
        links.push(JSON.parse(init.body));
        return reply({ payment_link: { id: "PL1", version: 1, order_id: "ORDER1", url: "https://sandbox.square.link/u/xyz" } });
      }
      throw new TypeError(`fetch failed: ${target.href}`);
    };
    site = await startDevServer({
      port: 0,
      host: "127.0.0.1",
      env: { SQUARE_ACCESS_TOKEN: "test-token", SQUARE_LOCATION_ID: "LOC1" },
      handlerOptions: { fetchImpl, now: new Date("2026-10-24T14:00:00Z") },
    });
  });

  after(async () => {
    await site?.close();
    clearMenuCache();
    clearScheduleCache();
  });

  test("a posted order reaches Square and the checkout URL comes back", async () => {
    const response = await fetch(`${site.url}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: "sample-2026-10-24-riverside-soccer",
        pickupTime: "asap",
        items: [{ variationId: "VGB", quantity: 2 }],
        customer: { name: "Sam Lee", phone: "312-248-0123" },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { checkoutUrl: "https://sandbox.square.link/u/xyz", orderId: "ORDER1" });
    assert.equal(links.length, 1);
    assert.deepEqual(links[0].order.line_items, [{ catalog_object_id: "VGB", quantity: "2" }]);
    // No SITE_URL: the return link uses the address the page was loaded from.
    assert.equal(links[0].checkout_options.redirect_url, `${site.url}/?order=placed`);
  });

  test("a request target naming another host doesn't change the return link", async () => {
    const before = links.length;
    const response = await raw(site.url, "http://attacker.invalid/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: "sample-2026-10-24-riverside-soccer",
        pickupTime: "asap",
        items: [{ variationId: "VGB", quantity: 1 }],
        customer: { name: "Sam Lee", phone: "312-248-0123" },
      }),
    });
    assert.equal(response.status, 200, response.body);
    assert.equal(links.length, before + 1);
    assert.equal(links.at(-1).checkout_options.redirect_url, `${site.url}/?order=placed`);
  });
});

describe(".env loading", () => {
  test("parses KEY=VALUE lines", () => {
    const parsed = parseEnvFile([
      "# comment",
      "",
      "SQUARE_ACCESS_TOKEN=EAAA-abc=def",
      "export SQUARE_ENVIRONMENT = sandbox  # inline comment",
      'SITE_URL="http://localhost:8888"',
      "CALENDAR_KEYWORD='[stand] #1'",
      'MULTI="a\\nb \\"q\\""',
      "EMPTY=",
      "not a line",
      "1BAD=x",
    ].join("\r\n"));
    assert.deepEqual(parsed, {
      SQUARE_ACCESS_TOKEN: "EAAA-abc=def",
      SQUARE_ENVIRONMENT: "sandbox",
      SITE_URL: "http://localhost:8888",
      CALENDAR_KEYWORD: "[stand] #1",
      MULTI: 'a\nb "q"',
      EMPTY: "",
    });
  });

  test("never replaces a variable that is already set, and tolerates a missing file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mf-env-"));
    try {
      const file = path.join(dir, ".env");
      await writeFile(file, "SQUARE_LOCATION_ID=FROM_FILE\nPORT=9999\nSITE_URL=http://file\n");
      const env = { PORT: "8888", SITE_URL: "" };
      assert.deepEqual(await loadEnvFile(file, env), ["SQUARE_LOCATION_ID"]);
      assert.deepEqual(env, { PORT: "8888", SITE_URL: "", SQUARE_LOCATION_ID: "FROM_FILE" });
      assert.deepEqual(await loadEnvFile(path.join(dir, "missing.env"), env), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
