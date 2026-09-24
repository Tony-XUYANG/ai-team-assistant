const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";

test("deployed service propagates a valid request ID", async () => {
  const id = `acceptance-${randomUUID()}`;
  const response = await fetch(baseUrl + "/version", {
    headers: { "x-request-id": id }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), id);
  await response.text();
});

test("deployed service replaces unsafe IDs even on client errors", async () => {
  const response = await fetch(baseUrl + "/links", {
    method: "POST", headers: { "x-request-id": "bad id" }, body: "{",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
  await response.text();
});
