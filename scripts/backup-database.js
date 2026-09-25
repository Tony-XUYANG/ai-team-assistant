const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const { randomUUID, randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { pipeline } = require("node:stream/promises");
const { setTimeout: delay } = require("node:timers/promises");
const { parseArgs, promisify } = require("node:util");
const { summarySql, migrationSummarySql, projectSummarySql, validateBackupTables, backupDirectory, checksum, verifyArchive, validateManifest, assertSameData, assertOwnedContainer, assertDatabaseIsolation } = require("./backup-support");

const execute = promisify(execFile);
const projectDir = path.resolve(__dirname, "..");
const root = path.resolve(projectDir, "..");
const backupRoot = path.join(projectDir, ".backups");
const tempDir = path.join(root, "tmp");
const lockPath = path.join(projectDir, ".releases", "active.lock");
const kubectlPath = path.join(root, "bin", "kubectl.exe");
const baseUrl = "http://127.0.0.1:8081";
const { values } = parseArgs({ options: { verify: { type: "string" } } });
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
const backupId = values.verify || "backup-" + stamp();
const directory = backupDirectory(backupRoot, backupId);
const verificationId = "verify-" + stamp();
const runDir = path.join(directory, "verifications", verificationId);
const suffix = randomBytes(6).toString("hex");
const dbName = "shortener-restore-db-" + suffix;
const apiName = "shortener-restore-api-" + suffix;
const report = { backupId, verificationId, startedAt: new Date().toISOString(),
  mode: values.verify ? "verify-existing" : "backup-and-verify", status: "started",
  containers: { database: dbName, api: apiName }, availability: { successful: 0, failed: 0 } };
const containerAttempts = [];
let stopMonitor = false;
let interrupted = false;
let monitor;
let baseline;
let manifest;
let snapshot;
process.on("SIGINT", () => { interrupted = true; });
process.on("SIGTERM", () => { interrupted = true; });

function env(extra = {}) { return { ...process.env, TEMP: tempDir, TMP: tempDir, ...extra }; }
function checkInterrupt() { assert.ok(!interrupted, "Interrupted; cleaning up isolated verification resources"); }
async function save(file, data) { await fs.writeFile(file, JSON.stringify(data, null, 2)); }
async function run(executable, args, options = {}) {
  const { env: extraEnv, ...rest } = options;
  const started = Date.now();
  try {
    const result = await execute(executable, args, { cwd: projectDir, windowsHide: true,
      timeout: 90000, maxBuffer: 1024 * 1024, ...rest, env: env(extraEnv) });
    await fs.appendFile(path.join(runDir, "commands.log"), `${path.basename(executable)} ${args.join(" ")} [${Date.now() - started}ms, OK]\n`);
    return result.stdout.trim();
  } catch (error) {
    await fs.appendFile(path.join(runDir, "commands.log"), `${path.basename(executable)} ${args.join(" ")} [FAILED]\n`);
    throw new Error(`${path.basename(executable)} ${args[0]} failed: ${(error.stderr || error.message).trim()}`);
  }
}

const kubeArgs = (...args) => ["--kubeconfig", path.join(root, "kubeconfig.yaml"),
  "--cache-dir", path.join(root, ".kube-cache"), "--context=k3d-shortener",
  "--request-timeout=30s", "-n", "shortener", ...args];
const kubectl = (...args) => run(kubectlPath, kubeArgs(...args));
const docker = (...args) => run("docker.exe", args);

async function request(route, options = {}) {
  const response = await fetch(baseUrl + route, {
    redirect: "manual", signal: AbortSignal.timeout(5000), ...options,
    headers: { Connection: "close", "Content-Type": "application/json", ...options.headers },
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

async function monitorAvailability() {
  while (!stopMonitor) {
    try { assert.equal((await request("/health")).status, 200); report.availability.successful++; }
    catch { report.availability.failed++; }
    if (!stopMonitor) await delay(750);
  }
}

async function clusterState() {
  const deployment = JSON.parse(await kubectl("get", "deployment", "api", "-o", "json"));
  const db = JSON.parse(await kubectl("get", "statefulset", "db", "-o", "json"));
  const pvc = JSON.parse(await kubectl("get", "pvc", "data-db-0", "-o", "json"));
  const pods = JSON.parse(await kubectl("get", "pods", "-o", "json")).items
    .filter(pod => ["api", "db"].includes(pod.metadata.labels?.app) && !pod.metadata.deletionTimestamp)
    .map(pod => ({ name: pod.metadata.name, uid: pod.metadata.uid,
      ready: pod.status.conditions?.find(c => c.type === "Ready")?.status === "True",
      restarts: pod.status.containerStatuses?.reduce((sum, c) => sum + c.restartCount, 0) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(deployment.status.observedGeneration, deployment.metadata.generation);
  assert.equal(deployment.status.availableReplicas, deployment.spec.replicas);
  assert.equal(deployment.status.updatedReplicas, deployment.spec.replicas);
  assert.equal(db.spec.replicas, 1);
  assert.equal(db.status.readyReplicas, 1);
  assert.ok(pods.length === deployment.spec.replicas + 1 && pods.every(pod => pod.ready));
  return { deploymentUid: deployment.metadata.uid, deploymentGeneration: deployment.metadata.generation,
    databaseUid: db.metadata.uid, databaseGeneration: db.metadata.generation,
    pvcUid: pvc.metadata.uid, volume: pvc.spec.volumeName, pods,
    image: deployment.spec.template.spec.containers.find(c => c.name === "api").image };
}

// Attach completion/error handlers immediately, including for long-lived psql sessions.
function childProcess(executable, args, timeout = 90000) {
  const child = spawn(executable, args, { cwd: projectDir, windowsHide: true, env: env(), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
  child.stdin.on("error", () => {});
  const timer = setTimeout(() => child.kill(), timeout);
  const completion = new Promise(resolve => {
    child.once("error", error => resolve({ code: -1, stderr: error.message }));
    child.once("close", code => resolve({ code, stderr }));
  }).finally(() => clearTimeout(timer));
  return { child, completion };
}

async function streamCommand(executable, args, { inputFile, outputFile, inputText } = {}) {
  const process = childProcess(executable, args);
  const chunks = [];
  let outputBytes = 0;
  const output = outputFile
    ? pipeline(process.child.stdout, createWriteStream(outputFile, { flags: "wx", mode: 0o600 }))
    : (async () => {
      for await (const chunk of process.child.stdout) {
        outputBytes += chunk.length;
        assert.ok(outputBytes <= 1024 * 1024, "Unexpectedly large command response");
        chunks.push(chunk);
      }
    })();
  const input = inputFile ? pipeline(createReadStream(inputFile), process.child.stdin)
    : new Promise(resolve => { process.child.stdin.end(inputText || "", resolve); });
  const streams = await Promise.allSettled([input, output]);
  if (streams.some(item => item.status === "rejected")) process.child.kill();
  const result = await process.completion;
  assert.equal(result.code, 0, `${path.basename(executable)} stream failed: ${result.stderr}`);
  for (const stream of streams) if (stream.status === "rejected") throw stream.reason;
  if (result.stderr) await fs.appendFile(path.join(runDir, "stream-warnings.log"), result.stderr + "\n");
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function openSnapshot() {
  const process = childProcess(kubectlPath, kubeArgs("exec", "-i", "db-0", "-c", "postgres", "--", "sh", "-c",
    'exec psql -X -q -A -t -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"'), 120000);
  const lines = createInterface({ input: process.child.stdout, crlfDelay: Infinity });
  const messages = [];
  lines.on("line", line => { if (line.trim()) messages.push(line); });
  process.child.stdin.write(`
    BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SET LOCAL statement_timeout='15s';
    SET LOCAL idle_in_transaction_session_timeout='90s';
    SELECT jsonb_build_object('snapshot',pg_export_snapshot(),'capturedAt',clock_timestamp(),
      'database',current_database(),'serverVersion',current_setting('server_version'),
      'tableBytes',(SELECT sum(pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename)))
        FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')),
      'tables',(SELECT json_agg(schemaname||'.'||tablename ORDER BY schemaname,tablename)
        FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')));
  `);
  const waitMessages = async count => {
    const deadline = Date.now() + 20000;
    while (messages.length < count) {
      assert.equal(process.child.exitCode, null, "Snapshot session exited before capture");
      assert.ok(Date.now() < deadline, "Snapshot capture timed out");
      checkInterrupt();
      await delay(100);
    }
    return JSON.parse(messages[count - 1]);
  };
  const close = async () => {
    process.child.stdin.end("ROLLBACK;\n");
    const result = await process.completion;
    lines.close();
    assert.equal(result.code, 0, "Snapshot session failed: " + result.stderr);
  };
  try {
    report.phase = "snapshot-metadata";
    const metadata = await waitMessages(1);
    assert.match(metadata.snapshot, /^[A-Fa-f0-9]+-[A-Fa-f0-9]+-\d+$/);
    const hasMigrations = validateBackupTables(metadata.tables);
    assert.ok(metadata.tableBytes < 16 * 1024 * 1024, "Use a streaming verification design for larger datasets");
    process.child.stdin.write(summarySql + "\n");
    report.phase = "snapshot-summary";
    const summary = await waitMessages(2);
    if (hasMigrations) {
      process.child.stdin.write(migrationSummarySql + "\n");
      summary.migrations = await waitMessages(3);
    }
    if (metadata.tables.includes("public.projects")) {
      summary.projects = {};
      let count = 3;
      for (const table of ["projects", "project_entries"]) {
        process.child.stdin.write(projectSummarySql(table) + "\n");
        summary.projects[table] = await waitMessages(++count);
      }
    }
    return { metadata, summary, close };
  } catch (error) {
    process.child.stdin.end("ROLLBACK;\n");
    process.child.kill();
    await process.completion;
    lines.close();
    throw error;
  }
}

async function createBackup() {
  const target = "https://example.com/backup-before/" + suffix;
  const before = await request("/links", { method: "POST", body: JSON.stringify({ url: target }) });
  assert.equal(before.status, 201);
  const link = JSON.parse(before.body);
  snapshot = await openSnapshot();
  console.log(`Backing up snapshot with ${snapshot.summary.rowCount} links`);
  const partial = path.join(directory, "database.dump.partial");
  report.phase = "dump";
  const started = Date.now();
  await streamCommand(kubectlPath, kubeArgs("exec", "db-0", "-c", "postgres", "--", "sh", "-c",
    'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl --lock-wait-timeout=5s --snapshot="$1"',
    "backup-database", snapshot.metadata.snapshot), { outputFile: partial });
  const source = { ...snapshot.metadata, summary: snapshot.summary };
  await snapshot.close();
  snapshot = undefined;
  const archive = { file: "database.dump", ...await checksum(partial) };
  assert.ok(archive.bytes > 5, "Empty backup");
  await fs.rename(partial, path.join(directory, archive.file));
  manifest = { formatVersion: 1, backupId, createdAt: new Date().toISOString(),
    context: "k3d-shortener", namespace: "shortener", archive, source,
    application: { ...report.images, version: report.applicationVersion,
      platformManifest: report.applicationManifest },
    beforeBackup: { code: link.code, target }, dumpDurationMs: Date.now() - started };
  await save(path.join(directory, "backup.json"), manifest);
  const afterTarget = "https://example.com/backup-after/" + suffix;
  const after = await request("/links", { method: "POST", body: JSON.stringify({ url: afterTarget }) });
  assert.equal(after.status, 201);
  manifest.afterBackup = { code: JSON.parse(after.body).code, target: afterTarget, createdAt: new Date().toISOString() };
  await save(path.join(directory, "backup.json"), manifest);
  return manifest;
}

async function inspectContainer(name) {
  const ids = (await docker("ps", "-aq", "--filter", "name=^/" + name + "$")) .split(/\s+/).filter(Boolean);
  if (!ids.length) return null;
  assert.equal(ids.length, 1);
  return JSON.parse(await docker("inspect", name))[0];
}

async function cleanup() {
  const removed = [];
  for (const name of [...containerAttempts].reverse()) {
    const container = await inspectContainer(name);
    if (!container) continue;
    assertOwnedContainer(container, verificationId, name);
    await docker("rm", "--force", name);
    assert.equal(await inspectContainer(name), null);
    removed.push(name);
  }
  return { verified: true, removed };
}

async function waitDatabase() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    checkInterrupt();
    try {
      await docker("exec", dbName, "pg_isready", "-h", "127.0.0.1", "-U", "restore_lab", "-d", "restore_lab");
      return;
    } catch { await delay(500); }
  }
  throw new Error("Isolated restore database did not start");
}

async function verifyRestoration() {
  report.phase = "verify-archive";
  validateManifest(manifest);
  const archivePath = await verifyArchive(directory, manifest);
  report.archiveVerified = { ...manifest.archive };
  const password = randomBytes(24).toString("hex");
  const restoreStarted = Date.now();
  const label = "shortener.lab/restore-run=" + verificationId;
  containerAttempts.push(dbName);
  report.phase = "create-isolated-database";
  await run("docker.exe", ["run", "-d", "--pull=never", "--name", dbName, "--label", label,
    "--platform", "linux/amd64",
    "--network", "none", "--memory", "256m", "--cpus", "0.5", "--pids-limit", "128",
    "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=134217728",
    "--env", "POSTGRES_USER=restore_lab", "--env", "POSTGRES_DB=restore_lab", "--env", "POSTGRES_PASSWORD",
    report.images.postgres, "postgres", "-c", "shared_buffers=16MB", "-c", "max_connections=15"],
    { env: { POSTGRES_PASSWORD: password } });
  await waitDatabase();
  const container = await inspectContainer(dbName);
  assertOwnedContainer(container, verificationId, dbName);
  assertDatabaseIsolation(container);
  const mount = (await docker("exec", dbName, "cat", "/proc/mounts")).split(/\r?\n/)
    .map(line => line.split(" ")).find(fields => fields[1] === "/var/lib/postgresql/data");
  assert.equal(mount?.[2], "tmpfs", "Verify the actual Linux mount, not only Docker configuration");
  report.isolation = { network: "none", publishedPorts: [], storage: "tmpfs",
    linuxMountVerified: true, sourceCredentialsUsed: false };
  const sqlArgs = ["exec", "-i", dbName, "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "restore_lab", "-d", "restore_lab"];
  const empty = await streamCommand("docker.exe", sqlArgs, { inputText: "SELECT count(*) FROM pg_tables WHERE schemaname='public';\n" });
  assert.equal(empty, "0", "Restore target must be empty");
  console.log("Restoring archive into isolated PostgreSQL (no ports, no production credentials)");
  const restoreArgs = ["exec", "-i", dbName, "pg_restore", "--exit-on-error", "--single-transaction",
    "--no-owner", "--no-acl", "--username=restore_lab", "--dbname=restore_lab"];
  const started = Date.now();
  report.phase = "restore";
  await streamCommand("docker.exe", restoreArgs, { inputFile: archivePath });
  report.restoreDurationMs = Date.now() - started;
  const restored = JSON.parse(await streamCommand("docker.exe", sqlArgs, { inputText: summarySql + "\n" }));
  if (manifest.source.summary.migrations) {
    restored.migrations = JSON.parse(await streamCommand("docker.exe", sqlArgs, { inputText: migrationSummarySql + "\n" }));
  }
  if (manifest.source.summary.projects) {
    restored.projects = {};
    for (const table of ["projects", "project_entries"]) {
      restored.projects[table] = JSON.parse(await streamCommand("docker.exe", sqlArgs, { inputText: projectSummarySql(table) + "\n" }));
    }
  }
  report.phase = "compare-data";
  assertSameData(manifest.source.summary, restored);
  report.dataVerification = { rowCount: restored.rowCount, dataSha256: restored.dataSha256,
    recordsMatch: true, columnsMatch: true, constraintsMatch: true, indexesMatch: true,
    titleDataSha256: restored.titleDataSha256,
    titlesVerified: typeof manifest.source.summary.titleDataSha256 === "string",
    migrationLedgerVerified: Boolean(manifest.source.summary.migrations),
    migrationLedger: restored.migrations, projectsVerified: Boolean(manifest.source.summary.projects),
    projects: restored.projects };
  report.timeToVerifiedDataMs = Date.now() - restoreStarted;
  checkInterrupt();
  containerAttempts.push(apiName);
  report.phase = "verify-application";
  await run("docker.exe", ["run", "-d", "--pull=never", "--name", apiName, "--label", label,
    "--platform", "linux/amd64",
    "--network", "container:" + dbName, "--memory", "128m", "--cpus", "0.5", "--pids-limit", "64",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
    "--env", "PGHOST=127.0.0.1", "--env", "PGPORT=5432", "--env", "PGUSER=restore_lab",
    "--env", "PGDATABASE=restore_lab", "--env", "PGPASSWORD", report.images.application],
    { env: { PGPASSWORD: password } });
  const probe = `
    const assert = require('node:assert/strict');
    const {setTimeout:delay} = require('node:timers/promises');
    (async()=>{
      const base='http://127.0.0.1:8000';
      let healthy=false;
      for(let i=0;i<30;i++) {
        try {const r=await fetch(base+'/health',{signal:AbortSignal.timeout(2000)}); await r.text(); if(r.status===200){healthy=true;break;}} catch {}
        await delay(300);
      }
      assert.ok(healthy,'Restored application must become healthy');
      const before=await fetch(base+'/${manifest.beforeBackup.code}',{redirect:'manual',signal:AbortSignal.timeout(3000)});
      assert.equal(before.status,307); assert.equal(before.headers.get('location'),${JSON.stringify(manifest.beforeBackup.target)}); await before.text();
      let afterStatus=null;
      ${manifest.afterBackup ? `const after=await fetch(base+'/${manifest.afterBackup.code}',{redirect:'manual',signal:AbortSignal.timeout(3000)}); afterStatus=after.status; await after.text(); assert.equal(afterStatus,404);` : ""}
      const created=await fetch(base+'/links',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com/restored-write'}),signal:AbortSignal.timeout(3000)});
      assert.equal(created.status,201); const link=await created.json();
      const redirect=await fetch(base+link.short_path,{redirect:'manual',signal:AbortSignal.timeout(3000)});
      assert.equal(redirect.status,307); assert.equal(redirect.headers.get('location'),'https://example.com/restored-write'); await redirect.text();
      const version=await fetch(base+'/version',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
      assert.equal(version.version,${JSON.stringify(manifest.application.version)});
      console.log(JSON.stringify({health:200,beforeBackupLink:307,afterBackupLink:afterStatus,newLink:201,newLinkRedirect:307,version:version.version}));
    })().catch(error=>{console.error(error.message);process.exit(1)});`;
  report.applicationVerification = JSON.parse(await docker("exec", apiName, "node", "-e", probe));
  report.timeToVerifiedApplicationMs = Date.now() - restoreStarted;
  console.log(`Verified ${restored.rowCount} complete records, schema/indexes, old-link redirect and new writes`);
}

async function main() {
  assert.equal(path.parse(root).root.toLowerCase(), "e:\\", "Keep this lab and generated files on E:");
  await fs.mkdir(tempDir, { recursive: true });
  if (!values.verify) {
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.mkdir(directory);
    const sid = (await execute("powershell.exe", ["-NoProfile", "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true, env: env() })).stdout.trim();
    assert.match(sid, /^S-1-5-\d+(?:-\d+)+$/);
    await execute("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true, env: env() });
  } else {
    manifest = JSON.parse(await fs.readFile(path.join(directory, "backup.json"), "utf8"));
    assert.equal(manifest.backupId, backupId);
    validateManifest(manifest);
    await verifyArchive(directory, manifest);
  }
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lock = await fs.open(lockPath, "wx");
  let cleanupSucceeded = true;
  try {
    await lock.writeFile(verificationId);
    baseline = await clusterState();
    report.before = baseline;
    const version = await request("/version");
    assert.equal(version.status, 200);
    report.applicationVersion = JSON.parse(version.body).version;
    const accepted = JSON.parse(await fs.readFile(path.join(projectDir, ".releases", "last-success.json"), "utf8"));
    assert.equal(accepted.imageRef, baseline.image, "Live app does not match accepted image");
    const appImage = values.verify ? manifest.application.application : accepted.image;
    const appInspection = JSON.parse(await docker("image", "inspect", appImage))[0];
    const pgInspection = JSON.parse(await docker("image", "inspect", values.verify ? manifest.application.postgres : "postgres:17-alpine"))[0];
    if (!values.verify) {
      assert.ok(appInspection.RepoTags.includes(accepted.image));
      assert.equal(report.applicationVersion, accepted.expectedVersion);
      const platformImage = JSON.parse(await docker("image", "inspect", "--platform=linux/amd64", appImage))[0];
      assert.equal(platformImage.Descriptor.digest, baseline.image.split("@")[1],
        "Local platform manifest does not match the deployed image");
      report.applicationManifest = platformImage.Descriptor.digest;
    }
    report.images = { application: appInspection.Id, postgres: pgInspection.Id };
    report.tools = { source: await kubectl("exec", "db-0", "-c", "postgres", "--", "pg_dump", "--version"),
      restore: await docker("run", "--rm", "--pull=never", "--network", "none", "--entrypoint", "pg_restore", pgInspection.Id, "--version") };
    assert.match(report.tools.source, /PostgreSQL\) 17\./);
    assert.match(report.tools.restore, /PostgreSQL\) 17\./);
    monitor = monitorAvailability();
    checkInterrupt();
    if (!values.verify) await createBackup();
    await verifyRestoration();
    checkInterrupt();
    report.checksPassed = true;
  } catch (error) {
    report.error = error.message;
    report.status = "failed";
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    if (snapshot) {
      try { await snapshot.close(); } catch (error) { report.snapshotCloseError = error.message; process.exitCode = 1; }
    }
    try { report.cleanup = await cleanup(); }
    catch (error) { cleanupSucceeded = false; report.cleanup = { verified: false, error: error.message }; process.exitCode = 1; }
    if (baseline) {
      try {
        report.after = await clusterState();
        assert.deepEqual(report.after, baseline, "Live cluster objects or processes changed during verification");
        assert.equal((await request("/health")).status, 200);
        for (const link of [manifest?.beforeBackup, manifest?.afterBackup].filter(Boolean)) {
          const response = await request("/" + link.code);
          assert.equal(response.status, 307);
          assert.equal(response.location, link.target);
        }
        report.sourceWorkloadsUnchanged = true;
        report.sourceMarkersVerified = true;
      } catch (error) { report.sourceCheckError = error.message; process.exitCode = 1; }
    }
    stopMonitor = true;
    if (monitor) await monitor;
    if (report.availability.failed > 0) { report.availabilityError = "Live health samples failed"; process.exitCode = 1; }
    report.status = report.checksPassed && report.cleanup?.verified && report.sourceWorkloadsUnchanged
      && report.sourceMarkersVerified && !process.exitCode ? "succeeded" : "failed";
    if (report.status === "succeeded") report.phase = "completed";
    report.finishedAt = new Date().toISOString();
    await save(path.join(runDir, "report.json"), report);
    if (report.status === "succeeded") await save(path.join(directory, "last-verification.json"), report);
    await lock.close();
    if (cleanupSucceeded) await fs.unlink(lockPath);
    console.log(`RESULT: ${report.status}; live health ${report.availability.successful} passed, ${report.availability.failed} failed`);
    console.log((manifest ? "Backup: " : "Attempt directory: ") + (manifest ? path.join(directory, "database.dump") : directory));
    console.log("Report: " + path.join(runDir, "report.json"));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
