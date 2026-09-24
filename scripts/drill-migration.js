const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { randomBytes, createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { titleMigration, migrationChecksum, assertMigrationContainer } = require("./migration-support");
const { summarySql, assertSameData, assertDatabaseIsolation } = require("./backup-support");
const { redactDiagnostics } = require("./ci-support");

const execute = promisify(execFile);
const project = path.resolve(__dirname, "..");
const root = path.dirname(project);
const temp = path.join(root, "tmp");
const id = "migration-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(4).toString("hex");
const runDir = path.join(project, ".incidents", id);
const lockPath = path.join(project, ".releases", "active.lock");
const dockerPath = process.platform === "win32" ? "docker.exe" : "docker";
const kubectlPath = path.join(root, "bin", "kubectl.exe");
const prefix = "shortener-migrate-" + randomBytes(6).toString("hex");
const names = { database: prefix + "-db", api: prefix + "-api", driver: prefix + "-driver" };
const attempted = new Set();
const report = { id, status: "started", phase: "preflight", startedAt: new Date().toISOString(), containers: names,
  liveService: "http://127.0.0.1:8081", published: false, liveDatabaseMigrated: false,
  availability: { successful: 0, failed: 0 } };
const deadline = Date.now() + 240000;
let interrupted = false;
let monitoring = false;
let monitorTask;
let baseline;
let liveData;
let release;
let historical;

const environment = extra => ({ ...process.env, TEMP: temp, TMP: temp, ...extra });
const save = (name, data) => fs.writeFile(path.join(runDir, name), JSON.stringify(data, null, 2) + "\n");
function checkBudget() {
  assert.ok(!interrupted, "Interrupted; cleaning up owned temporary resources");
  assert.ok(Date.now() < deadline, "Four-minute drill deadline exceeded");
  assert.ok(report.availability.failed < 2, "Live health degraded; stopping the drill");
}

async function run(executable, args, { env, timeout = 30000 } = {}) {
  try {
    const output = await execute(executable, args, { cwd: project, timeout, windowsHide: true,
      maxBuffer: 2 * 1024 * 1024, env: environment(env) });
    return output.stdout.trim();
  } catch (error) {
    throw new Error(redactDiagnostics(`${path.basename(executable)} ${args[0]} failed: ${error.stderr || error.message}`));
  }
}
const docker = (...args) => run(dockerPath, args);
const kubeArgs = (...args) => ["--kubeconfig", path.join(root, "kubeconfig.yaml"), "--cache-dir", path.join(root, ".kube-cache"),
  "--context=k3d-shortener", "--request-timeout=15s", "-n", "shortener", ...args];
const kubectl = (...args) => run(kubectlPath, kubeArgs(...args));

async function inputCommand(executable, args, input, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: project, windowsHide: true, env: environment(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on("data", chunk => {
      if (stdout.length + chunk.length > 2 * 1024 * 1024) { overflow = true; child.kill(); }
      else stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.stdin.on("error", () => {});
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0 && !overflow && !timedOut) resolve(stdout.trim());
      else reject(new Error(redactDiagnostics(`Command input failed (exit=${code}, timeout=${timedOut}, overflow=${overflow}): ${stderr}`)));
    });
    child.stdin.end(input);
  });
}

async function liveRequest(route) {
  const response = await fetch(report.liveService + route, { redirect: "manual", signal: AbortSignal.timeout(3000) });
  const body = await response.text();
  return { status: response.status, body, location: response.headers.get("location") };
}

async function monitor() {
  while (monitoring) {
    try {
      assert.equal((await liveRequest("/health")).status, 200);
      report.availability.successful++;
    } catch { report.availability.failed++; }
    if (monitoring) await delay(750);
  }
}

async function snapshot() {
  const deployment = JSON.parse(await kubectl("get", "deployment", "api", "-o", "json"));
  const database = JSON.parse(await kubectl("get", "statefulset", "db", "-o", "json"));
  const pvc = JSON.parse(await kubectl("get", "pvc", "data-db-0", "-o", "json"));
  const pods = JSON.parse(await kubectl("get", "pods", "-l", "app in (api,db)", "-o", "json")).items
    .map(p => ({ name: p.metadata.name, uid: p.metadata.uid,
      ready: p.status.conditions?.some(c => c.type === "Ready" && c.status === "True"),
      restarts: p.status.containerStatuses?.reduce((total, c) => total + c.restartCount, 0) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(deployment.spec.replicas, 2);
  assert.equal(deployment.status.observedGeneration, deployment.metadata.generation);
  assert.equal(deployment.status.availableReplicas, 2);
  assert.equal(deployment.status.updatedReplicas, 2);
  assert.equal(database.spec.replicas, 1);
  assert.equal(database.status.readyReplicas, 1);
  assert.equal(pvc.status.phase, "Bound");
  assert.equal(pods.length, 3);
  assert.ok(pods.every(p => p.ready));
  return { deployment: { uid: deployment.metadata.uid, generation: deployment.metadata.generation, spec: deployment.spec },
    database: { uid: database.metadata.uid, generation: database.metadata.generation, spec: database.spec },
    pvc: { uid: pvc.metadata.uid, volume: pvc.spec.volumeName }, pods };
}

async function liveSummary() {
  const args = kubeArgs("exec", "-i", "db-0", "--", "sh", "-c",
    'exec psql -X -q -A -t -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"');
  const sql = "BEGIN READ ONLY;\nSET LOCAL statement_timeout='3000ms';\n" + summarySql + "\nCOMMIT;\n";
  return JSON.parse(await inputCommand(kubectlPath, args, sql));
}

async function inspect(name) {
  const format = '{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Labels":{{json .Config.Labels}}},'
    + '"Mounts":{{json .Mounts}},"HostConfig":{{json .HostConfig}},"State":{{json .State}},"RestartCount":{{json .RestartCount}}}';
  return JSON.parse(await docker("inspect", "--format", format, name));
}

async function cleanup() {
  const errors = [];
  const removed = [];
  for (const name of [...attempted].reverse()) {
    try {
      if (await docker("ps", "-aq", "--filter", "name=^/" + name + "$")) {
        assertMigrationContainer(await inspect(name), id, name);
        await docker("rm", "--force", name);
        assert.equal(await docker("ps", "-aq", "--filter", "name=^/" + name + "$"), "");
        removed.push(name);
      }
      attempted.delete(name);
    } catch (error) { errors.push(error.message); }
  }
  return { verified: attempted.size === 0 && errors.length === 0, removed, errors };
}

async function until(label, check) {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    checkBudget();
    if (await check()) return;
    await delay(500);
  }
  throw new Error("Timed out: " + label);
}

async function apiReady() {
  await docker("exec", names.driver, "node", "-e", `
    (async()=>{for(let i=0;i<30;i++){
      try{const r=await fetch('http://127.0.0.1:8000/health',{signal:AbortSignal.timeout(1000)});
        const body=await r.json();if(r.status===200&&body.database==='ok')return;}catch{}
      await new Promise(r=>setTimeout(r,400));}process.exit(1)})()`);
}

async function startIsolated() {
  checkBudget();
  const password = randomBytes(24).toString("hex");
  const pgImage = JSON.parse(await docker("image", "inspect", "postgres:17-alpine"))[0].Id;
  const common = ["--pull=never", "--platform=linux/amd64", "--label", "shortener.lab/migration-run=" + id,
    "--no-healthcheck", "--pids-limit", "64", "--log-opt", "max-size=2m", "--log-opt", "max-file=1", "--cpus", "0.5"];
  attempted.add(names.database);
  await run(dockerPath, ["run", "-d", "--name", names.database, ...common, "--network", "none",
    "--memory", "256m", "--memory-swap", "256m", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=134217728",
    "--env", "POSTGRES_USER=migration_lab", "--env", "POSTGRES_DB=migration_lab", "--env", "POSTGRES_PASSWORD",
    pgImage, "postgres", "-c", "shared_buffers=16MB", "-c", "max_connections=15"], { env: { POSTGRES_PASSWORD: password } });
  await until("temporary database ready", async () => {
    try { await docker("exec", names.database, "pg_isready", "-h", "127.0.0.1", "-U", "migration_lab"); return true; }
    catch { return false; }
  });
  assertDatabaseIsolation(await inspect(names.database));
  assert.match(id, /^migration-\d{4}-\d{2}-\d{2}T[\dZ-]+-[a-f0-9]{8}$/);
  await inputCommand(dockerPath, ["exec", "-i", names.database, "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-U", "migration_lab", "-d", "migration_lab"],
  `CREATE TABLE public.lab_instance (run_id TEXT PRIMARY KEY); INSERT INTO public.lab_instance VALUES ('${id}');\n`);
  const appOptions = ["--network", "container:" + names.database, "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--user", "1000:1000", "--memory", "128m", "--memory-swap", "128m",
    "--env", "PGHOST=127.0.0.1", "--env", "PGPORT=5432", "--env", "PGDATABASE=migration_lab",
    "--env", "PGUSER=migration_lab", "--env", "PGPASSWORD"];
  attempted.add(names.api);
  await run(dockerPath, ["run", "-d", "--name", names.api, ...common, ...appOptions, historical.ci.localImageId],
    { env: { PGPASSWORD: password } });
  attempted.add(names.driver);
  await run(dockerPath, ["run", "-d", "--name", names.driver, ...common, ...appOptions,
    "--env", "LAB_MIGRATION_RUN=" + id, "--tmpfs", "/app/lab:rw,noexec,nosuid,size=2097152,mode=1777",
    "--entrypoint", "sleep", historical.ci.localImageId, "210"], { env: { PGPASSWORD: password } });
  const fileMap = { "migration-support.js": "scripts/migration-support.js",
    "migration-integration.cjs": "test/fixtures/migration-integration.cjs" };
  const files = [];
  report.fixtureFiles = [];
  for (const [name, relative] of Object.entries(fileMap)) {
    const bytes = await fs.readFile(path.join(project, relative));
    files.push({ name, data: bytes.toString("base64") });
    report.fixtureFiles.push({ file: relative, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await inputCommand(dockerPath, ["exec", "-i", names.driver, "node", "-e", `
    const fs=require('node:fs');const assert=require('node:assert/strict');
    for(const file of JSON.parse(fs.readFileSync(0,'utf8'))){
      assert.ok(['migration-support.js','migration-integration.cjs'].includes(file.name));
      fs.writeFileSync('/app/lab/'+file.name,Buffer.from(file.data,'base64'),{flag:'wx'});
    }`], JSON.stringify(files));
  await apiReady();
  report.isolation = { databaseImage: pgImage, applicationImage: historical.ci.localImageId,
    databaseNetwork: "none", publishedPorts: false, persistentMounts: false, liveCredentialsUsedInFixtures: false,
    maxTemporaryMemoryMiB: 512, migrationTarget: "new disposable migration_lab database with verified ownership marker" };
}

async function fixture(mode, previous) {
  checkBudget();
  const args = ["exec", names.driver, "node", "/app/lab/migration-integration.cjs", mode];
  if (previous) args.push(JSON.stringify(previous));
  // Save structured failure evidence even when the fixture intentionally exits nonzero.
  let stdout;
  let error;
  try {
    stdout = (await execute(dockerPath, args, { cwd: project, timeout: 70000, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, env: environment() })).stdout;
  } catch (failure) { stdout = failure.stdout; error = redactDiagnostics(failure.stderr || failure.message); }
  let data;
  try { data = JSON.parse(stdout); }
  catch { throw new Error(error || "Migration fixture did not return a JSON report"); }
  await save(mode + ".json", data);
  assert.equal(data.status, "succeeded", data.error?.message || error || "Fixture failed");
  assert.ok(!error, error);
  return data;
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
    historical = JSON.parse(await fs.readFile(path.join(project, ".releases", "2026-09-24T07-32-06-530Z-bf2b4817", "report.json"), "utf8"));
    assert.equal(historical.status, "succeeded");
    assert.equal(historical.expectedVersion, "3.2.0");
    assert.match(historical.ci.localImageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.parse(await docker("image", "inspect", historical.image))[0].Id, historical.ci.localImageId);
    assert.equal(release.status, "succeeded");
    assert.match(release.ci.localImageId, /^sha256:[a-f0-9]{64}$/);
    assert.match(release.savedLink, /^\/[a-f0-9]{8}$/);
    assert.equal(JSON.parse(await docker("image", "inspect", release.image))[0].Id, release.ci.localImageId);
    baseline = await snapshot();
    assert.equal(baseline.deployment.spec.template.spec.containers.find(c => c.name === "api").image, release.imageRef);
    const mem = await docker("exec", "k3d-shortener-server-0", "cat", "/proc/meminfo");
    const availableKiB = Number(mem.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
    assert.ok(availableKiB >= 600 * 1024, "Need at least 600MiB available in the Docker VM");
    const node = JSON.parse(await kubectl("get", "node", "k3d-shortener-server-0", "-o", "json"));
    assert.ok(node.status.conditions.some(c => c.type === "Ready" && c.status === "True"));
    assert.ok(!node.status.conditions.some(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True"));
    liveData = await liveSummary();
    report.before = { cluster: baseline, data: liveData, availableKiB };
    report.releaseId = release.id;
    report.migration = { ...titleMigration, checksum: migrationChecksum(titleMigration) };
    assert.equal((await liveRequest("/health")).status, 200);
    assert.equal((await liveRequest(release.savedLink)).status, 307);
    monitoring = true;
    monitorTask = monitor();
    console.log("Creating isolated migration database and accepted old API image");
    report.phase = "isolation";
    await startIsolated();
    await save("report.json", report);
    console.log("Verifying locks, DDL rollback, idempotency, mixed clients, and unsafe NOT NULL regression");
    report.phase = "compatibility";
    report.exercise = await fixture("exercise");
    await save("report.json", report);
    checkBudget();
    console.log("Restarting ONLY the disposable old API and verifying expanded-schema compatibility");
    report.phase = "old-binary-restart";
    const beforeRestart = await inspect(names.api);
    assertMigrationContainer(beforeRestart, id, names.api);
    await docker("restart", "--timeout", "10", names.api);
    await apiReady();
    const afterRestart = await inspect(names.api);
    assert.equal(afterRestart.Id, beforeRestart.Id);
    assert.ok(afterRestart.State.Running && !afterRestart.State.OOMKilled);
    assert.notEqual(afterRestart.State.StartedAt, beforeRestart.State.StartedAt);
    report.restart = await fixture("verify-old-restart", report.exercise);
    report.status = "succeeded";
  } catch (error) {
    report.status = "failed";
    report.error = redactDiagnostics(error.message);
  } finally {
    try { report.cleanup = await cleanup(); }
    catch (error) { report.cleanup = { verified: false, error: error.message }; }
    monitoring = false;
    if (monitorTask) await monitorTask;
    if (baseline && liveData) {
      try {
        const after = await snapshot();
        assert.deepEqual(after, baseline, "Live specifications, Pod identities, restarts or PVC changed");
        const afterData = await liveSummary();
        assertSameData(liveData, afterData);
        assert.equal((await liveRequest("/health")).status, 200);
        assert.equal((await liveRequest(release.savedLink)).status, 307);
        assert.equal(report.availability.failed, 0);
        report.recovery = { verified: true, liveDataAndSchemaUnchanged: true, rowCount: afterData.rowCount,
          dataSha256: afterData.dataSha256, livePodsAndRestartsUnchanged: true, liveSpecsUnchanged: true,
          pvcUnchanged: true, existingLinkStatus: 307, healthStatus: 200 };
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
    checks: report.exercise?.checks, migration: report.exercise?.migration,
    oldApiDuringExpansion: report.exercise?.oldApiDuringExpansion?.successfulWrites,
    mixedClients: report.exercise?.mixedClients, restart: report.restart?.oldBinaryRestart,
    availability: report.availability, cleanup: report.cleanup, recovery: report.recovery }, null, 2));
  assert.equal(report.status, "succeeded", report.error || report.recovery?.error || "Migration drill failed");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
