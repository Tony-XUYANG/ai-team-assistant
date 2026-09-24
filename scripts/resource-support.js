const assert = require("node:assert/strict");

function parseCounters(text) {
  return Object.fromEntries(text.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [name, raw] = line.trim().split(/\s+/);
    const value = Number(raw);
    assert.ok(Number.isSafeInteger(value) && value >= 0, "Invalid cgroup counter");
    return [name, value];
  }));
}

function cpuDelta(before, after) {
  const delta = {};
  for (const key of ["usage_usec", "nr_periods", "nr_throttled", "throttled_usec"]) {
    assert.ok(Number.isSafeInteger(before[key]) && Number.isSafeInteger(after[key]), "Missing CPU counter");
    delta[key] = after[key] - before[key];
    assert.ok(delta[key] >= 0, "CPU counters reset during measurement");
  }
  delta.throttledPeriodPercent = delta.nr_periods === 0 ? null
    : Number((100 * delta.nr_throttled / delta.nr_periods).toFixed(2));
  return delta;
}

function validateLoad(options) {
  const { baseUrl, route, durationMs, rate, concurrency, timeoutMs, expectedStatus } = options;
  assert.ok(["http://127.0.0.1:8000", "http://127.0.0.1:8081"].includes(baseUrl), "Only lab loopback endpoints are allowed");
  assert.match(route, /^\/(?:health|live|[a-f0-9]{8})$/);
  const live = baseUrl.endsWith(":8081");
  for (const [value, max] of [[durationMs, live ? 5000 : 8000], [rate, live ? 2 : 200],
    [concurrency, live ? 1 : 32], [timeoutMs, 2000]]) {
    assert.ok(Number.isInteger(value) && value > 0 && value <= max, "Load safety bound exceeded");
  }
  assert.ok([200, 307].includes(expectedStatus));
  return options;
}

function summarizeLoad(samples, { expectedStatus, planned, droppedBusy, droppedLate, elapsedMs, offeredMs, maxLagMs }) {
  assert.ok(samples.length > 0, "No completed samples");
  assert.equal(samples.length + droppedBusy + droppedLate, planned, "Every planned arrival must be accounted for");
  assert.ok(elapsedMs > 0 && offeredMs > 0);
  const latencies = samples.map(s => s.durationMs).sort((a, b) => a - b);
  assert.ok(latencies.every(value => Number.isFinite(value) && value >= 0));
  const percentile = p => Number(latencies[Math.max(0, Math.ceil(p * latencies.length) - 1)].toFixed(2));
  const statuses = {};
  for (const sample of samples) {
    const key = sample.error || String(sample.status);
    statuses[key] = (statuses[key] || 0) + 1;
  }
  const successful = samples.filter(s => !s.error && s.status === expectedStatus).length;
  return {
    planned, sent: samples.length, successful, failed: samples.length - successful,
    droppedBusy, droppedLate, statuses, elapsedMs: Number(elapsedMs.toFixed(2)), offeredMs,
    successPerSecondIncludingDrain: Number((successful * 1000 / elapsedMs).toFixed(2)),
    maxSchedulingLagMs: Number(maxLagMs.toFixed(2)),
    latencyMsAllAttempts: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: percentile(1) },
  };
}

function assertResourceContainer(container, id, name) {
  assert.equal(container.Name, "/" + name);
  assert.equal(container.Config.Labels?.["shortener.lab/resource-run"], id, "Container ownership mismatch");
  assert.ok(!(container.Mounts || []).some(m => ["bind", "volume"].includes(m.Type)), "Persistent mount; cleanup refused");
}

function assertOomPod(pod, id, name) {
  assert.equal(pod.metadata.name, name);
  assert.equal(pod.metadata.namespace, "shortener");
  assert.equal(pod.metadata.labels?.["shortener.lab/resource-run"], id);
  assert.equal(pod.metadata.labels?.app, "resource-lab");
  assert.equal(pod.spec.restartPolicy, "Never");
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal((pod.spec.volumes || []).length, 0);
  assert.equal((pod.spec.containers || []).length, 1);
  assert.equal((pod.spec.initContainers || []).length, 0);
  assert.equal((pod.spec.ephemeralContainers || []).length, 0);
  const container = pod.spec.containers[0];
  assert.equal((container.env || []).length, 0);
  assert.equal((container.envFrom || []).length, 0);
  assert.equal((container.volumeMounts || []).length, 0);
}

module.exports = { parseCounters, cpuDelta, validateLoad, summarizeLoad, assertResourceContainer, assertOomPod };
