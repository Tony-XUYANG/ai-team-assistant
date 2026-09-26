const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { passwordHash, hashToken, csrfFor } = require("../auth");
const { createServer } = require("../app");

function scoped(accountId, records) {
  return {
    async listProjects() { return { projects: records.map(item => ({ ...item })), limit: 50, offset: 0, has_more: false, next_offset: null }; },
    async getProject(id) { return records.find(item => item.id === id) || null; },
    async getProjectBrief(id) { const project = records.find(item => item.id === id); return project ? { project, generated_at: "2026-09-26T00:00:00.000Z", mode: "recorded_context", verification_basis: "caller_asserted", sections: {} } : null; },
    async listProjectEntries(id) { return records.some(item => item.id === id) ? { entries: [], limit: 50, offset: 0, has_more: false, next_offset: null } : null; },
    async createProject(input) { const project = { id: accountId + "-project", ...input }; records.push(project); return project; },
    async createProjectEntry(id) { return records.some(item => item.id === id) ? { id: accountId + "-entry", project_id: id, kind: "progress", content: "isolated", source: {} } : null; },
  };
}

async function fixture(t) {
  const passwords = { alice: "correct horse battery staple", bob: "another correct password" };
  const accounts = new Map();
  for (const [username, password] of Object.entries(passwords)) accounts.set(username, { id: username + "-id", username, password_hash: await passwordHash(password) });
  const projects = new Map([["alice-id", [{ id: "alice-project", name: "Alice private", objective: "A", source: {}, status: "active" }]],
    ["bob-id", [{ id: "bob-project", name: "Bob private", objective: "B", source: {}, status: "active" }]]]);
  const sessions = new Map();
  const database = {
    async takeAuthAttempt() { return true; },
    async findAccount(username) { return accounts.get(username); },
    async createSession(username, passwordHashValue, tokenHash) { const account = accounts.get(username); if (!account || account.password_hash !== passwordHashValue) return null; sessions.set(tokenHash, account); return { id: account.id, expires_at: "2026-09-26T12:00:00.000Z" }; },
    async getSession(tokenHash) { const account = sessions.get(tokenHash); return account && { ...account, expires_at: "2026-09-26T12:00:00.000Z" }; },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
    forAccount(accountId) { return scoped(accountId, projects.get(accountId) || []); },
  };
  const server = createServer({ database, secureCookies: false, log() {} });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, options = {}) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(5000), ...options });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }
  async function login(username) {
    const result = await request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: passwords[username] }) });
    assert.equal(result.status, 200);
    return { cookie: result.headers.get("set-cookie").split(";", 1)[0], csrf: result.body.csrf_token };
  }
  return { request, login };
}

test("project APIs require sessions and isolate two accounts on legacy and v1 paths", async t => {
  const f = await fixture(t);
  for (const route of ["/projects", "/api/v1/projects"]) assert.equal((await f.request(route)).status, 401);
  const alice = await f.login("alice");
  const bob = await f.login("bob");
  for (const auth of [{ ...alice, route: "/projects" }, { ...alice, route: "/api/v1/projects" }, { ...bob, route: "/projects" }, { ...bob, route: "/api/v1/projects" }]) {
    const result = await f.request(auth.route, { headers: { cookie: auth.cookie } });
    assert.equal(result.status, 200);
    assert.equal(result.body.projects[0].name, auth.cookie === alice.cookie ? "Alice private" : "Bob private");
  }
  const secretId = "alice-project";
  for (const route of [`/projects/${secretId}`, `/projects/${secretId}/entries`, `/projects/${secretId}/brief`, `/api/v1/projects/${secretId}`, `/api/v1/projects/${secretId}/entries`, `/api/v1/projects/${secretId}/brief`]) {
    const response = await f.request(route, { headers: { cookie: bob.cookie } });
    assert.equal(response.status, 404, route);
  }
  const write = await f.request(`/api/v1/projects/${secretId}/entries`, { method: "POST", headers: { cookie: bob.cookie, "x-csrf-token": bob.csrf, "content-type": "application/json" }, body: JSON.stringify({ kind: "progress", content: "attempt", source: { kind: "note", label: "test" } }) });
  assert.equal(write.status, 404);
  const noCsrf = await f.request("/api/v1/projects", { method: "POST", headers: { cookie: alice.cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x", objective: "x", source: { kind: "note", label: "x" } }) });
  assert.equal(noCsrf.status, 403);
  assert.equal(csrfFor("not-used").length, 64);
  assert.equal(hashToken("test").length, 64);
});
