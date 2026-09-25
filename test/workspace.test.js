const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("../app");

async function fixture(t) {
  let writes = 0;
  const server = createServer({ database: { async createProject(input) { writes++; return input; } }, log() {} });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, writes: () => writes, request: (route, options = {}) => fetch(base + route, { signal: AbortSignal.timeout(3000), ...options }) };
}

test("workspace serves only explicitly permitted assets with security headers", async t => {
  const f = await fixture(t);
  for (const [route, type] of [["/", "text/html"], ["/index.html", "text/html"], ["/styles.css", "text/css"],
    ["/workspace.js", "text/javascript"], ["/vendor/lucide.min.js", "text/javascript"]]) {
    const response = await f.request(route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith(type));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.ok(response.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
    assert.ok((await response.text()).length > 100);
    const head = await f.request(route, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }
  for (const route of ["/.env", "/package.json", "/vendor/../package.json", "/public/index.html", "/%2e%2e/.env", "/workspace.js.map"]) {
    const response = await f.request(route);
    assert.equal(response.status, 404);
    await response.text();
  }
});

test("browser cross-origin writes are rejected before reading or writing data", async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ name: "Valid", objective: "first\nsecond", source: { kind: "note", label: "Test" } });
  for (const headers of [{ origin: "https://external.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" },
    { origin: f.base, "sec-fetch-site": "cross-site" }]) {
    const r = await f.request("/projects", { method: "POST", headers, body });
    assert.equal(r.status, 403);
    await r.text();
  }
  assert.equal(f.writes(), 0);
  for (const headers of [{}, { origin: f.base, "sec-fetch-site": "same-origin" }]) {
    const r = await f.request("/projects", { method: "POST", headers, body });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).objective, "first\nsecond");
  }
  assert.equal(f.writes(), 2);
});

test("multiline objectives normalize CRLF and still reject control characters", async t => {
  const f = await fixture(t);
  const base = { name: "Project", source: { kind: "note", label: "Test" } };
  const accepted = await f.request("/projects", { method: "POST", body: JSON.stringify({ ...base, objective: "first\r\nsecond\titem" }) });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).objective, "first\nsecond\titem");
  for (const input of [{ objective: "bad\u0000content" }, { objective: "ok", name: "bad\nname" }]) {
    const r = await f.request("/projects", { method: "POST", body: JSON.stringify({ ...base, ...input }) });
    assert.equal(r.status, 400); await r.text();
  }
});
