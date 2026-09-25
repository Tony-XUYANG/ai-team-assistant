const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

async function collectContractSamples(base) {
  const samples = [];
  const source = { kind: "note", label: "Automated API contract; synthetic data" };
  async function request(path, route = path, body, status = 200, headers = {}) {
    const method = body === undefined ? "GET" : "POST";
    const response = await fetch(base + "/api/v1" + route, {
      method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, status, `${method} ${path}`);
    const data = await response.json();
    samples.push({ method, path, status, headers: Object.fromEntries(response.headers), body: data });
    return data;
  }
  const project = await request("/projects", "/projects", {
    name: "API contract " + randomUUID(), objective: "Check native-client API shapes", source,
  }, 201);
  const route = "/projects/" + project.id;
  await request("/projects/{id}", route);
  const input = { kind: "action", content: "Verify shared API contract", verification: "confirmed", source };
  const first = await request("/projects/{id}/entries", route + "/entries", input, 201);
  await request("/projects", "/projects?limit=1");
  await request("/projects/{id}/entries", route + "/entries?limit=1");
  await request("/projects/{id}/brief", route + "/brief");
  const revision = { ...input, status: "done", supersedes_id: first.id };
  await request("/projects/{id}/entries", route + "/entries", revision, 201);
  await request("/projects/{id}/entries", route + "/entries", revision, 409);
  await request("/projects", "/projects?limit=0", undefined, 400);
  await request("/projects/{id}", "/projects/" + randomUUID(), undefined, 404);
  await request("/projects", "/projects", {}, 403, { origin: "https://external.example" });
  await request("/projects", "/projects", { content: "x".repeat(17000) }, 413);
  return samples;
}

if (require.main === module) {
  collectContractSamples(process.env.TEST_BASE_URL || "http://127.0.0.1:8000")
    .then(samples => process.stdout.write(JSON.stringify(samples)))
    .catch(() => { process.stderr.write("API contract sample collection failed\n"); process.exitCode = 1; });
}
module.exports = { collectContractSamples };
