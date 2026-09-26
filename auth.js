const { randomBytes, scrypt, timingSafeEqual, createHash } = require("node:crypto");
const { promisify } = require("node:util");
const derive = promisify(scrypt);
const cookieName = "workspace_session";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hashToken = value => createHash("sha256").update(value).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const validUsername = value => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value);
const validPassword = value => typeof value === "string" && value.isWellFormed()
  && [...value].length >= 12 && [...value].length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
const dummyHash = "scrypt-v1$" + "0".repeat(32) + "$" + "0".repeat(128);

async function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return `scrypt-v1$${salt}$${key.toString("hex")}`;
}
async function checkPassword(password, encoded) {
  const safe = /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded || "") ? encoded : dummyHash;
  const actual = await passwordHash(password, safe.split("$")[1]);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(safe)) && safe !== dummyHash;
}
function readSessionCookie(request) {
  const values = String(request.headers.cookie || "").split(";").map(v => v.trim())
    .filter(v => v.startsWith(cookieName + "=")).map(v => v.slice(cookieName.length + 1));
  return values.length === 1 && tokenPattern.test(values[0]) ? values[0] : null;
}
function csrfFor(token) { return hashToken("csrf:" + token); }
function matchesCsrf(request, token) {
  const supplied = request.headers["x-csrf-token"];
  return typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied)
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfFor(token)));
}

function createAuth({ query, sendJson, readJson, secureCookies = true }) {
  let hashing = false;
  const reject = (response, status, error, code) => sendJson(response, status, { error, code });
  function cookie(response, token, maxAge) {
    response.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`);
  }
  async function session(request) {
    const token = readSessionCookie(request);
    const account = token && await query("getSession", hashToken(token));
    return account ? { ...account, token, csrf_token: csrfFor(token) } : null;
  }
  async function requireSession(request, response) {
    const current = await session(request);
    if (!current) { request.resume(); reject(response, 401, "Sign in required", "unauthenticated"); return null; }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !matchesCsrf(request, current.token)) {
      request.resume(); reject(response, 403, "CSRF token required", "csrf_denied"); return null;
    }
    return current;
  }
  async function handle(request, response, pathname) {
    response.setHeader("Cache-Control", "no-store");
    if (pathname === "/api/v1/auth/session" && request.method === "GET") {
      const current = await requireSession(request, response);
      if (current) sendJson(response, 200, { account: { id: current.id, username: current.username },
        csrf_token: current.csrf_token, expires_at: current.expires_at });
      return;
    }
    if (pathname === "/api/v1/auth/logout" && request.method === "POST") {
      const current = await requireSession(request, response);
      if (!current) return;
      await query("deleteSession", hashToken(current.token));
      cookie(response, "", 0);
      return sendJson(response, 200, { signed_out: true });
    }
    if (!["/api/v1/auth/login", "/api/v1/auth/activate"].includes(pathname) || request.method !== "POST") {
      return sendJson(response, 404, { error: "not found" });
    }
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      request.resume(); return reject(response, 400, "Use application/json", "validation_error");
    }
    // Shared PostgreSQL budgets survive process restarts and multiple replicas.
    for (const [key, limit] of [["global", 200], ["peer:" + request.socket.remoteAddress, 50]]) {
      if (!await query("takeAuthAttempt", hashToken(key), limit)) {
        request.resume(); response.setHeader("Retry-After", "900");
        return reject(response, 429, "Too many attempts; try later", "rate_limited");
      }
    }
    const body = await readJson(request);
    const activate = pathname.endsWith("/activate");
    const allowed = activate ? ["username", "password", "activation_code"] : ["username", "password"];
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))
      || !validUsername(body.username) || !validPassword(body.password)
      || (activate && (typeof body.activation_code !== "string" || !tokenPattern.test(body.activation_code)))) {
      return reject(response, 400, "Invalid account fields; password must be 12-128 characters", "validation_error");
    }
    if (!await query("takeAuthAttempt", hashToken("account:" + body.username), 10) || hashing) {
      response.setHeader("Retry-After", "900");
      return reject(response, 429, "Too many attempts; try later", "rate_limited");
    }
    hashing = true;
    try {
      const token = newToken();
      let result;
      if (activate) {
        const encoded = await passwordHash(body.password);
        result = await query("activateAccount", body.username, hashToken(body.activation_code), encoded, hashToken(token));
      } else {
        const account = await query("findAccount", body.username);
        const valid = await checkPassword(body.password, account?.password_hash);
        if (valid) result = await query("createSession", body.username, account.password_hash, hashToken(token));
      }
      if (!result) return reject(response, 401, "Account credentials are invalid or expired", "invalid_credentials");
      const previous = readSessionCookie(request);
      if (previous) await query("deleteSession", hashToken(previous));
      cookie(response, token, 43200);
      return sendJson(response, 200, { account: { id: result.id, username: body.username }, csrf_token: csrfFor(token), expires_at: result.expires_at });
    } finally { hashing = false; }
  }
  return { handle, requireSession };
}
module.exports = { createAuth, passwordHash, checkPassword, hashToken, newToken, validUsername, validPassword, csrfFor, cookieName };
