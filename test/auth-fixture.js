const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { passwordHash } = require("../auth");

async function createAuthSession(base) {
  const username = "ci_" + randomUUID().replaceAll("-", "");
  const password = "CI acceptance password " + randomUUID();
  const accountId = randomUUID();
  const db = new Client({ application_name: "shortener-acceptance-auth" });
  await db.connect();
  try {
    await db.query(`INSERT INTO public.accounts (id, username, password_hash)
      VALUES ($1, $2, $3)`, [accountId, username, await passwordHash(password)]);
  } finally {
    await db.end();
  }

  let cookie = null;
  let csrfToken = null;
  async function request(route, options = {}) {
    const method = options.method || "GET";
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) headers["x-csrf-token"] = csrfToken;
    const response = await fetch(base + route, { ...options, method, headers, signal: AbortSignal.timeout(5000) });
    const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (data?.csrf_token) csrfToken = data.csrf_token;
    return { status: response.status, data, headers: response.headers };
  }

  const login = await request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200, "Acceptance account login failed");
  assert.match(cookie || "", /^workspace_session=/);
  assert.match(csrfToken || "", /^[a-f0-9]{64}$/);
  return { accountId, username, request };
}

module.exports = { createAuthSession };
