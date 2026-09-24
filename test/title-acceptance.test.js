const test = require("node:test");
const assert = require("node:assert/strict");
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const request = (route, options = {}) => fetch(base + route, { redirect: "manual", signal: AbortSignal.timeout(5000), ...options });

test("title API persists title and keeps legacy redirect behavior", async () => {
  const created = await request("/links", { method: "POST", body: JSON.stringify({
    url: "https://example.com/title-check?quote=it's-working", title: "  Shipping 'titles' \u{1f680}  ",
  }) });
  assert.equal(created.status, 201);
  const row = await created.json();
  assert.equal(row.title, "Shipping 'titles' \u{1f680}");
  const read = await request("/links/" + row.code);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(await read.json(), row);
  const redirect = await request(row.short_path);
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), row.url);
  await redirect.text();
});

test("title API supports old payloads and validates character boundaries", async () => {
  for (const title of [undefined, null, "\u{1f680}".repeat(120)]) {
    const created = await request("/links", { method: "POST", body: JSON.stringify({ url: "https://example.com", title }) });
    assert.equal(created.status, 201);
    const row = await created.json();
    assert.equal(row.title, title ?? null);
    const read = await request("/links/" + row.code);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).title, title ?? null);
  }
  for (const title of ["", " ", 12, "\u{1f680}".repeat(121), "bad\u0000title"]) {
    const response = await request("/links", { method: "POST", body: JSON.stringify({ url: "https://example.com", title }) });
    assert.equal(response.status, 400);
    await response.text();
  }
});
