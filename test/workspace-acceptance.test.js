const test = require("node:test");
const assert = require("node:assert/strict");
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";

test("built image includes the workspace and all local assets", async () => {
  for (const [route, contentType] of [["/", "text/html"], ["/styles.css", "text/css"], ["/workspace.js", "text/javascript"], ["/vendor/lucide.min.js", "text/javascript"]]) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith(contentType));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.ok((await response.text()).length > 100);
  }
});

test("built image rejects browser cross-origin writes and private asset paths", async () => {
  const rejected = await fetch(base + "/projects", { method: "POST", headers: { origin: "https://external.example" },
    body: "{}", signal: AbortSignal.timeout(5000) });
  assert.equal(rejected.status, 403); await rejected.text();
  const missing = await fetch(base + "/.env", { signal: AbortSignal.timeout(5000) });
  assert.equal(missing.status, 404); await missing.text();
});
