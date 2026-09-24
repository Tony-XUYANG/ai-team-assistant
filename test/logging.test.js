const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("../app");
const { createLogger, requestId, safeErrorCode } = require("../logger");
const { version } = require("../package.json");

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function fixture(t, overrides = {}) {
  const lines = [];
  const database = {
    checkHealth: async () => {},
    createLink: async url => ({ code: "1234abcd", url }),
    findLink: async () => "https://example.com/private?token=SECRET",
    ...overrides,
  };
  const server = createServer({ database, log: createLogger(line => lines.push(line)) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return {
    lines, logs: () => lines.map(JSON.parse),
    request: (route, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      redirect: "manual", signal: AbortSignal.timeout(3000), ...options,
    }),
  };
}

test("request IDs reject oversized, duplicate, and unsafe values", () => {
  for (const value of [undefined, "", "x".repeat(65), "x\ny", "bad id", "one,two", ["one", "two"]]) {
    assert.match(requestId(value), uuid);
  }
  assert.equal(requestId("incident-20260924:request_1"), "incident-20260924:request_1");
  assert.notEqual(requestId(), requestId());
});

test("logger permits selected fields and never serializes raw errors", () => {
  const lines = [];
  createLogger(line => lines.push(line))("error", "test_failure", {
    requestId: "test-1", status: 503, errorCode: "ECONNREFUSED",
    password: "SECRET", body: { url: "SECRET" }, error: new Error("SECRET"),
    headers: { authorization: "SECRET" }, message: "SECRET",
  });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith("\n"));
  assert.ok(!lines[0].includes("SECRET"));
  const record = JSON.parse(lines[0]);
  assert.equal(record.version, version);
  assert.ok(record.hostname);
  assert.ok(Number.isFinite(Date.parse(record.timestamp)));
  assert.equal(safeErrorCode({ code: "ECONNREFUSED", message: "SECRET" }), "ECONNREFUSED");
  assert.equal(safeErrorCode({ code: "SECRET" }), "UNCLASSIFIED");
  assert.equal(safeErrorCode(new Error("SECRET")), "UNCLASSIFIED");
});

test("successful request returns and logs the same supplied request ID", async t => {
  const f = await fixture(t);
  const response = await f.request("/links?secret=SECRET", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "create-1", authorization: "Bearer SECRET", cookie: "session=SECRET" },
    body: JSON.stringify({ url: "https://example.com/private?token=SECRET" }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-request-id"), "create-1");
  assert.equal((await response.json()).code, "1234abcd");
  const [record] = f.logs();
  assert.equal(f.logs().length, 1);
  assert.equal(record.requestId, "create-1");
  assert.equal(record.event, "request_completed");
  assert.equal(record.route, "/links");
  assert.equal(record.status, 201);
  assert.ok(record.durationMs >= 0);
  assert.ok(!f.lines.join("").includes("SECRET"));
});

test("missing or unsafe HTTP request IDs are replaced with fresh UUIDs", async t => {
  const f = await fixture(t);
  const seen = new Set();
  for (const value of [undefined, "bad id", "x".repeat(65)]) {
    const response = await f.request("/version", { headers: value ? { "x-request-id": value } : {} });
    await response.text();
    const id = response.headers.get("x-request-id");
    assert.match(id, uuid);
    seen.add(id);
  }
  assert.equal(seen.size, 3);
  assert.equal(f.logs().length, 3);
});

test("concurrent database failures retain separate request correlations", async t => {
  const fail = async () => { throw Object.assign(new Error("password=SECRET"), { code: "ECONNREFUSED" }); };
  const f = await fixture(t, { createLink: fail });
  await Promise.all(["failure-a", "failure-b"].map(async id => {
    const response = await f.request("/links", {
      method: "POST", headers: { "x-request-id": id },
      body: JSON.stringify({ url: "https://example.com/SECRET" }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-request-id"), id);
    assert.deepEqual(await response.json(), { error: "Service temporarily unavailable" });
  }));
  for (const id of ["failure-a", "failure-b"]) {
    const records = f.logs().filter(record => record.requestId === id);
    assert.equal(records.length, 2);
    const failure = records.find(record => record.event === "request_failed");
    assert.equal(failure.errorCode, "ECONNREFUSED");
    assert.equal(failure.dependency, "postgresql");
    assert.equal(failure.operation, "createLink");
    assert.equal(records.find(record => record.event === "request_completed").status, 503);
  }
  assert.ok(!f.lines.join("").includes("SECRET"));
});

test("successful probes are quiet but failing readiness is logged", async t => {
  let unhealthy = false;
  const f = await fixture(t, { checkHealth: async () => { if (unhealthy) throw new Error("SECRET"); } });
  for (const route of ["/live", "/health"]) {
    const response = await f.request(route);
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(f.logs().length, 0);
  unhealthy = true;
  const health = await f.request("/health");
  assert.equal(health.status, 503);
  await health.text();
  const live = await f.request("/live");
  assert.equal(live.status, 200);
  await live.text();
  assert.equal(f.logs().length, 2);
  assert.ok(f.logs().every(record => record.requestId === health.headers.get("x-request-id")));
  assert.equal(f.logs()[0].errorCode, "UNCLASSIFIED");
  assert.ok(!f.lines.join("").includes("SECRET"));
});

test("redirects and missing routes use normalized paths without user data", async t => {
  const f = await fixture(t);
  const redirect = await f.request("/1234abcd?secret=SECRET");
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), "https://example.com/private?token=SECRET");
  await redirect.text();
  const missing = await f.request("/SECRET?token=SECRET");
  assert.equal(missing.status, 404);
  await missing.text();
  assert.deepEqual(f.logs().map(record => record.route), ["/:code", "unmatched"]);
  assert.ok(!f.lines.join("").includes("SECRET"));
  assert.ok(!f.lines.join("").includes("1234abcd"));
});

test("invalid JSON and oversized bodies retain client-error behavior", async t => {
  const f = await fixture(t);
  for (const [body, status] of [["{SECRET", 400], [JSON.stringify({ url: "SECRET".repeat(4000) }), 413]]) {
    const response = await f.request("/links", { method: "POST", body });
    assert.equal(response.status, status);
    await response.text();
  }
  assert.deepEqual(f.logs().map(record => record.status), [400, 413]);
  assert.ok(f.logs().every(record => record.level === "warn"));
  assert.ok(!f.lines.join("").includes("SECRET"));
});
