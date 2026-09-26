const http = require("node:http");
const fs = require("node:fs/promises");
const { hostname } = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { version } = require("./package.json");
const { log: defaultLog, requestId, safeErrorCode } = require("./logger");

const { projectRoute, handleProjectRequest } = require("./projects");
const apiContract = require("./api/openapi.json");
const { createAuth } = require("./auth");

const maxBodyBytes = 16 * 1024;
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const knownRoutes = new Set(["/version", "/live", "/health", "/links"]);
const webRoot = path.join(__dirname, "public");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/workspace.js", ["workspace.js", "text/javascript; charset=utf-8"]],
  ["/login", ["login.html", "text/html; charset=utf-8"]],
  ["/login.js", ["login.js", "text/javascript; charset=utf-8"]],
  ["/brief-format.js", ["brief-format.js", "text/javascript; charset=utf-8"]],
  ["/vendor/lucide.min.js", [path.join("..", "node_modules", "lucide", "dist", "umd", "lucide.min.js"), "text/javascript; charset=utf-8"]],
]);

function sendJson(response, statusCode, body) {
  if (statusCode >= 400 && response.getHeader("X-API-Version") === "1") {
    const codes = { 400: "validation_error", 401: "unauthenticated", 403: "cross_origin_denied", 404: "not_found", 429: "rate_limited",
      409: "revision_conflict", 413: "payload_too_large", 500: "internal_error", 503: "service_unavailable" };
    body = { ...body, code: body.code || codes[statusCode] || "internal_error", request_id: response.getHeader("X-Request-ID") };
  }
  if (statusCode >= 400 && response.getHeader("X-API-Version") !== "1") body = { error: body.error };
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function projectPath(pathname) {
  const candidate = pathname.startsWith("/api/v1/") ? pathname.slice("/api/v1".length) : pathname;
  return projectRoute(candidate) ? candidate : null;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    request.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        chunks.length = 0;
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (bytes > maxBodyBytes) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Body must be valid JSON"), { statusCode: 400 })); }
    });
    request.on("error", reject);
    request.on("aborted", () => reject(new Error("Request aborted")));
  });
}

function createServer({ database, log = defaultLog, secureCookies = process.env.AUTH_COOKIE_SECURE !== "false" }) {
  const authEnabled = typeof database.forAccount === "function" && typeof database.getSession === "function";
  async function databaseQuery(store, operation, ...args) {
    try { return await store[operation](...args); }
    catch (error) {
      throw Object.assign(new Error("Database operation failed"), {
        statusCode: 503, dependency: "postgresql", operation, errorCode: safeErrorCode(error),
      });
    }
  }
  const query = (operation, ...args) => databaseQuery(database, operation, ...args);
  const auth = createAuth({ query, sendJson, readJson, secureCookies });

  async function handle(request, response, pathname) {
    if (authEnabled && pathname.startsWith("/api/v1/auth/")) return auth.handle(request, response, pathname);
    if (!authEnabled && pathname === "/api/v1/auth/session" && request.method === "GET") {
      return sendJson(response, 200, { account: { id: "fixture", username: "fixture" }, csrf_token: "0".repeat(64), expires_at: null });
    }
    if (request.method === "GET" && pathname === "/api/v1/openapi.json") {
      return sendJson(response, 200, apiContract);
    }
    if (["GET", "HEAD"].includes(request.method) && staticFiles.has(pathname)) {
      const [file, contentType] = staticFiles.get(pathname);
      try {
        const content = await fs.readFile(path.resolve(webRoot, file));
        response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store", "Content-Length": content.length });
        return response.end(request.method === "HEAD" ? undefined : content);
      } catch {
        return sendJson(response, 404, { error: "not found" });
      }
    }
    const projectsPath = projectPath(pathname);
    if (projectsPath) {
      response.setHeader("Cache-Control", "no-store");
      const account = authEnabled ? await auth.requireSession(request, response) : { id: "00000000-0000-4000-8000-000000000000" };
      if (!account) return;
      const scoped = authEnabled ? database.forAccount(account.id) : database;
      return handleProjectRequest({ request, response, pathname: projectsPath,
        query: (operation, ...args) => databaseQuery(scoped, operation, ...args), readJson, sendJson });
    }
    if (request.method === "GET" && pathname === "/version") {
      response.setHeader("Cache-Control", "no-store");
      return sendJson(response, 200, { version, hostname: hostname() });
    }
    if (request.method === "GET" && pathname === "/live") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.method === "GET" && pathname === "/health") {
      await query("checkHealth");
      return sendJson(response, 200, { status: "ok", database: "ok" });
    }
    if (request.method === "POST" && pathname === "/links") {
      const payload = await readJson(request);
      let target;
      try {
        if (typeof payload?.url !== "string" || payload.url.length > 8192) throw new Error("Invalid URL");
        target = new URL(payload.url);
        if (!["http:", "https:"].includes(target.protocol)) throw new Error("Invalid protocol");
      } catch {
        return sendJson(response, 400, { error: "url must be a valid HTTP or HTTPS URL" });
      }
      let title = null;
      if (payload.title !== undefined && payload.title !== null) {
        if (typeof payload.title !== "string" || !payload.title.isWellFormed()
            || /[\u0000-\u001f\u007f]/u.test(payload.title)
            || !payload.title.trim() || [...payload.title.trim()].length > 120) {
          return sendJson(response, 400, { error: "title must be null or 1-120 characters without control characters" });
        }
        title = payload.title.trim();
      }
      const link = await query("createLink", target.toString(), title);
      return sendJson(response, 201, { ...link, short_path: `/${link.code}` });
    }
    if (request.method === "GET" && /^\/links\/[a-f0-9]{8}$/.test(pathname)) {
      const link = await query("getLink", pathname.slice("/links/".length));
      response.setHeader("Cache-Control", "no-store");
      return link ? sendJson(response, 200, { ...link, short_path: `/${link.code}` })
        : sendJson(response, 404, { error: "not found" });
    }
    if (request.method === "GET" && /^\/[a-f0-9]{8}$/.test(pathname)) {
      const target = await query("findLink", pathname.slice(1));
      if (target) {
        response.writeHead(307, { Location: target });
        return response.end();
      }
    }
    sendJson(response, 404, { error: "not found" });
  }

  return http.createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const started = performance.now();
    const context = {
      requestId: requestId(request.headers["x-request-id"]),
      method: methods.has(request.method) ? request.method : "OTHER",
      route: "unmatched",
    };
    response.setHeader("X-Request-ID", context.requestId);
    let pathname;
    let malformed = false;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
      const versioned = pathname === "/api/v1" || pathname.startsWith("/api/v1/");
      if (versioned) {
        response.setHeader("X-API-Version", "1");
        response.setHeader("Cache-Control", "no-store");
      }
      const projectsPath = projectPath(pathname);
      context.route = knownRoutes.has(pathname) ? pathname
        : /^\/links\/[a-f0-9]{8}$/.test(pathname) ? "/links/:code"
        : /^\/[a-f0-9]{8}$/.test(pathname) ? "/:code"
        : projectsPath ? (versioned ? "/api/v1" : "") + projectRoute(projectsPath)
        : ["/api/v1/auth/session", "/api/v1/auth/login", "/api/v1/auth/activate", "/api/v1/auth/logout", "/api/v1/openapi.json"].includes(pathname)
          ? pathname : (staticFiles.has(pathname) ? "/workspace" : "unmatched");
    } catch { malformed = true; }

    let logged = false;
    const recordResult = aborted => {
      if (logged) return;
      logged = true;
      // Successful probes are deliberately quiet; failed probes remain visible.
      if (!aborted && request.method === "GET" && response.statusCode === 200
          && ["/health", "/live"].includes(context.route)) return;
      const status = aborted ? 499 : response.statusCode;
      log(status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        aborted ? "request_aborted" : "request_completed", {
          ...context, status, durationMs: Number((performance.now() - started).toFixed(2)),
        });
    };
    response.once("finish", () => recordResult(false));
    response.once("close", () => recordResult(!response.writableFinished));

    if (malformed) return sendJson(response, 400, { error: "Invalid request URL" });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      let originAllowed = true;
      if (request.headers.origin) {
        try {
          const origin = new URL(request.headers.origin);
          originAllowed = ["http:", "https:"].includes(origin.protocol) && origin.host === request.headers.host;
        } catch { originAllowed = false; }
      }
      if (!originAllowed || request.headers["sec-fetch-site"] === "cross-site") {
        request.resume();
        return sendJson(response, 403, { error: "Cross-origin writes are not allowed" });
      }
    }
    handle(request, response, pathname).catch(error => {
      if (response.destroyed) return;
      const status = [400, 413, 503].includes(error.statusCode) ? error.statusCode : 500;
      if (status >= 500) {
        log("error", "request_failed", {
          ...context, status, dependency: error.dependency, operation: error.operation,
          errorCode: error.errorCode || safeErrorCode(error),
        });
      }
      if (!response.headersSent) {
        const messages = {
          400: error.validationMessage || "Body must be valid JSON", 413: "Request body is too large",
          503: "Service temporarily unavailable", 500: "Internal server error",
        };
        sendJson(response, status, { error: messages[status] });
      } else { response.destroy(); }
    });
  });
}

module.exports = { createServer };
