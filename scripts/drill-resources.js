const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { parseCounters, cpuDelta, assertResourceContainer, assertOomPod } = require("./resource-support");
const { measure } = require("./resource-load");
const { redactDiagnostics } = require("./ci-support");
const { assertDatabaseIsolation } = require("./backup-support");

const execute = promisify(execFile);
const project = path.resolve(__dirname, "..");
const root = path.dirname(project);
const temp = path.join(root, "tmp");
const id = "resources-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(4).toString("hex");
const runDir = path.join(project, ".incidents", id);
const lockPath = path.join(project, ".releases", "active.lock");
const dockerPath = process.platform === "win32" ? "docker.exe" : "docker";
const prefix = "shortener-res-" + randomBytes(6).toString("hex");
const dbName = prefix + "-db";
const apiName = prefix + "-api";
const driverName = prefix + "-load";
const oomName = prefix + "-oom";
const containers = new Set();
const report = { id, startedAt: new Date().toISOString(), status: "started", phase: "preflight",
  liveService: "http://127.0.0.1:8081", cpu: [], liveChecks: [] };
let before;
let release;
let oomAttempted = false;
let oomUid;
let interrupted = false;
let monitoring = false;
let monitorTask;
const deadline = Date.now() + 300000;

const save = (name, value) => fs.writeFile(path.join(runDir, name), JSON.stringify(value, null, 2) + "\n");
function checkBudget() {
  assert.ok(!interrupted, "Interrupted; cleaning up owned temporary resources");
  assert.ok(Date.now() < deadline, "Five-minute drill deadline exceeded");
  assert.ok(report.liveChecks.filter(check => check.status !== 200).length < 2, "Live health degraded; stopping drill");
}

async function run(executable, args, extraEnv = {}, timeout = 25000) {
  try {
    return (await execute(executable, args, { cwd: project, timeout, windowsHide: true,
      maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...extraEnv, TEMP: temp, TMP: temp } })).stdout.trim();
  } catch (error) {
    throw new Error(redactDiagnostics(`${path.basename(executable)} ${args[0]} failed: ${error.stderr || error.message}`));
  }
}
const docker = (...args) => run(dockerPath, args);
const kubectl = (...args) => run(path.join(root, "bin", "kubectl.exe"), [
  "--kubeconfig", path.join(root, "kubeconfig.yaml"), "--cache-dir", path.join(root, ".kube-cache"),
  "--context=k3d-shortener", "--request-timeout=15s", "-n", "shortener", ...args,
]);
const get = async (kind, name) => JSON.parse(await kubectl("get", kind, name, "-o", "json"));

async function request(route) {
  const started = Date.now();
  const response = await fetch(report.liveService + route, { redirect: "manual", signal: AbortSignal.timeout(2000) });
  const body = await response.text();
  return { status: response.status, durationMs: Date.now() - started, body };
}

async function snapshot() {
  const deployment = await get("deployment", "api");
  const stateful = await get("statefulset", "db");
  const pods = JSON.parse(await kubectl("get", "pods", "-l", "app in (api,db)", "-o", "json")).items
    .map(p => ({ name: p.metadata.name, uid: p.metadata.uid,
      ready: p.status.conditions?.some(c => c.type === "Ready" && c.status === "True"),
      containers: (p.status.containerStatuses || []).map(c => ({ name: c.name, restarts: c.restartCount })) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pvc = await get("pvc", "data-db-0");
  assert.equal(deployment.spec.replicas, 2);
  assert.equal(deployment.status.availableReplicas, 2);
  assert.equal(deployment.status.observedGeneration, deployment.metadata.generation);
  assert.equal(stateful.spec.replicas, 1);
  assert.equal(stateful.status.readyReplicas, 1);
  assert.equal(pods.length, 3);
  assert.ok(pods.every(p => p.ready));
  assert.equal(pvc.status.phase, "Bound");
  return { deployment: { uid: deployment.metadata.uid, generation: deployment.metadata.generation, spec: deployment.spec },
    statefulSet: { uid: stateful.metadata.uid, generation: stateful.metadata.generation, spec: stateful.spec },
    pods, pvc: { uid: pvc.metadata.uid, volume: pvc.spec.volumeName } };
}

async function liveMonitor() {
  while (monitoring) {
    const at = new Date().toISOString();
    try {
      const response = await request("/health");
      report.liveChecks.push({ at, status: response.status, durationMs: response.durationMs });
    } catch { report.liveChecks.push({ at, status: null, error: "health-request-failed" }); }
    await delay(1000);
  }
}

async function inspect(name) {
  const format = '{"Name":{{json .Name}},"Config":{"Labels":{{json .Config.Labels}}},"Mounts":{{json .Mounts}},'
    + '"HostConfig":{{json .HostConfig}},"State":{{json .State}}}';
  return JSON.parse(await docker("inspect", "--format", format, name));
}

async function cleanupContainers() {
  const errors = [];
  for (const name of [...containers].reverse()) {
    try {
      const found = await docker("ps", "-aq", "--filter", "name=^/" + name + "$");
      if (found) {
        const container = await inspect(name);
        assertResourceContainer(container, id, name);
        await docker("rm", "--force", name);
        assert.equal(await docker("ps", "-aq", "--filter", "name=^/" + name + "$"), "");
      }
      containers.delete(name);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
}

async function cleanupPod() {
  if (!oomAttempted) return;
  const text = await kubectl("get", "pod", oomName, "--ignore-not-found", "-o", "json");
  if (!text) return;
  const pod = JSON.parse(text);
  assertOomPod(pod, id, oomName);
  if (oomUid) assert.equal(pod.metadata.uid, oomUid, "Temporary Pod UID changed; refusing cleanup");
  await kubectl("delete", "pod", oomName, "--wait=true", "--timeout=15s");
  assert.equal(await kubectl("get", "pod", oomName, "--ignore-not-found", "-o", "name"), "");
}

async function until(label, check, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    checkBudget();
    const result = await check();
    if (result) return result;
    await delay(500);
  }
  throw new Error("Timed out: " + label);
}

async function installDriver() {
  const files = [];
  for (const name of ["resource-load.js", "resource-support.js"]) {
    files.push({ name, data: (await fs.readFile(path.join(project, "scripts", name))).toString("base64") });
  }
  const code = `const fs=require('node:fs');const assert=require('node:assert/strict');
    for(const file of JSON.parse(fs.readFileSync(0,'utf8'))){
      assert.ok(['resource-load.js','resource-support.js'].includes(file.name));
      fs.writeFileSync('/lab/'+file.name,Buffer.from(file.data,'base64'),{flag:'wx'});
    }`;
  await new Promise((resolve, reject) => {
    const child = spawn(dockerPath, ["exec", "-i", driverName, "node", "-e", code], {
      cwd: project, windowsHide: true, stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, TEMP: temp, TMP: temp },
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 10000);
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.stdin.on("error", () => {});
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Driver install failed: " + stderr)); });
    child.stdin.end(JSON.stringify(files));
  });
}

async function counters(name) {
  return parseCounters(await docker("exec", name, "cat", "/sys/fs/cgroup/cpu.stat"));
}

async function memory(name) {
  const keys = ["current", "peak", "max", "swap.max"];
  const values = (await docker("exec", name, "cat", ...keys.map(key => "/sys/fs/cgroup/memory." + key))).split(/\s+/);
  assert.equal(values.length, keys.length);
  return Object.fromEntries(keys.map((key, i) => [key, values[i] === "max" ? "max" : Number(values[i])]));
}

async function isolatedCpu() {
  report.phase = "cpu";
  checkBudget();
  const password = randomBytes(24).toString("hex");
  const pgImage = JSON.parse(await docker("image", "inspect", "postgres:17-alpine"))[0].Id;
  const common = ["--label", "shortener.lab/resource-run=" + id, "--pull=never", "--platform=linux/amd64",
    "--no-healthcheck", "--pids-limit", "64", "--log-opt", "max-size=2m", "--log-opt", "max-file=1"];
  containers.add(dbName);
  await run(dockerPath, ["run", "-d", "--name", dbName, ...common, "--network", "none", "--cpus", "0.5",
    "--memory", "256m", "--memory-swap", "256m", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=134217728",
    "--env", "POSTGRES_USER=resource_lab", "--env", "POSTGRES_DB=resource_lab", "--env", "POSTGRES_PASSWORD",
    pgImage, "postgres", "-c", "shared_buffers=16MB", "-c", "max_connections=15"], { POSTGRES_PASSWORD: password });
  await until("temporary PostgreSQL ready", async () => {
    try { await docker("exec", dbName, "pg_isready", "-h", "127.0.0.1", "-U", "resource_lab"); return true; }
    catch { return false; }
  });
  assertDatabaseIsolation(await inspect(dbName));
  const apiOptions = ["--network", "container:" + dbName, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "1000:1000", "--cpus", "0.5"];
  containers.add(apiName);
  await run(dockerPath, ["run", "-d", "--name", apiName, ...common, ...apiOptions, "--memory", "128m", "--memory-swap", "128m",
    "--env", "PGHOST=127.0.0.1", "--env", "PGPORT=5432", "--env", "PGUSER=resource_lab",
    "--env", "PGDATABASE=resource_lab", "--env", "PGPASSWORD", release.ci.localImageId,
    "sh", "-c", "if [ -f migrate.js ]; then node migrate.js || exit 1; fi; exec node server.js"], { PGPASSWORD: password });
  containers.add(driverName);
  await docker("run", "-d", "--name", driverName, ...common, ...apiOptions, "--memory", "96m", "--memory-swap", "96m",
    "--tmpfs", "/lab:rw,noexec,nosuid,size=1048576,mode=1777", "--entrypoint", "sleep", release.ci.localImageId, "240");
  await installDriver();
  const target = "https://example.com/resource-lab";
  const link = JSON.parse(await docker("exec", driverName, "node", "-e", `
    (async()=>{let ready=false;for(let i=0;i<30;i++){
      try{const r=await fetch('http://127.0.0.1:8000/health',{signal:AbortSignal.timeout(1000)});
        await r.text();if(r.status===200){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,300));}
      if(!ready)throw Error('API not ready');
      const r=await fetch('http://127.0.0.1:8000/links',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({url:${JSON.stringify(target)}}),signal:AbortSignal.timeout(2000)});
      if(r.status!==201)throw Error('Link creation failed');console.log(JSON.stringify(await r.json()));
    })().catch(e=>{console.error(e.message);process.exit(1)})`));
  assert.match(link.short_path, /^\/[a-f0-9]{8}$/);
  report.isolation = { database: "temporary tmpfs PostgreSQL, network=none", sourceCredentialsUsed: false,
    publishedPorts: false, sameApplicationImage: release.ci.localImageId, databaseImage: pgImage,
    maximumTemporaryMemoryMiB: 480, generator: "separate container/cgroup sharing temporary network namespace",
    cpuOrder: [0.5, 0.05, 0.5], logging: "real application JSON logging with bounded Docker log rotation" };
  const load = { baseUrl: "http://127.0.0.1:8000", route: link.short_path, expectedStatus: 307,
    expectedLocation: target, durationMs: 8000, rate: 200, concurrency: 32, timeoutMs: 2000 };
  for (const [name, cpus] of [["normal", 0.5], ["restricted", 0.05], ["restored", 0.5]]) {
    checkBudget();
    console.log(`CPU comparison: ${name}, ${cpus} CPUs, 200 arrivals/s for 8s`);
    assertResourceContainer(await inspect(apiName), id, apiName);
    await docker("update", "--cpus", String(cpus), apiName);
    const quota = (await docker("exec", apiName, "cat", "/sys/fs/cgroup/cpu.max")).split(/\s+/).map(Number);
    assert.equal(quota[0] / quota[1], cpus);
    await docker("exec", driverName, "node", "/lab/resource-load.js", JSON.stringify({ ...load, durationMs: 1000, rate: 20 }));
    const beforeCpu = await counters(apiName);
    const beforeDbCpu = await counters(dbName);
    const beforeDriverCpu = await counters(driverName);
    const started = Date.now();
    const result = JSON.parse(await docker("exec", driverName, "node", "/lab/resource-load.js", JSON.stringify(load)));
    const afterCpu = await counters(apiName);
    const elapsedMs = Date.now() - started;
    const afterDbCpu = await counters(dbName);
    const afterDriverCpu = await counters(driverName);
    const observation = { name, cpus, cpuMax: quota, counterWindowMs: elapsedMs,
      summary: result.summary, apiCpu: cpuDelta(beforeCpu, afterCpu),
      databaseCpu: cpuDelta(beforeDbCpu, afterDbCpu), generatorCpu: cpuDelta(beforeDriverCpu, afterDriverCpu),
      apiMemory: await memory(apiName), databaseMemory: await memory(dbName), generatorMemory: await memory(driverName),
      rawCounters: { beforeCpu, afterCpu, beforeDbCpu, afterDbCpu, beforeDriverCpu, afterDriverCpu } };
    report.cpu.push(observation);
    await save("load-" + name + ".json", result);
    await save("report.json", report);
    assert.ok(result.summary.sent >= 500, "Insufficient arrivals; check generator evidence");
    checkBudget();
  }
  const container = await inspect(apiName);
  assert.ok(container.State.Running && !container.State.OOMKilled, "CPU comparison unexpectedly killed the API");
  report.cpuApiSurvived = true;
  await cleanupContainers();
}

async function isolatedOom() {
  report.phase = "memory";
  checkBudget();
  console.log("Memory experiment: one disposable Kubernetes Pod, 96Mi limit, no restart or persistent storage");
  const labels = { app: "resource-lab", "shortener.lab/resource-run": id };
  const services = JSON.parse(await kubectl("get", "services", "-o", "json"));
  for (const service of services.items) {
    const entries = Object.entries(service.spec.selector || {});
    assert.ok(!entries.length || !entries.every(([key, value]) => labels[key] === value), "Temporary Pod would enter a Service");
  }
  const code = `const fs=require('node:fs');const assert=require('node:assert/strict');
    const read=name=>fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim();
    assert.equal(Number(read('memory.max')),100663296);assert.equal(read('memory.swap.max'),'0');
    const report=()=>console.log(JSON.stringify({at:new Date().toISOString(),memoryCurrent:Number(read('memory.current')),
      memoryPeak:Number(read('memory.peak')),memoryMax:Number(read('memory.max')),memoryEvents:read('memory.events'),
      processMemory:process.memoryUsage()}));
    report();const retained=[];let count=0;
    const timer=setInterval(()=>{retained.push(Buffer.alloc(8*1024*1024,1));report();
      if(++count>=24){clearInterval(timer);process.exit(3);}},200);
    setTimeout(()=>process.exit(4),15000).unref();`;
  const manifest = { apiVersion: "v1", kind: "Pod", metadata: { name: oomName, namespace: "shortener", labels },
    spec: { restartPolicy: "Never", activeDeadlineSeconds: 45, terminationGracePeriodSeconds: 2,
      automountServiceAccountToken: false, enableServiceLinks: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{ name: "memory", image: release.imageRef, imagePullPolicy: "Never", command: ["node", "-e", code],
        resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "250m", memory: "96Mi" } },
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } } }] } };
  await save("oom-pod.json", manifest);
  oomAttempted = true;
  const created = JSON.parse(await kubectl("create", "-f", path.join(runDir, "oom-pod.json"), "-o", "json"));
  oomUid = created.metadata.uid;
  const pod = await until("memory Pod terminated", async () => {
    const current = await get("pod", oomName);
    assert.equal(current.metadata.uid, oomUid);
    return current.status.containerStatuses?.[0]?.state?.terminated
      && ["Failed", "Succeeded"].includes(current.status.phase) ? current : false;
  }, 50000);
  assertOomPod(pod, id, oomName);
  const rawLogs = await kubectl("logs", oomName, "-c", "memory", "--tail=40");
  await fs.writeFile(path.join(runDir, "oom.log"), rawLogs + "\n");
  const status = pod.status.containerStatuses[0];
  report.memory = { pod: oomName, uid: oomUid, phase: pod.status.phase, restartCount: status.restartCount,
    terminated: status.state.terminated, resources: manifest.spec.containers[0].resources,
    samples: rawLogs.split(/\r?\n/).filter(line => line.startsWith("{")).map(line => JSON.parse(line)),
    synthetic: true, applicationMemoryLeakProven: false };
  await save("oom-status.json", { metadata: { name: oomName, uid: oomUid }, status: pod.status });
  await save("report.json", report);
  assert.equal(status.state.terminated.reason, "OOMKilled", "Exit code alone does not establish a kernel OOM kill");
  assert.equal(status.state.terminated.exitCode, 137);
  assert.equal(status.restartCount, 0);
  assert.ok(report.memory.samples.length >= 2, "Missing pre-termination memory observations");
  await cleanupPod();
}

async function main() {
  process.on("SIGINT", () => { interrupted = true; });
  process.on("SIGTERM", () => { interrupted = true; });
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(temp, { recursive: true });
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lock = await fs.open(lockPath, "wx");
  try {
    await lock.writeFile(id);
    release = JSON.parse(await fs.readFile(path.join(project, ".releases", "last-success.json"), "utf8"));
    assert.equal(release.status, "succeeded");
    assert.match(release.ci.localImageId, /^sha256:[a-f0-9]{64}$/);
    assert.match(release.imageRef, /^localhost:5001\/shortener@sha256:[a-f0-9]{64}$/);
    assert.match(release.savedLink, /^\/[a-f0-9]{8}$/);
    assert.equal(JSON.parse(await docker("image", "inspect", release.image))[0].Id, release.ci.localImageId);
    before = await snapshot();
    assert.equal(before.deployment.spec.template.spec.containers.find(c => c.name === "api").image, release.imageRef);
    const memoryInfo = await docker("exec", "k3d-shortener-server-0", "cat", "/proc/meminfo");
    const availableKiB = Number(memoryInfo.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
    assert.ok(availableKiB >= 600 * 1024, "Need at least 600MiB available in the Docker VM before this drill");
    const conditions = JSON.parse(await kubectl("get", "node", "k3d-shortener-server-0", "-o", "json")).status.conditions;
    assert.ok(conditions.some(c => c.type === "Ready" && c.status === "True"));
    assert.ok(!conditions.some(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True"));
    report.before = before;
    report.preflight = { availableKiB, imageRef: release.imageRef, releaseId: release.id };
    assert.equal((await request(release.savedLink)).status, 307);
    console.log("Live baseline: at most 2 health requests/s, one concurrent request");
    const baseline = await measure({ baseUrl: report.liveService, route: "/health", durationMs: 3000,
      rate: 2, concurrency: 1, timeoutMs: 2000, expectedStatus: 200 });
    report.liveBaseline = baseline.summary;
    assert.equal(baseline.summary.failed, 0);
    monitoring = true;
    monitorTask = liveMonitor();
    await save("report.json", report);
    await isolatedCpu();
    await isolatedOom();
    report.status = "succeeded";
  } catch (error) {
    report.status = "failed";
    report.error = redactDiagnostics(error.message);
  } finally {
    const errors = [];
    for (const cleanup of [cleanupContainers, cleanupPod]) {
      try { await cleanup(); } catch (error) { errors.push(redactDiagnostics(error.message)); }
    }
    report.cleanup = { verified: errors.length === 0 && containers.size === 0, errors };
    monitoring = false;
    if (monitorTask) await monitorTask;
    if (before) {
      try {
        const after = await snapshot();
        assert.deepEqual(after, before, "Live Pod identity/restarts, specs, or PVC changed during the drill");
        assert.equal((await request("/health")).status, 200);
        assert.equal((await request(release.savedLink)).status, 307);
        assert.ok(report.liveChecks.every(check => check.status === 200), "At least one live health sample failed");
        report.recovery = { verified: true, podsUnchanged: true, restartsUnchanged: true, pvcUnchanged: true,
          liveSpecsUnchanged: true, existingLinkStatus: 307, healthStatus: 200, after };
      } catch (error) { report.recovery = { verified: false, error: redactDiagnostics(error.message) }; }
    }
    if (!report.cleanup.verified || !report.recovery?.verified) report.status = "failed";
    report.finishedAt = new Date().toISOString();
    try { await save("report.json", report); }
    finally {
      await lock.close();
      if ((await fs.readFile(lockPath, "utf8")) === id) await fs.unlink(lockPath);
    }
  }
  console.log(JSON.stringify({ status: report.status, report: path.join(runDir, "report.json"),
    cpu: report.cpu.map(item => ({ name: item.name, p95: item.summary.latencyMsAllAttempts.p95,
      throttledPeriodPercent: item.apiCpu.throttledPeriodPercent, failed: item.summary.failed })),
    memoryReason: report.memory?.terminated?.reason, cleanup: report.cleanup, recoveryVerified: report.recovery?.verified }, null, 2));
  assert.equal(report.status, "succeeded", report.error || report.recovery?.error || "Resource drill failed; inspect report");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
