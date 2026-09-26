const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("../app");
const contract = require("../api/openapi.json");
const { createContractValidator } = require("../scripts/api-contract-support");

const id = "12345678-1234-4123-8123-123456789abc";
const now = "2026-09-25T00:00:00.000Z";
const source = { kind: "note", label: "Synthetic evidence", captured_at: now };
const project = { id, name: "Contract", objective: "Verify API compatibility", constraints: [], source,
  status: "active", created_at: now, updated_at: now };
const entry = { id, project_id: id, kind: "action", content: "Verify shapes", status: "todo",
  verification: "confirmed", source, owner_ref: null, occurred_at: now, created_at: now, supersedes_id: null };
const page = (key, records) => ({ [key]: records, limit: 50, offset: 0, has_more: false, next_offset: null });
const brief = { project, generated_at: now, mode: "recorded_context", verification_basis: "caller_asserted",
  sections: Object.fromEntries(["confirmed_facts", "decisions", "blockers", "next_actions", "unverified", "disputed", "closed"]
    .map(key => [key, { entries: key === "next_actions" ? [entry] : [], total: key === "next_actions" ? 1 : 0, truncated: false }])) };
const { source: omittedSource, supersedes_id: omittedPrior, ...preview } = entry;
const summary = { ...project, open_actions: 1, open_blockers: 0, unverified_entries: 0,
  attention: [{ ...preview, content_truncated: false }] };

async function fixture(t, overrides = {}) {
  const calls = [], logs = [];
  const outputs = { createProject: project, listProjects: page("projects", [summary]), getProject: project,
    getProjectBrief: brief, createProjectEntry: entry, listProjectEntries: page("entries", [{ ...entry, is_current: true }]) };
  const database = Object.fromEntries(Object.entries(outputs).map(([operation, value]) => [operation, async (...args) => {
    calls.push({ operation, args }); return value;
  }]));
  const server = createServer({ database: { ...database, ...overrides }, log: (...args) => logs.push(args) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, options = {}) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(3000), ...options });
    return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
  }
  return { calls, logs, request };
}

test("v1 operations preserve legacy success payloads and query boundaries", async t => {
  const f = await fixture(t);
  const validate = createContractValidator();
  for (const [method, path, route, body] of [
    ["GET", "/projects", "/projects?limit=2&offset=3"],
    ["POST", "/projects", "/projects", { name: "Contract", objective: "Check compatibility", source }],
    ["GET", "/projects/{id}", `/projects/${id}`],
    ["GET", "/projects/{id}/brief", `/projects/${id}/brief`],
    ["GET", "/projects/{id}/entries", `/projects/${id}/entries?limit=2&offset=3`],
    ["POST", "/projects/{id}/entries", `/projects/${id}/entries`, { kind: "action", content: "Check", source, occurred_at: now }],
  ]) {
    const options = { method, body: body && JSON.stringify(body) };
    const legacy = await f.request(route, options);
    const current = await f.request("/api/v1" + route, options);
    assert.equal(current.status, method === "POST" ? 201 : 200);
    assert.deepEqual(current.body, legacy.body);
    assert.deepEqual(f.calls.at(-1), f.calls.at(-2));
    assert.equal(legacy.headers["x-api-version"], undefined);
    validate.response({ method, path, ...current });
  }
});

test("v1 errors use stable codes and retain private log boundaries", async t => {
  const f = await fixture(t, {
    createProjectEntry: async () => ({ error: "conflict" }),
    getProject: async () => null,
    getProjectBrief: async () => { throw new Error("PRIVATE credentials"); },
  });
  const cases = [
    ["/projects?limit=0", {}, 400, "validation_error"],
    ["/projects", { method: "POST", body: "{" }, 400, "validation_error"],
    ["/projects", { method: "POST", body: "{}", headers: { origin: "https://external.example" } }, 403, "cross_origin_denied"],
    [`/projects/${id}`, {}, 404, "not_found"],
    [`/projects/${id}/entries`, { method: "POST", body: JSON.stringify({ kind: "action", content: "PRIVATE", source }) }, 409, "revision_conflict"],
    ["/projects", { method: "POST", body: JSON.stringify({ name: "x".repeat(17000) }) }, 413, "payload_too_large"],
    [`/projects/${id}/brief`, {}, 503, "service_unavailable"],
  ];
  const validate = createContractValidator();
  for (const [route, options, status, code] of cases) {
    const current = await f.request("/api/v1" + route, { ...options, headers: { ...options.headers, "x-request-id": "v1-contract" } });
    const legacy = await f.request(route, options);
    assert.equal(current.status, status);
    assert.equal(current.body.code, code);
    assert.equal(current.body.request_id, "v1-contract");
    assert.deepEqual(legacy.body, { error: current.body.error });
    validate.schema("Error", current.body);
    assert.equal(current.headers["cache-control"], "no-store");
  }
  assert.ok(!JSON.stringify(f.logs).includes(id));
  assert.ok(!JSON.stringify(f.logs).includes("PRIVATE"));
  assert.ok(f.logs.some(log => log[2].route === "/api/v1/projects/:id/entries"));
});

test("unknown API versions and methods do not alias unrelated routes or write data", async t => {
  const f = await fixture(t);
  for (const route of ["/api/v2/projects", "/api/v10/projects", "/api/v1/links", "/api/v1/health",
    "/api/v1/projects/not-a-uuid", "/api/v1/projects/", "/api/v1/projects/extra", "/api/v1/.env"]) {
    assert.equal((await f.request(route, { method: "POST", body: "{}" })).status, 404);
  }
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal((await f.request("/api/v1/projects", { method })).status, 404);
  }
  assert.equal(f.calls.length, 0);
});

test("served OpenAPI is self-contained and accurately exposes the local-only boundary", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/v1/openapi.json");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, contract);
  assert.equal(response.headers["x-api-version"], "1");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(contract.security, [{ cookieAuth: [] }]);
  assert.deepEqual(contract.servers.map(server => server.url), ["/api/v1"]);
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith("#/components/"));
      assert.ok(value.$ref.slice(2).split("/").reduce((node, key) => node?.[key], contract));
    }
    Object.values(value).forEach(walk);
  }
  walk(contract);
  const operations = Object.values(contract.paths).flatMap(path => [path.get, path.post].filter(Boolean));
  assert.equal(new Set(operations.map(operation => operation.operationId)).size, 10);
  assert.deepEqual(contract.paths["/auth/login"].post.security, []);
  assert.deepEqual(contract.paths["/auth/activate"].post.security, []);
});

test("contract validates input variants, nullability, bounds and kind-specific statuses", () => {
  const validate = createContractValidator();
  validate.schema("ProjectInput", { name: "Example", objective: "Work", source });
  validate.schema("SourceInput", { kind: "url", label: "Evidence", locator: "https://example.com" });
  for (const [kind, statuses] of Object.entries({ progress: ["recorded"], decision: ["recorded"], blocker: ["open", "resolved"], action: ["todo", "doing", "done", "cancelled"] })) {
    for (const status of statuses) validate.schema("EntryInput", { kind, status, content: "Work", source });
    validate.schema("EntryInput", { kind, content: "Work", source, owner_ref: null, occurred_at: null, supersedes_id: null });
  }
  for (const input of [{ ...entry, status: "open" }, { kind: "action", status: "recorded", content: "Work", source },
    { kind: "decision", status: "done", content: "Work", source }, { kind: "progress", content: "x".repeat(4001), source },
    { kind: "progress", content: "Work", source, unexpected: true }]) {
    assert.throws(() => validate.schema("EntryInput", input));
  }
  assert.throws(() => validate.schema("SourceInput", { kind: "url", label: "Missing locator" }));
  assert.throws(() => validate.schema("ProjectPage", { projects: [] }));
  assert.throws(() => validate.schema("Entry", { ...entry, owner_ref: 42 }));
  validate.schema("Project", { ...project, future_field: "Clients ignore new response fields" });
  validate.schema("Timestamp", "2026-09-25T00:00:00+00:00");
});
