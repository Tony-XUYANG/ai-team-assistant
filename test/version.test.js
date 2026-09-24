const test = require("node:test");
const assert = require("node:assert/strict");
const { version } = require("../package.json");

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";

test("reports the deployed version and instance without caching", async () => {
  const response = await fetch(`${baseUrl}/version`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.version, process.env.EXPECTED_VERSION || version);
  assert.equal(typeof body.hostname, "string");
  assert.ok(body.hostname.length > 0);
});
