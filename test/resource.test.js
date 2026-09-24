const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { parseCounters, cpuDelta, validateLoad, summarizeLoad, assertResourceContainer, assertOomPod } = require("../scripts/resource-support");
const { measure } = require("../scripts/resource-load");

const options = { baseUrl: "http://127.0.0.1:8000", route: "/live", durationMs: 1000,
  rate: 10, concurrency: 2, timeoutMs: 1000, expectedStatus: 200 };

test("load refuses external targets, excessive concurrency and live service stress", () => {
  assert.equal(validateLoad(options), options);
  for (const change of [{ baseUrl: "https://example.com" }, { route: "/links" }, { rate: 201 },
    { concurrency: 33 }, { durationMs: 8001 }, { timeoutMs: 2001 }, { rate: 0 }, { rate: 1.5 },
    { baseUrl: "http://127.0.0.1:8081" }, { expectedStatus: 201 }]) {
    assert.throws(() => validateLoad({ ...options, ...change }));
  }
  validateLoad({ ...options, baseUrl: "http://127.0.0.1:8081", rate: 2, concurrency: 1 });
});

test("latency uses nearest-rank percentiles and failures remain visible", () => {
  const summary = summarizeLoad([{ status: 200, durationMs: 10 }, { status: 503, durationMs: 20 },
    { error: "timeout", durationMs: 1000 }, { status: 200, durationMs: 30 }], {
    expectedStatus: 200, planned: 6, droppedBusy: 1, droppedLate: 1, elapsedMs: 2000, offeredMs: 1000, maxLagMs: 8,
  });
  assert.deepEqual(summary.latencyMsAllAttempts, { p50: 20, p95: 1000, p99: 1000, max: 1000 });
  assert.equal(summary.successful, 2);
  assert.equal(summary.failed, 2);
  assert.equal(summary.successPerSecondIncludingDrain, 1);
  assert.equal(summary.statuses.timeout, 1);
  assert.throws(() => summarizeLoad([], {}));
  assert.throws(() => summarizeLoad([{ durationMs: 1 }], { planned: 2, droppedBusy: 0, droppedLate: 0 }));
});

test("cgroup CPU evidence uses counter deltas and rejects counter resets", () => {
  const before = parseCounters("usage_usec 100\nnr_periods 4\nnr_throttled 1\nthrottled_usec 30\n");
  const after = { usage_usec: 600, nr_periods: 14, nr_throttled: 6, throttled_usec: 130 };
  assert.equal(cpuDelta(before, after).throttledPeriodPercent, 50);
  assert.equal(cpuDelta(before, before).throttledPeriodPercent, null);
  assert.throws(() => cpuDelta(after, before));
  assert.throws(() => cpuDelta({}, after));
  assert.throws(() => parseCounters("counter invalid"));
});

test("cleanup refuses foreign containers and persistent mounts", () => {
  const container = { Name: "/temporary", Config: { Labels: { "shortener.lab/resource-run": "run" } }, Mounts: [] };
  assertResourceContainer(container, "run", "temporary");
  assert.throws(() => assertResourceContainer(container, "another-run", "temporary"));
  assert.throws(() => assertResourceContainer(container, "run", "other"));
  for (const Type of ["volume", "bind"]) {
    assert.throws(() => assertResourceContainer({ ...container, Mounts: [{ Type }] }, "run", "temporary"));
  }
});

test("OOM cleanup validates ownership and absence of persistent credentials or storage", () => {
  const pod = { metadata: { name: "oom", namespace: "shortener", labels: { app: "resource-lab", "shortener.lab/resource-run": "run" } },
    spec: { restartPolicy: "Never", automountServiceAccountToken: false, containers: [{ name: "memory" }] } };
  assertOomPod(pod, "run", "oom");
  assert.throws(() => assertOomPod(pod, "other", "oom"));
  assert.throws(() => assertOomPod({ ...pod, spec: { ...pod.spec, volumes: [{}] } }, "run", "oom"));
  assert.throws(() => assertOomPod({ ...pod, spec: { ...pod.spec, containers: [{ envFrom: [{}] }] } }, "run", "oom"));
});

test("bounded HTTP sampler consumes responses, validates redirects and counts timeouts", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") return;
    if (request.url === "/1234abcd") { response.writeHead(307, { Location: "https://example.com/resource-lab" }); response.end(); return; }
    response.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8000, "127.0.0.1", resolve);
  });
  try {
    const result = await measure({ ...options, durationMs: 350 });
    assert.ok(result.summary.successful >= 1);
    assert.equal(result.summary.failed, 0);
    const redirect = await measure({ ...options, durationMs: 100, route: "/1234abcd", expectedStatus: 307,
      expectedLocation: "https://example.com/resource-lab" });
    assert.equal(redirect.summary.successful, 1);
    const wrong = await measure({ ...options, durationMs: 100, route: "/1234abcd", expectedStatus: 307, expectedLocation: "wrong" });
    assert.equal(wrong.summary.statuses["wrong-location"], 1);
    const timeout = await measure({ ...options, durationMs: 100, route: "/health", timeoutMs: 50 });
    assert.equal(timeout.summary.statuses.timeout, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
