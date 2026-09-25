const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("../app");
const { createProjectStore } = require("../project-store");
const { projectMigration, applyProjectMigration } = require("../scripts/project-migration");
const { migrationChecksum } = require("../scripts/migration-support");

const id = "12345678-1234-4123-8123-123456789abc";
const source = { kind: "note", label: "Acceptance evidence" };
const project = { name: "Delivery", objective: "Ship a verified release", source };
const entry = { kind: "progress", content: "A recorded observation", source };

async function fixture(t, overrides = {}) {
  const calls = [];
  const logs = [];
  const database = Object.fromEntries(["createProject", "listProjects", "getProject", "getProjectBrief",
    "createProjectEntry", "listProjectEntries"].map(operation => [operation, async (...args) => {
    calls.push({ operation, args });
    return { id, ...(args.at(-1) || {}) };
  }]));
  const server = createServer({ database: { ...database, ...overrides }, log: (...args) => logs.push(args) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  async function request(route, body, method) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: method || (body === undefined ? "GET" : "POST"),
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000),
      headers: { "x-request-id": "project-test", "content-type": "application/json" },
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  return { request, calls, logs };
}

test("project creation normalizes text, preserves Unicode and requires source metadata", async t => {
  const f = await fixture(t);
  const response = await f.request("/projects", { ...project, name: "  \u9879\u76ee  ", constraints: [" JavaScript only "] });
  assert.equal(response.status, 201);
  assert.equal(response.data.name, "\u9879\u76ee");
  assert.deepEqual(response.data.constraints, ["JavaScript only"]);
  assert.equal(response.data.status, "active");
  assert.match(response.data.source.captured_at, /^\d{4}-/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("invalid project payloads are rejected without database writes", async t => {
  const f = await fixture(t);
  const invalid = [null, [], true, {}, { ...project, source: null }, { ...project, unexpected: true },
    { ...project, name: " " }, { ...project, objective: "x".repeat(2001) }, { ...project, name: "\ud800" },
    { ...project, name: "bad\nname" }, { ...project, status: "finished" }, { ...project, constraints: [null] },
    { ...project, constraints: Array(31).fill("rule") }, { ...project, source: { kind: "robot", label: "x" } },
    { ...project, source: { kind: "url", label: "x", locator: "file:///etc/passwd" } },
    { ...project, source: { kind: "url", label: "x", locator: "https://name:password@example.com" } },
    { ...project, source: { ...source, captured_at: "2026-02-30T00:00:00Z" } }];
  for (const body of invalid) assert.equal((await f.request("/projects", body)).status, 400);
  assert.equal(f.calls.length, 0);
});

test("entries default to unverified and recorded, while explicit statuses are bounded by kind", async t => {
  const f = await fixture(t);
  const result = await f.request(`/projects/${id}/entries`, entry);
  assert.equal(result.status, 201);
  assert.equal(result.data.verification, "unverified");
  assert.equal(result.data.status, "recorded");
  for (const change of [{ kind: "unknown" }, { verification: "guessed" }, { status: "done" },
    { supersedes_id: "other-project" }, { supersedes_id: {} }, { source: {} }, { source: null },
    { occurred_at: "tomorrow" }, { occurred_at: "2026-09-25" }, { occurred_at: "2026-13-01T00:00:00Z" },
    { content: "\ud800" }, { content: "x".repeat(4001) }, { kind: "action", status: "recorded" },
    { owner_ref: "x".repeat(121) }, { user_id: "invented-owner" }]) {
    assert.equal((await f.request(`/projects/${id}/entries`, { ...entry, ...change })).status, 400);
  }
  assert.equal(f.calls.length, 1);
  const revised = await f.request(`/projects/${id}/entries`, { ...entry, supersedes_id: id.toUpperCase(),
    occurred_at: "2026-09-25T00:00:00.123Z", verification: "confirmed" });
  assert.equal(revised.status, 201);
  assert.equal(revised.data.supersedes_id, id);
});

test("pagination is bounded and unknown methods cannot fall through to database writes", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/projects?limit=2&offset=3")).status, 200);
  assert.deepEqual(f.calls[0].args, [{ limit: 2, offset: 3 }]);
  for (const query of ["limit=0", "limit=101", "offset=-1", "limit=1&limit=2", "offset=1000001", "limit=x", "sql=SELECT"]) {
    assert.equal((await f.request("/projects?" + query)).status, 400);
  }
  assert.equal((await f.request(`/projects/${id}/brief`, {}, "POST")).status, 404);
  assert.equal((await f.request(`/projects/${id}`, {}, "DELETE")).status, 404);
  assert.equal((await f.request("/projects/not-a-uuid")).status, 404);
  assert.equal(f.calls.length, 1);
});

test("missing projects, revision conflicts and kind changes have controlled responses", async t => {
  const f = await fixture(t, { getProject: async () => null, getProjectBrief: async () => null,
    listProjectEntries: async () => null, createProjectEntry: async (projectId, input) =>
      input.content === "missing" ? null : { error: input.content } });
  for (const suffix of ["", "/brief", "/entries"]) {
    assert.equal((await f.request(`/projects/${id}${suffix}`)).status, 404);
  }
  for (const [content, status] of [["missing", 404], ["conflict", 409], ["kind_mismatch", 400]]) {
    assert.equal((await f.request(`/projects/${id}/entries`, { ...entry, content })).status, status);
  }
});

test("project logs omit content, identifiers and query strings; database errors stay generic", async t => {
  const f = await fixture(t, { getProjectBrief: async () => { throw Object.assign(new Error("PRIVATE connection"), { code: "42P01" }); } });
  const response = await f.request(`/projects/${id}/entries?note=PRIVATE`, { ...entry, content: "PRIVATE" });
  assert.equal(response.status, 201);
  const failed = await f.request(`/projects/${id}/brief`);
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.data, { error: "Service temporarily unavailable" });
  assert.equal(failed.headers.get("x-request-id"), "project-test");
  assert.ok(!JSON.stringify(f.logs).includes(id));
  assert.ok(!JSON.stringify(f.logs).includes("PRIVATE"));
  assert.equal(f.logs[0][2].route, "/projects/:id/entries");
});

test("entry transaction releases its client and rolls back on insertion failure", async () => {
  for (const fails of [false, true]) {
    const calls = [];
    let released = false;
    const store = createProjectStore({ connect: async () => ({ release: () => { released = true; },
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        if (sql.startsWith("SELECT id FROM public.projects")) return { rowCount: 1, rows: [{ id }] };
        if (sql.startsWith("INSERT")) {
          if (fails) throw Object.assign(new Error("write failed"), { code: "53200" });
          return { rows: [{ id, source }] };
        }
        return { rowCount: 0, rows: [] };
      } }) });
    const operation = store.createProjectEntry(id, { ...entry, status: "recorded", verification: "unverified" });
    if (fails) await assert.rejects(operation, { code: "53200" });
    else assert.equal((await operation).id, id);
    assert.equal(calls[0].sql, "BEGIN");
    assert.equal(calls.at(-1).sql, fails ? "ROLLBACK" : "COMMIT");
    assert.ok(released);
    const insert = calls.find(c => c.sql.startsWith("INSERT"));
    assert.ok(!insert.sql.includes(entry.content));
    assert.equal(insert.parameters[3], entry.content);
  }
});

function migrationClient({ checksum, failSql, missingConstraints = false } = {}) {
  const calls = [];
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql === failSql) throw Object.assign(new Error("DDL failure"), { code: "TEST_FAILURE" });
    if (sql.includes("pg_try_advisory")) return { rows: [{ acquired: true }] };
    if (sql.startsWith("SELECT checksum")) return { rows: checksum ? [{ checksum }] : [] };
    if (sql.startsWith("INSERT INTO public.lab_schema_migrations")) checksum = migrationChecksum(projectMigration);
    if (sql.includes("FROM pg_constraint")) return { rows: missingConstraints ? [] : [
      { conname: "entry_project_revision", contype: "f", convalidated: true },
      { conname: "entry_status", contype: "c", convalidated: true },
      { conname: "project_entries_supersedes_id_key", contype: "u", convalidated: true },
    ] };
    return { rows: [] };
  } };
}

test("project migration is repeatable, checksum-verified and transactional", async () => {
  const client = migrationClient();
  assert.equal((await applyProjectMigration(client)).status, "applied");
  const repeat = migrationClient({ checksum: migrationChecksum(projectMigration) });
  assert.equal((await applyProjectMigration(repeat)).status, "already_applied");
  assert.ok(!repeat.calls.includes(projectMigration.statements[0]));
  for (const options of [{ checksum: "0".repeat(64) }, { missingConstraints: true }, { failSql: projectMigration.statements[1] }]) {
    const failed = migrationClient(options);
    await assert.rejects(applyProjectMigration(failed));
    assert.equal(failed.calls.at(-1), "ROLLBACK");
    assert.ok(!failed.calls.includes("COMMIT"));
  }
});
