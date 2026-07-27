import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Kept outside Vitest's *.test.* glob; this suite runs in Node to inspect config.
const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
);

test("production policy values are locked to the approved limits", () => {
  const vars = config.env.production.vars;
  assert.equal(vars.SESSION_IDLE_SECONDS, "86400");
  assert.equal(vars.SESSION_ABSOLUTE_SECONDS, "604800");
  assert.equal(vars.SESSION_MAX_CALLS, "200");
  assert.equal(vars.DAILY_MAX_CALLS, "600");
  assert.equal(vars.IP_DAILY_MAX_CALLS, "150");
  assert.equal(vars.IP_MINUTE_MAX_CALLS, "30");
});

test("production and development origins are separated", () => {
  assert.equal(config.env.production.name, "pet-ocr-gemini-proxy");
  assert.equal(
    config.env.production.vars.ALLOWED_ORIGINS,
    "https://kenkenno1.github.io"
  );
  assert.doesNotMatch(
    config.env.production.vars.ALLOWED_ORIGINS,
    /localhost|127\.0\.0\.1/u
  );
  assert.match(config.vars.ALLOWED_ORIGINS, /localhost/u);
});

test("request cancellation and SQLite Durable Object migration are declared", () => {
  assert.ok(config.compatibility_flags.includes("enable_request_signal"));
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ["UsageGate"]);
});
