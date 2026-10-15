import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readConfig, resetConfigWarnings } from "../config.mjs";

let warnings;
beforeEach((t) => {
  resetConfigWarnings();
  warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
});

describe("readConfig", () => {
  test("defaults when nothing is set", () => {
    const config = readConfig({});
    assert.equal(config.squareConfigured, false);
    assert.equal(config.squareEnvironment, "sandbox");
    assert.equal(config.squareBaseUrl, "https://connect.squareupsandbox.com");
    assert.equal(config.squareVersion, "2026-08-19");
    assert.equal(config.siteUrl, "");
    assert.equal(config.businessTimezone, "America/New_York");
    assert.equal(config.orderCutoffMinutes, 15);
    assert.deepEqual(warnings, []);
  });

  test("cleans pasted values", () => {
    const config = readConfig({
      SQUARE_ACCESS_TOKEN: ' "Bearer EAAAl-token" ',
      SQUARE_LOCATION_ID: " L1 ",
      SQUARE_ENVIRONMENT: "Production",
      SITE_URL: "https://user:pw@shop.example/menu/?q=1#top",
      ORDER_CUTOFF_MINUTES: " 30 ",
    });
    assert.equal(config.squareAccessToken, "EAAAl-token");
    assert.equal(config.squareLocationId, "L1");
    assert.equal(config.squareConfigured, true);
    assert.equal(config.squareBaseUrl, "https://connect.squareup.com");
    assert.equal(config.siteUrl, "https://shop.example/menu"); // no credentials, query, or fragment
    assert.equal(config.orderCutoffMinutes, 30);
  });

  test("bad values fall back to defaults with one warning each", () => {
    const env = { SITE_URL: "javascript:alert(1)", BUSINESS_TIMEZONE: "Mars/Base", ORDER_CUTOFF_MINUTES: "-5", SQUARE_ENVIRONMENT: "live" };
    for (let i = 0; i < 2; i++) {
      const config = readConfig(env);
      assert.deepEqual([config.siteUrl, config.businessTimezone, config.orderCutoffMinutes, config.squareEnvironment], ["", "America/New_York", 15, "sandbox"]);
    }
    assert.equal(warnings.length, 4);
    assert.ok(warnings.some((w) => w.includes('not "live"')));
  });

  test("a token pasted into SQUARE_ENVIRONMENT isn't copied into the log", () => {
    const token = "EAAAl-very-secret-token-value-0123456789abcdef";
    readConfig({ SQUARE_ENVIRONMENT: token });
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].toLowerCase().includes(token.slice(0, 12).toLowerCase()), warnings[0]);
  });
});
