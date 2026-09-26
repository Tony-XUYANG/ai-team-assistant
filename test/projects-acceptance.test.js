const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createAuthSession } = require("./auth-fixture");
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const source = { kind: "note", label: "Automated acceptance; synthetic data" };
let auth;
test.before(async () => { auth = await createAuthSession(base); });
async function request(route, body) {
  return auth.request(route, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function create() {
  const response = await request("/projects", { name: "Acceptance " + randomUUID(), objective: "Verify recorded context",
    constraints: ["No real credentials", "JavaScript only"], source });
  assert.equal(response.status, 201);
  return response.data;
}
async function add(project, changes = {}) {
  return request(`/projects/${project.id}/entries`, { kind: "progress", content: "Sample evidence", source, ...changes });
}

test("projects persist objectives, constraints and sources and paginate results", async () => {
  const project = await create();
  const read = await request(`/projects/${project.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.data, project);
  const list = await request("/projects?limit=1");
  assert.equal(list.status, 200);
  assert.equal(list.data.projects.length, 1);
  assert.equal(list.data.projects[0].id, project.id);
  assert.equal(list.data.projects[0].open_actions, 0);
  assert.equal(list.data.projects[0].unverified_entries, 0);
  assert.deepEqual(list.data.projects[0].attention, []);
  assert.ok(project.source.captured_at);
});

test("brief separates caller-confirmed facts, disputed claims, decisions and next actions", async () => {
  const project = await create();
  for (const input of [{ content: "Not checked" }, { verification: "confirmed", content: "Checked" },
    { verification: "disputed", content: "Disputed" }, { kind: "decision", verification: "confirmed" },
    { kind: "blocker", verification: "confirmed" }, { kind: "action", verification: "confirmed", owner_ref: "Delivery lead" }]) {
    assert.equal((await add(project, input)).status, 201);
  }
  const brief = await request(`/projects/${project.id}/brief`);
  assert.equal(brief.status, 200);
  assert.equal(brief.data.mode, "recorded_context");
  assert.equal(brief.data.verification_basis, "caller_asserted");
  for (const key of ["confirmed_facts", "unverified", "disputed", "decisions", "blockers", "next_actions"]) {
    assert.equal(brief.data.sections[key].total, 1);
    assert.equal(brief.data.sections[key].entries[0].project_id, project.id);
    assert.ok(brief.data.sections[key].entries[0].source.captured_at);
  }
  assert.equal(brief.data.sections.confirmed_facts.entries[0].content, "Checked");
  const overview = (await request("/projects?limit=100")).data.projects.find(item => item.id === project.id);
  assert.deepEqual(overview.attention.map(item => item.kind), ["blocker", "action", "progress"]);
  assert.equal(overview.attention[2].content, "Not checked");
});

test("revisions close actions and blockers without deleting history or retaining stale facts", async () => {
  const project = await create();
  for (const [kind, status] of [["action", "done"], ["blocker", "resolved"], ["progress", "recorded"]]) {
    const before = (await add(project, { kind, verification: "confirmed" })).data;
    const revision = await add(project, { kind, status, supersedes_id: before.id,
      verification: kind === "progress" ? "disputed" : "confirmed", content: "Updated with evidence" });
    assert.equal(revision.status, 201);
  }
  const brief = (await request(`/projects/${project.id}/brief`)).data;
  assert.equal(brief.sections.next_actions.total, 0);
  assert.equal(brief.sections.blockers.total, 0);
  assert.equal(brief.sections.confirmed_facts.total, 0);
  assert.equal(brief.sections.closed.total, 2);
  assert.equal(brief.sections.disputed.total, 1);
  const history = (await request(`/projects/${project.id}/entries?limit=2`)).data;
  assert.equal(history.entries.length, 2);
  assert.equal(history.has_more, true);
  assert.equal(history.next_offset, 2);
  const all = (await request(`/projects/${project.id}/entries?limit=100`)).data.entries;
  assert.equal(all.length, 6);
  assert.equal(all.filter(e => e.is_current).length, 3);
  const list = (await request("/projects?limit=1")).data.projects[0];
  assert.equal(list.open_actions, 0);
  assert.equal(list.open_blockers, 0);
  assert.equal(list.unverified_entries, 0);
});

test("projects cannot reference each other's records and missing predecessors return 404", async () => {
  const one = await create();
  const two = await create();
  const prior = (await add(one, { content: "Only project one" })).data;
  for (const supersedes_id of [prior.id, randomUUID()]) {
    assert.equal((await add(two, { supersedes_id })).status, 404);
  }
  const brief = (await request(`/projects/${two.id}/brief`)).data;
  assert.ok(!JSON.stringify(brief).includes("Only project one"));
  assert.equal((await add({ id: randomUUID() })).status, 404);
  assert.equal((await request(`/projects/${randomUUID()}/brief`)).status, 404);
  assert.equal((await request(`/projects/${randomUUID()}/entries`)).status, 404);
});

test("concurrent revisions have one winner and cannot change entry kind", async () => {
  const project = await create();
  const prior = (await add(project, { kind: "action" })).data;
  assert.equal((await add(project, { supersedes_id: prior.id })).status, 400);
  const results = await Promise.all(["First", "Second"].map(content => add(project,
    { kind: "action", content, status: "done", verification: "confirmed", supersedes_id: prior.id })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const records = (await request(`/projects/${project.id}/entries`)).data.entries;
  assert.equal(records.length, 2);
  assert.equal(records.filter(e => e.is_current).length, 1);
});

test("a long brief reports truncation separately for each section", async () => {
  const project = await create();
  for (let i = 0; i < 51; i++) assert.equal((await add(project, { content: "Pending " + i })).status, 201);
  assert.equal((await add(project, { content: "Confirmed", verification: "confirmed" })).status, 201);
  const brief = (await request(`/projects/${project.id}/brief`)).data;
  assert.equal(brief.sections.unverified.total, 51);
  assert.equal(brief.sections.unverified.entries.length, 50);
  assert.equal(brief.sections.unverified.truncated, true);
  assert.equal(brief.sections.confirmed_facts.total, 1);
  assert.equal(brief.sections.confirmed_facts.truncated, false);
});

test("quoted and Unicode content round trips without becoming SQL", async () => {
  const project = await create();
  const content = "O'Reilly'); DROP TABLE projects; -- \u9879\u76ee\u8fdb\u5ea6 \u{1f680}";
  const result = await add(project, { content, verification: "confirmed", occurred_at: "2026-09-25T00:00:00Z" });
  assert.equal(result.status, 201);
  assert.equal(result.data.occurred_at, "2026-09-25T00:00:00.000Z");
  const brief = (await request(`/projects/${project.id}/brief`)).data;
  assert.equal(brief.sections.confirmed_facts.entries[0].content, content);
});

test("v1 API creates records shared with legacy routes and serves its contract", async () => {
  const spec = await fetch(base + "/api/v1/openapi.json", { signal: AbortSignal.timeout(5000) });
  assert.equal(spec.status, 200);
  assert.equal(spec.headers.get("x-api-version"), "1");
  const contract = await spec.json();
  assert.equal(contract.openapi, "3.1.0");
  assert.equal(contract.servers[0].url, "/api/v1");
  const project = (await request("/api/v1/projects", {
    name: "Versioned acceptance " + randomUUID(), objective: "Native API compatibility", source,
  })).data;
  assert.ok(project.id);
  assert.deepEqual((await request(`/projects/${project.id}`)).data, project);
  const first = (await add(project, { kind: "action", verification: "confirmed" })).data;
  const revision = await request(`/api/v1/projects/${project.id}/entries`, {
    kind: "action", content: "Completed through v1", status: "done", verification: "confirmed", source, supersedes_id: first.id,
  });
  assert.equal(revision.status, 201);
  const oldHistory = (await request(`/projects/${project.id}/entries`)).data;
  const newHistory = (await request(`/api/v1/projects/${project.id}/entries`)).data;
  assert.deepEqual(newHistory, oldHistory);
  assert.equal(newHistory.entries.length, 2);
  assert.equal(newHistory.entries.find(entry => entry.is_current).id, revision.data.id);
  const brief = (await request(`/api/v1/projects/${project.id}/brief`)).data;
  assert.equal(brief.sections.closed.entries[0].id, revision.data.id);
  const invalid = await request("/api/v1/projects?limit=101");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, "validation_error");
  assert.ok(invalid.data.request_id);
});
