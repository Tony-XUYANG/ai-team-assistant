const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("../app");

async function fixture(t, overrides = {}) {
  const rows = new Map();
  const logs = [];
  let writes = 0;
  const database = {
    checkHealth: async () => {},
    createLink: async (url, title) => {
      writes++;
      const row = { code: writes.toString(16).padStart(8, "0"), url, title };
      rows.set(row.code, row);
      return row;
    },
    getLink: async code => rows.get(code),
    findLink: async code => rows.get(code)?.url,
    ...overrides,
  };
  const server = createServer({ database, log: (...args) => logs.push(args) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { logs, rows, writes: () => writes,
    request: (route, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      redirect: "manual", signal: AbortSignal.timeout(3000), ...options,
    }),
  };
}

test("title defaults to null and valid titles round-trip without changing redirects", async t => {
  const f = await fixture(t);
  for (const title of [undefined, null, "  A title with 'quotes'  ", "\u{1f680}".repeat(120)]) {
    const response = await f.request("/links", { method: "POST", body: JSON.stringify({ url: "https://example.com/", title }) });
    assert.equal(response.status, 201);
    const row = await response.json();
    assert.equal(row.title, title == null ? null : title.trim());
    const read = await f.request("/links/" + row.code);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.deepEqual(await read.json(), row);
    const redirect = await f.request(row.short_path);
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), row.url);
    await redirect.text();
  }
});

test("invalid titles fail before database writes, including controls and malformed Unicode", async t => {
  const f = await fixture(t);
  for (const title of ["", "   ", 123, {}, [], true, "x".repeat(121), "\u{1f680}".repeat(121),
    "with\nnewline", "with\u0000nul", "\ud800"]) {
    const response = await f.request("/links", { method: "POST", body: JSON.stringify({ url: "https://example.com", title }) });
    assert.equal(response.status, 400);
    await response.text();
  }
  assert.equal(f.writes(), 0);
});

test("metadata reads tolerate legacy null titles and normalize logs without title or code", async t => {
  const f = await fixture(t);
  f.rows.set("1234abcd", { code: "1234abcd", url: "https://example.com/private", title: null });
  const read = await f.request("/links/1234abcd?private=SECRET", { headers: { "x-request-id": "metadata-1" } });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).title, null);
  assert.equal(read.headers.get("x-request-id"), "metadata-1");
  assert.equal(f.logs[0][2].route, "/links/:code");
  assert.ok(!JSON.stringify(f.logs).includes("1234abcd"));
  const created = await f.request("/links", { method: "POST", body: JSON.stringify({ url: "https://example.com", title: "SECRET-TITLE" }) });
  await created.text();
  assert.ok(!JSON.stringify(f.logs).includes("SECRET"));
  const missing = await f.request("/links/ffffffff");
  assert.equal(missing.status, 404);
  await missing.text();
});

test("metadata database failures keep generic 503 and request correlation", async t => {
  const f = await fixture(t, { getLink: async () => { throw Object.assign(new Error("SECRET"), { code: "42703" }); } });
  const response = await f.request("/links/1234abcd", { headers: { "x-request-id": "metadata-failure" } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Service temporarily unavailable" });
  assert.equal(response.headers.get("x-request-id"), "metadata-failure");
  assert.equal(f.logs.find(item => item[1] === "request_failed")[2].errorCode, "42703");
});
