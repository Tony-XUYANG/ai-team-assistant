const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const projectId = new RegExp(`^/projects/(${uuid})$`, "i");
const projectEntries = new RegExp(`^/projects/(${uuid})/(entries|brief)$`, "i");
const statuses = new Set(["active", "paused", "archived"]);
const kinds = new Set(["progress", "decision", "blocker", "action"]);
const verifications = new Set(["confirmed", "unverified", "disputed"]);
const sourceKinds = new Set(["url", "document", "message", "note", "other"]);
const uuidValue = new RegExp(`^${uuid}$`, "i");

function invalid(message) {
  throw Object.assign(new Error(message), { statusCode: 400, validationMessage: message });
}

function text(value, name, max, optional = false) {
  if (value === undefined || value === null) {
    if (optional) return null;
    invalid(`${name} is required`);
  }
  if (typeof value !== "string" || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)
      || !value.trim() || [...value.trim()].length > max) invalid(`${name} must be 1-${max} characters`);
  return value.trim();
}

function choice(value, name, allowed, fallback) {
  const result = value === undefined ? fallback : value;
  if (!allowed.has(result)) invalid(`${name} is invalid`);
  return result;
}

function date(value, name, optional = true) {
  if (value === undefined || value === null) return optional ? null : invalid(`${name} is required`);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)
      || Number.isNaN(Date.parse(value))) invalid(`${name} must be a UTC ISO timestamp`);
  const normalized = new Date(value).toISOString();
  if (normalized !== (value.includes(".") ? value : value.replace(/Z$/, ".000Z"))) invalid(`${name} must be a valid calendar date`);
  return normalized;
}

function source(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("source must be an object");
  fields(value, ["kind", "label", "locator", "captured_at"]);
  const result = { kind: choice(value.kind, "source.kind", sourceKinds), label: text(value.label, "source.label", 160) };
  const locator = text(value.locator, "source.locator", 2000, true);
  const captured = date(value.captured_at, "source.captured_at");
  if (result.kind === "url") {
    let url;
    try { url = new URL(locator); } catch { invalid("source.locator must be an HTTP or HTTPS URL"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      invalid("source.locator must be an HTTP or HTTPS URL without credentials");
    }
  }
  if (locator !== null) result.locator = locator;
  result.captured_at = captured || new Date().toISOString();
  return result;
}

function projectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("project body must be an object");
  fields(body, ["name", "objective", "constraints", "source", "status"]);
  const constraints = body.constraints === undefined ? [] : body.constraints;
  if (!Array.isArray(constraints) || constraints.length > 30) invalid("constraints must be an array of at most 30 items");
  return { name: text(body.name, "name", 120), objective: text(body.objective, "objective", 2000),
    constraints: constraints.map(item => text(item, "constraint", 500)), source: source(body.source),
    status: choice(body.status, "status", statuses, "active") };
}

function entryBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("entry body must be an object");
  fields(body, ["kind", "content", "verification", "status", "owner_ref", "source", "occurred_at", "supersedes_id"]);
  if (body.supersedes_id != null && (typeof body.supersedes_id !== "string" || !uuidValue.test(body.supersedes_id))) {
    invalid("supersedes_id must be a UUID");
  }
  const kind = choice(body.kind, "kind", kinds);
  const defaults = { progress: "recorded", decision: "recorded", blocker: "open", action: "todo" };
  const allowedStatus = kind === "blocker" ? new Set(["open", "resolved"])
    : kind === "action" ? new Set(["todo", "doing", "done", "cancelled"])
    : new Set(["recorded"]);
  return { kind, content: text(body.content, "content", 4000),
    verification: choice(body.verification, "verification", verifications, "unverified"),
    status: choice(body.status, "status", allowedStatus, defaults[kind]),
    owner_ref: text(body.owner_ref, "owner_ref", 120, true), source: source(body.source),
    occurred_at: date(body.occurred_at, "occurred_at") || new Date().toISOString(),
    supersedes_id: body.supersedes_id?.toLowerCase() || null };
}

function fields(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) invalid("body contains unsupported fields");
}

function pagination(request) {
  const params = new URL(request.url, "http://localhost").searchParams;
  if ([...params.keys()].some(key => !["limit", "offset"].includes(key))) invalid("unsupported query parameter");
  const number = (key, fallback, min, max) => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (params.getAll(key).length !== 1 || !/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) {
      invalid(`${key} is out of range`);
    }
    return Number(value);
  };
  return { limit: number("limit", 50, 1, 100), offset: number("offset", 0, 0, 1000000) };
}

function projectRoute(pathname) {
  if (pathname === "/projects") return "/projects";
  if (projectId.test(pathname)) return "/projects/:id";
  if (projectEntries.test(pathname)) return pathname.endsWith("/brief") ? "/projects/:id/brief" : "/projects/:id/entries";
  return null;
}

async function handleProjectRequest({ request, response, pathname, query, readJson, sendJson }) {
  if (pathname === "/projects" && request.method === "GET") return sendJson(response, 200, await query("listProjects", pagination(request)));
  if (pathname === "/projects" && request.method === "POST") {
    return sendJson(response, 201, await query("createProject", projectBody(await readJson(request))));
  }
  const single = pathname.match(projectId);
  if (single && request.method === "GET") {
    const project = await query("getProject", single[1].toLowerCase());
    return project ? sendJson(response, 200, project) : sendJson(response, 404, { error: "project not found" });
  }
  const child = pathname.match(projectEntries);
  if (child && child[2] === "brief" && request.method === "GET") {
    const brief = await query("getProjectBrief", child[1].toLowerCase());
    return brief ? sendJson(response, 200, brief) : sendJson(response, 404, { error: "project not found" });
  }
  if (child && child[2] === "entries" && request.method === "POST") {
    const result = await query("createProjectEntry", child[1].toLowerCase(), entryBody(await readJson(request)));
    if (!result) return sendJson(response, 404, { error: "project or predecessor not found" });
    if (result.error === "conflict") return sendJson(response, 409, { error: "entry already superseded; read current history and retry" });
    if (result.error === "kind_mismatch") return sendJson(response, 400, { error: "revision must keep the original kind" });
    return sendJson(response, 201, result);
  }
  if (child && child[2] === "entries" && request.method === "GET") {
    const result = await query("listProjectEntries", child[1].toLowerCase(), pagination(request));
    return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: "project not found" });
  }
  return sendJson(response, 404, { error: "not found" });
}

module.exports = { projectRoute, handleProjectRequest };
