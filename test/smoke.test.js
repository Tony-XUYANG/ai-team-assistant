const test = require("node:test");
const assert = require("node:assert/strict");

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";

function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    ...options,
  });
}

test("health checks the database connection", async () => {
  const response = await request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", database: "ok" });
});

test("liveness endpoint returns a successful response", async () => {
  const response = await request("/live");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("creates and retrieves a link containing quotes and query parameters", async () => {
  const target = "https://example.com/lesson?topic=docker&note=it's-working";
  const response = await request("/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: target }),
  });
  assert.equal(response.status, 201);
  const link = await response.json();
  assert.match(link.code, /^[a-f0-9]{8}$/);
  const redirect = await request(link.short_path);
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), new URL(target).toString());
});

test("rejects malformed JSON and unsupported URLs", async () => {
  for (const body of ["{", "null", "{}", '{"url":"not-a-url"}', '{"url":"javascript:alert(1)"}']) {
    const response = await request("/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(response.status, 400, body);
    await response.text();
  }
});

test("rejects oversized requests without crashing", async () => {
  const response = await request("/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `https://example.com/${"a".repeat(20000)}` }),
  });
  assert.equal(response.status, 413);
  await response.text();
  const health = await request("/health");
  assert.equal(health.status, 200);
  await health.text();
});

test("missing routes return 404", async () => {
  const response = await request("/not-a-short-code");
  assert.equal(response.status, 404);
  await response.text();
});
