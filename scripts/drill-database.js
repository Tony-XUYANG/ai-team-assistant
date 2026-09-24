const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { Script } = require("node:vm");
const { setTimeout: delay } = require("node:timers/promises");

const execute = promisify(execFile);
const projectDir = path.resolve(__dirname, "..");
const root = path.resolve(projectDir, "..");
const id = "db-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
const runDir = path.join(projectDir, ".incidents", id);
const lockPath = path.join(projectDir, ".releases", "active.lock");
const baseUrl = "http://127.0.0.1:8081";
const marker = "DO_NOT_LOG_" + id;
const report = { id, startedAt: new Date().toISOString(), context: "k3d-shortener", namespace: "shortener", status: "started" };
let baseline;
let originalPods;
let pvc;
let savedLink;
let faultAttempted = false;
let faultDeadline;
let interrupted = false;

async function save(name, value) {
  await fs.writeFile(path.join(runDir, name), JSON.stringify(value, null, 2));
}

async function kubectl(...args) {
  const result = await execute(path.join(root, "bin", "kubectl.exe"), [
    "--kubeconfig", path.join(root, "kubeconfig.yaml"), "--cache-dir", path.join(root, ".kube-cache"),
    "--context=k3d-shortener", "--request-timeout=15s", "-n", "shortener", ...args,
  ], { cwd: projectDir, timeout: 75000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp") } });
  return result.stdout.trim();
}

async function get(kind, name) {
  return JSON.parse(await kubectl("get", kind, name, "-o", "json"));
}

async function apiPods() {
  return JSON.parse(await kubectl("get", "pods", "-l", "app=api", "-o", "json"))
    .items.filter(pod => !pod.metadata.deletionTimestamp).map(pod => ({
      name: pod.metadata.name, uid: pod.metadata.uid, phase: pod.status.phase,
      ready: pod.status.conditions?.find(condition => condition.type === "Ready")?.status === "True",
      restarts: pod.status.containerStatuses?.find(container => container.name === "api")?.restartCount,
    }));
}

async function endpoints(service) {
  const slices = JSON.parse(await kubectl("get", "endpointslices", "-l", `kubernetes.io/service-name=${service}`, "-o", "json"));
  return summarizeEndpoints(slices);
}

function summarizeEndpoints(slices) {
  assert.ok(Array.isArray(slices.items), "Expected an EndpointSlice list");
  return slices.items.flatMap(slice => (slice.endpoints ?? []).map(endpoint => ({
    addresses: endpoint.addresses, ready: endpoint.conditions?.ready !== false,
  })));
}

function checkDeadline() {
  assert.ok(!interrupted, "Interrupted; restoring database");
  assert.ok(!faultDeadline || Date.now() < faultDeadline, "Fault observation deadline reached; restoring database");
}

async function until(label, timeout, check, duringFault = false) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (duringFault) checkDeadline();
    const value = await check();
    if (value) return value;
    await delay(1000);
  }
  throw new Error("Timed out: " + label);
}

async function request(route, options = {}) {
  const response = await fetch(baseUrl + route, {
    redirect: "manual", signal: AbortSignal.timeout(5000), ...options,
    headers: { Connection: "close", "Content-Type": "application/json", ...options.headers },
  });
  return { status: response.status, requestId: response.headers.get("x-request-id"),
    location: response.headers.get("location"), body: await response.text() };
}

async function patchReplicas(current, replicas, filename) {
  const operations = [
    { op: "test", path: "/metadata/uid", value: current.metadata.uid },
    { op: "test", path: "/metadata/generation", value: current.metadata.generation },
    { op: "test", path: "/spec/replicas", value: current.spec.replicas },
    { op: "replace", path: "/spec/replicas", value: replicas },
  ];
  await save(filename, operations);
  await kubectl("patch", "statefulset", "db", "--type=json", "--patch-file", path.join(runDir, filename));
}

async function samplePod(pod, index, phase = "fault") {
  const script = String.raw`
    const fs = require('node:fs');
    (async () => {
      const requests = [];
      for (const route of ['live', 'health', 'links']) {
        const requestId = ${JSON.stringify(id)} + '-${phase}-${index}-' + route;
        const response = await fetch('http://127.0.0.1:8000/' + route + '?private=' + ${JSON.stringify(marker)}, {
          method: route === 'links' ? 'POST' : 'GET',
          body: route === 'links' ? JSON.stringify({url:'https://example.com/' + ${JSON.stringify(marker)}}) : undefined,
          headers: {'x-request-id':requestId}, signal: AbortSignal.timeout(5000)
        });
        requests.push({route,requestId,status:response.status,responseRequestId:response.headers.get('x-request-id'),body:await response.json()});
      }
      const pid1 = Object.fromEntries(fs.readFileSync('/proc/1/status','utf8').split('\n')
        .filter(line => /^(Name|State|Uid|Gid|VmRSS|Threads):/.test(line))
        .map(line => {const split=line.indexOf(':'); return [line.slice(0,split),line.slice(split+1).trim()];}));
      console.log(JSON.stringify({requests,linux:{uid:process.getuid(),pid1}}));
    })().catch(() => process.exit(1));`;
  new Script(script);
  const result = JSON.parse(await kubectl("exec", pod.name, "-c", "api", "--", "node", "-e", script));
  return { pod: pod.name, ...result };
}

async function recover() {
  console.log("Restoring database replica and verifying recovery");
  const current = await get("statefulset", "db");
  assert.equal(current.metadata.uid, baseline.metadata.uid, "Database object changed; inspect before recovery");
  assert.deepEqual(current.spec.template, baseline.spec.template, "Database template changed concurrently");
  if (current.spec.replicas === 0) {
    assert.equal(current.metadata.generation, baseline.metadata.generation + 1, "Concurrent changes; do not overwrite");
    await patchReplicas(current, baseline.spec.replicas, "restore-patch.json");
  } else {
    assert.equal(current.spec.replicas, baseline.spec.replicas, "Unexpected replica count");
  }
  await kubectl("rollout", "status", "statefulset/db", "--timeout=60s");
  const recoveredPods = await until("API replicas ready", 45000, async () => {
    const pods = await apiPods();
    return pods.length === originalPods.length && pods.every(pod => pod.ready) ? pods : false;
  });
  const health = await request("/health");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).database, "ok");
  const link = await request(savedLink.short_path);
  assert.equal(link.status, 307);
  assert.equal(link.location, "https://example.com/incident-retention");
  const afterPvc = await get("pvc", "data-db-0");
  assert.equal(afterPvc.metadata.uid, pvc.metadata.uid);
  assert.equal(afterPvc.spec.volumeName, pvc.spec.volumeName);
  for (const before of originalPods) {
    const after = recoveredPods.find(pod => pod.uid === before.uid);
    assert.ok(after, "API Pod unexpectedly replaced");
    assert.equal(after.restarts, before.restarts, "API container unexpectedly restarted");
  }
  const stateful = await get("statefulset", "db");
  assert.equal(stateful.spec.replicas, baseline.spec.replicas);
  assert.equal(stateful.status.readyReplicas, baseline.spec.replicas);
  report.recovery = { verified: true, restoredAt: new Date().toISOString(), databaseReplicas: stateful.spec.replicas,
    apiPods: recoveredPods, healthStatus: health.status, savedLinkStatus: link.status,
    pvcUidUnchanged: true, volumeUnchanged: true, apiRestartsUnchanged: true };
}

async function main() {
  process.on("SIGINT", () => { interrupted = true; });
  process.on("SIGTERM", () => { interrupted = true; });
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lock = await fs.open(lockPath, "wx");
  await lock.writeFile(id);
  try {
    baseline = await get("statefulset", "db");
    assert.equal(baseline.spec.replicas, 1);
    assert.equal(baseline.status.readyReplicas, 1);
    assert.equal(baseline.status.observedGeneration, baseline.metadata.generation);
    assert.equal(baseline.spec.persistentVolumeClaimRetentionPolicy?.whenScaled || "Retain", "Retain");
    pvc = await get("pvc", "data-db-0");
    assert.equal(pvc.status.phase, "Bound");
    assert.ok(!pvc.metadata.deletionTimestamp);
    assert.ok(!(pvc.metadata.ownerReferences || []).some(owner => owner.kind === "Pod"), "PVC has a Pod deletion owner");
    const deployment = await get("deployment", "api");
    assert.equal(deployment.status.observedGeneration, deployment.metadata.generation);
    assert.equal(deployment.status.updatedReplicas, deployment.spec.replicas);
    assert.equal(deployment.status.availableReplicas, deployment.spec.replicas);
    originalPods = await apiPods();
    assert.equal(originalPods.length, deployment.spec.replicas);
    assert.ok(originalPods.length > 0 && originalPods.every(pod => pod.ready));
    const service = await get("service", "api");
    assert.ok(!service.spec.publishNotReadyAddresses);
    const version = await request("/version");
    assert.equal(version.status, 200);
    assert.ok(version.requestId, "Publish request-correlation logging before this drill");
    report.version = JSON.parse(version.body).version;
    const created = await request("/links", { method: "POST", body: JSON.stringify({ url: "https://example.com/incident-retention" }) });
    assert.equal(created.status, 201);
    savedLink = JSON.parse(created.body);
    report.before = { statefulSetUid: baseline.metadata.uid, generation: baseline.metadata.generation,
      databaseReplicas: baseline.spec.replicas, pvcUid: pvc.metadata.uid, volume: pvc.spec.volumeName,
      apiPods: originalPods, savedLink: savedLink.short_path };
    report.preflight = [];
    for (let index = 0; index < originalPods.length; index += 1) {
      const sample = await samplePod(originalPods[index], index, "preflight");
      for (const response of sample.requests) {
        assert.equal(response.status, response.route === "links" ? 201 : 200);
        assert.equal(response.responseRequestId, response.requestId);
      }
      report.preflight.push(sample);
    }
    await save("report.json", report);
    checkDeadline();
    console.log("Temporarily scaling ONLY shortener/db to zero; PVC retention verified");
    faultDeadline = Date.now() + 90000;
    faultAttempted = true;
    report.faultStartedAt = new Date().toISOString();
    await patchReplicas(baseline, 0, "fault-patch.json");
    await kubectl("wait", "--for=delete", "pod/db-0", "--timeout=45s");
    report.during = { observations: [] };
    for (let index = 0; index < originalPods.length; index += 1) {
      checkDeadline();
      report.during.observations.push(await samplePod(originalPods[index], index));
    }
    await save("observations.json", report.during.observations);
    for (const observation of report.during.observations) {
      assert.equal(observation.linux.uid, 1000);
      for (const response of observation.requests) {
        assert.equal(response.status, response.route === "live" ? 200 : 503);
        assert.equal(response.responseRequestId, response.requestId);
      }
    }
    report.during.apiPods = await until("all API Pods unready", 30000, async () => {
      const pods = await apiPods();
      return pods.length === originalPods.length && pods.every(pod => !pod.ready && pod.phase === "Running") ? pods : false;
    }, true);
    report.during.apiEndpoints = await until("no ready API endpoints", 15000, async () => {
      const points = await endpoints("api");
      return points.every(endpoint => !endpoint.ready) ? { items: points } : false;
    }, true);
    report.during.databaseEndpoints = await endpoints("db-client");
    assert.ok(report.during.databaseEndpoints.every(endpoint => !endpoint.ready));
    try { report.during.external = await request("/health"); }
    catch (error) { report.during.external = { networkError: error.cause?.code || error.name }; }
    assert.notEqual(report.during.external.status, 200);
    report.during.correlatedErrors = [];
    for (const pod of originalPods) {
      checkDeadline();
      const output = await kubectl("logs", pod.name, "-c", "api", "--since-time=" + report.faultStartedAt);
      assert.ok(!output.includes(marker), "Sensitive request marker leaked to logs");
      const records = output.split(/\r?\n/).filter(Boolean).map(JSON.parse);
      await save(pod.name + "-logs.json", records);
      const observation = report.during.observations.find(item => item.pod === pod.name);
      for (const response of observation.requests.filter(item => item.route !== "live")) {
        const failure = records.find(record => record.requestId === response.requestId && record.event === "request_failed");
        const completed = records.find(record => record.requestId === response.requestId && record.event === "request_completed");
        assert.ok(failure && completed, "Request must have correlated error and completion logs");
        assert.equal(failure.dependency, "postgresql");
        assert.equal(failure.status, 503);
        assert.equal(completed.status, 503);
        report.during.correlatedErrors.push(failure);
      }
    }
    report.during.sensitiveMarkerAbsent = true;
    const events = JSON.parse(await kubectl("get", "events", "--field-selector=reason=Unhealthy", "-o", "json"));
    await save("readiness-events.json", events.items.filter(event => originalPods.some(pod => pod.uid === event.involvedObject.uid))
      .map(event => ({ reason: event.reason, message: event.message, pod: event.involvedObject.name, lastTimestamp: event.lastTimestamp })));
    report.faultVerified = true;
    console.log("Verified: live=200, health/create=503, API Running but not Ready, zero ready endpoints, correlated error logs");
  } catch (error) {
    report.error = error.message;
    report.status = "failed";
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    if (faultAttempted) {
      try { await recover(); }
      catch (error) {
        report.recovery = { verified: false, error: error.message };
        report.status = "recovery_failed";
        process.exitCode = 1;
        console.error("RECOVERY NEEDS ATTENTION: " + error.message);
      }
    }
    if (report.faultVerified && report.recovery?.verified) report.status = "succeeded";
    report.finishedAt = new Date().toISOString();
    await save("report.json", report);
    await lock.close();
    await fs.unlink(lockPath);
    console.log("RESULT: " + report.status);
    console.log("Incident report: " + path.join(runDir, "report.json"));
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { summarizeEndpoints };
