const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { parseArgs, promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { version } = require("../package.json");
const { runCI } = require("./ci");
const { setupRegistry } = require("./setup-registry");
const { testSummary, verifyRegistryManifest, sourceFingerprint, unitFiles, acceptanceFiles } = require("./ci-support");
const { requireVerifiedBackup, executeMigrationJob, queryThroughApi, preserveLegacyRows, verifyTitleSchema, verifyWorkspaceSchema } = require("./title-release-support");

const { values } = parseArgs({ options: {
  image: { type: "string" },
  "expected-version": { type: "string", default: version },
  drill: { type: "boolean", default: false },
  registry: { type: "boolean", default: false },
  "ci-fail": { type: "boolean", default: false },
  backup: { type: "string" },
  "verify-rollback": { type: "boolean", default: false },
} });
const execute = promisify(execFile);
const projectDir = path.resolve(__dirname, "..");
const learningRoot = path.resolve(projectDir, "..");
const tempDir = path.join(learningRoot, "tmp");
const reportsDir = path.join(projectDir, ".releases");
const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
const runDir = path.join(reportsDir, id);
const kubectlPath = path.join(learningRoot, "bin", "kubectl.exe");
const k3dPath = path.join(learningRoot, "bin", "k3d.exe");
const nodeName = "k3d-shortener-server-0";
const baseUrl = "http://127.0.0.1:8081";
const suppliedImage = values.image;
const image = suppliedImage || `shortener:${version}-${id.toLowerCase()}`;
const annotation = "shortener.lab/release-id";
const expectedVersion = values["expected-version"];
const report = {
  id, startedAt: new Date().toISOString(), context: "k3d-shortener",
  namespace: "shortener", image, expectedVersion, drill: values.drill,
  delivery: values.registry ? "registry" : "local-import", ciFailureDrill: values["ci-fail"],
  published: false, deploymentPatched: false,
  status: "started", availability: { successful: 0, failed: 0, errors: [] },
};
let baseline;
let link;
let patched = false;
let stopMonitor = false;
let monitor;
let accepted;
let ownedGeneration;
let rollbackTemplate;
let titleMarker;

async function runTests(files, options = {}) {
  const output = await run(process.execPath, ["--test", "--test-reporter=tap", ...files], options);
  return { files, ...testSummary(output) };
}

async function run(executable, args, options = {}) {
  const started = Date.now();
  try {
    const { env: extraEnv, ...otherOptions } = options;
    const result = await execute(executable, args, {
      cwd: projectDir, timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      ...otherOptions,
      env: { ...process.env, ...extraEnv, TEMP: tempDir, TMP: tempDir },
    });
    await fs.appendFile(path.join(runDir, "commands.log"),
      `${path.basename(executable)} ${args.join(" ")} (${Date.now() - started}ms)\n${result.stdout}${result.stderr}\n`);
    return result.stdout.trim();
  } catch (error) {
    await fs.appendFile(path.join(runDir, "commands.log"),
      `FAILED ${path.basename(executable)} ${args.join(" ")}\n${error.stdout || ""}${error.stderr || ""}\n`);
    throw new Error(`${path.basename(executable)} ${args[0]} failed: ${(error.stderr || error.message).trim()}`);
  }
}

function kubectl(...args) {
  return run(kubectlPath, [
    "--kubeconfig", path.join(learningRoot, "kubeconfig.yaml"),
    "--cache-dir", path.join(learningRoot, ".kube-cache"),
    "--context=k3d-shortener", "--request-timeout=15s", "-n", "shortener", ...args,
  ]);
}

async function deployment() {
  return JSON.parse(await kubectl("get", "deployment", "api", "-o", "json"));
}

async function http(route, options = {}) {
  const response = await fetch(baseUrl + route, {
    ...options, redirect: "manual", signal: AbortSignal.timeout(5000),
    headers: { "Connection": "close", "Content-Type": "application/json", ...options.headers },
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

async function waitHealthy() {
  let lastError;
  let consecutive = 0;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const response = await http("/health");
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).database, "ok");
      if (++consecutive === 3) return;
    } catch (error) { consecutive = 0; lastError = error.message; }
    await delay(500);
  }
  throw new Error("Service did not recover: " + lastError);
}

async function checkSavedLink() {
  const response = await http(link.short_path);
  assert.equal(response.status, 307, "The saved link must still exist");
  assert.equal(response.location, "https://example.com/release-check");
}

async function sampleAvailability() {
  while (!stopMonitor) {
    try {
      const response = await http("/health");
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).database, "ok");
      report.availability.successful += 1;
    } catch (error) {
      report.availability.failed += 1;
      if (report.availability.errors.length < 5) report.availability.errors.push({
        at: new Date().toISOString(), message: error.message, cause: error.cause?.code,
      });
    }
    if (!stopMonitor) await delay(500);
  }
}

async function snapshotFailure() {
  try {
    const pods = JSON.parse(await kubectl("get", "pods", "-l", "app=api", "-o", "json"));
    const summary = pods.items.map(pod => ({
      name: pod.metadata.name, releaseId: pod.metadata.annotations?.[annotation],
      phase: pod.status.phase, conditions: pod.status.conditions,
      containers: pod.status.containerStatuses,
    }));
    await fs.writeFile(path.join(runDir, "failed-pods.json"), JSON.stringify(summary, null, 2));
    for (const pod of pods.items.filter(pod => pod.metadata.annotations?.[annotation] === id)) {
      try {
        await kubectl("logs", pod.metadata.name, "-c", "api", "--tail=20");
      } catch { /* A failing Pod might not have started its main container yet. */ }
    }
  } catch (error) { report.diagnosticsError = error.message; }
}

async function buildAndImport() {
  if (!suppliedImage) {
    console.log(`Building ${image}`);
    await run("docker.exe", ["build", "-t", image, "."]);
  }
  await run("docker.exe", ["image", "inspect", image]);
  const archive = path.join(tempDir, `release-${id}.tar`);
  await run("docker.exe", ["image", "save", "--platform=linux/amd64", "--output", archive, image]);
  const index = JSON.parse(await run("tar.exe", ["-xOf", archive, "index.json"]));
  const manifest = index.manifests.find(item => item.platform?.os === "linux" && item.platform?.architecture === "amd64");
  assert.match(manifest?.digest || "", /^sha256:[a-f0-9]{64}$/);
  report.digest = manifest.digest;
  report.archive = archive;
  report.imageRef = `docker.io/library/shortener@${manifest.digest}`;
  console.log("Importing " + report.imageRef);
  await run(k3dPath, ["image", "import", archive, "--cluster", "shortener", "--mode", "direct"]);
  await run("docker.exe", ["exec", nodeName, "ctr", "--address", "/run/k3s/containerd/containerd.sock",
    "--namespace", "k8s.io", "images", "tag", "--force", `docker.io/library/${image}`, report.imageRef]);
}

async function buildAndPush() {
  report.phase = "ci";
  report.ci = await runCI({ image, runDir: path.join(runDir, "ci"), drillFail: values["ci-fail"], oldImage: accepted.ci.localImageId });
  report.unitTests = report.ci.unit;
  report.phase = "registry-setup";
  report.registry = await setupRegistry();
  assert.equal((await sourceFingerprint(projectDir)).sha256, report.ci.source.sha256,
    "Source changed after CI; do not publish");
  const current = JSON.parse(await run("docker.exe", ["image", "inspect", "--platform=linux/amd64", image]))[0];
  assert.equal(current.Descriptor.digest, report.ci.platformDigest);
  report.phase = "registry-push";
  report.registryTag = "localhost:5001/" + image;
  await run("docker.exe", ["tag", report.ci.localImageId, report.registryTag]);
  await run("docker.exe", ["push", "--platform=linux/amd64", report.registryTag]);
  report.published = true;
  const tag = image.slice("shortener:".length);
  const response = await fetch("http://127.0.0.1:5001/v2/shortener/manifests/" + tag, {
    headers: { Accept: "application/vnd.oci.image.manifest.v1+json" }, signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, "Registry must serve the published manifest");
  report.digest = verifyRegistryManifest(Buffer.from(await response.arrayBuffer()),
    response.headers.get("docker-content-digest"), report.ci.platformDigest);
  report.imageRef = "localhost:5001/shortener@" + report.digest;
  console.log("Registry verified: " + report.imageRef);
}

async function publish() {
  report.phase = "deploy";
  const current = await deployment();
  assert.equal(current.metadata.uid, baseline.metadata.uid, "Deployment was replaced during build");
  assert.equal(current.metadata.generation, ownedGeneration, "Deployment changed during release");
  const containerIndex = current.spec.template.spec.containers.findIndex(item => item.name === "api");
  assert.ok(containerIndex >= 0);
  const operations = [
    { op: "test", path: "/metadata/uid", value: baseline.metadata.uid },
    { op: "test", path: "/metadata/generation", value: ownedGeneration },
    { op: "add", path: "/spec/template/metadata/annotations", value: {
      ...current.spec.template.metadata.annotations, [annotation]: id,
    } },
    { op: "replace", path: `/spec/template/spec/containers/${containerIndex}/image`, value: report.imageRef },
  ];
  if (values.drill) {
    operations.push({ op: "add", path: `/spec/template/spec/containers/${containerIndex}/command`,
      value: ["node", "-e", "console.error('Deliberate lab startup failure');process.exit(1)"] });
  }
  const patchFile = path.join(runDir, "deployment-patch.json");
  await fs.writeFile(patchFile, JSON.stringify(operations, null, 2));
  // Treat an uncertain write as possibly applied so failure handling checks live state.
  patched = true;
  report.deploymentPatched = true;
  ownedGeneration += 1;
  await kubectl("patch", "deployment", "api", "--type=json", "--patch-file", patchFile);
  console.log(values.drill ? "Injecting an intentional startup failure in the new revision" : "Waiting for rollout");
  await kubectl("rollout", "status", "deployment/api", `--timeout=${values.drill ? 35 : 120}s`);
  if (values.drill) throw new Error("Failure drill unexpectedly became ready");
}

async function verifyRelease() {
  report.phase = "acceptance";
  await waitHealthy();
  const pods = JSON.parse(await kubectl("get", "pods", "-l", "app=api", "-o", "json"))
    .items.filter(pod => !pod.metadata.deletionTimestamp);
  assert.equal(pods.length, baseline.spec.replicas);
  report.pods = [];
  for (const pod of pods) {
    assert.equal(pod.spec.containers.find(item => item.name === "api").image, report.imageRef);
    const data = JSON.parse(await kubectl("exec", pod.metadata.name, "-c", "api", "--", "node", "-e",
      "fetch('http://127.0.0.1:8000/version',{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(console.log).catch(()=>process.exit(1))"));
    assert.equal(data.version, expectedVersion);
    assert.equal(data.hostname, pod.metadata.name);
    report.pods.push({ name: pod.metadata.name, version: data.version,
      imageID: pod.status.containerStatuses.find(item => item.name === "api").imageID });
  }
  const acceptance = await runTests(acceptanceFiles, {
    env: { ...process.env, TEST_BASE_URL: baseUrl, EXPECTED_VERSION: expectedVersion }, timeout: 30000,
  });
  await checkSavedLink();
  assert.equal(report.availability.failed, 0, "Health requests failed during the release; restore the previous revision");
  report.tests = { unit: report.unitTests, acceptance, passed: true, existingLinkPreserved: true };
  if (report.ci) report.tests.candidateImage = report.ci.candidate;
  if (values.registry) {
    const events = JSON.parse(await kubectl("get", "events", "-o", "json"));
    report.pullEvents = events.items.filter(event => pods.some(pod => pod.metadata.uid === event.involvedObject.uid)
      && ["Pulling", "Pulled"].includes(event.reason))
      .map(event => ({ pod: event.involvedObject.name, reason: event.reason, message: event.message }));
    assert.ok(report.pullEvents.some(event => event.reason === "Pulled"
      && event.message.includes(report.imageRef)), "Capture candidate image availability on the node");
  }
  report.status = "succeeded";
  report.phase = "completed";
  console.log(`PASS: ${report.unitTests.count} unit and ${acceptance.count} endpoint checks, per-Pod version validation, and saved-link verification`);
}

async function recover(planned = false) {
  const live = await deployment();
  if (live.spec.template.metadata.annotations?.[annotation] !== id) {
    report.status = "not_rolled_back";
    report.rollbackNote = "Live template does not belong to this release; no rollback was attempted";
    return;
  }
  assert.equal(live.metadata.uid, baseline.metadata.uid);
  assert.equal(live.metadata.generation, ownedGeneration,
    "Concurrent changes detected; stopping automatic rollback");
  console.log((planned ? "Planned rollback verification; restoring revision " : "Release failed; restoring revision ") + report.before.revision);
  const rollbackFile = path.join(runDir, "rollback-patch.json");
  await fs.writeFile(rollbackFile, JSON.stringify([
    { op: "test", path: "/metadata/uid", value: live.metadata.uid },
    { op: "test", path: "/metadata/generation", value: live.metadata.generation },
    { op: "replace", path: "/spec/template", value: rollbackTemplate },
  ], null, 2));
  await kubectl("patch", "deployment", "api", "--type=json", "--patch-file", rollbackFile);
  ownedGeneration += 1;
  await kubectl("rollout", "status", "deployment/api", "--timeout=120s");
  await waitHealthy();
  const restored = await deployment();
  assert.deepEqual(restored.spec.template, rollbackTemplate, "Rollback must restore the original template");
  assert.equal(restored.status.readyReplicas, baseline.spec.replicas);
  await checkSavedLink();
  report.status = "rolled_back";
  report.rollback = { verified: true, image: report.before.image, existingLinkPreserved: true };
  console.log("PASS: previous template restored, service healthy, saved link intact");
}

async function verifyRollbackCycle() {
  report.phase = "rollback-verification";
  const created = await http("/links", { method: "POST", body: JSON.stringify({
    url: "https://example.com/title-retention", title: "Title retained across 3.2 rollback",
  }) });
  assert.equal(created.status, 201);
  titleMarker = JSON.parse(created.body);
  report.titleMarker = titleMarker;
  await recover(true);
  assert.equal(report.status, "rolled_back");
  const oldVersion = JSON.parse((await http("/version")).body).version;
  assert.equal(oldVersion, accepted.expectedVersion);
  const redirect = await http(titleMarker.short_path);
  assert.equal(redirect.status, 307);
  assert.equal(redirect.location, titleMarker.url);
  const stored = await queryThroughApi(kubectl, "SELECT code,url,title FROM public.links WHERE code=$1", [titleMarker.code]);
  assert.equal(stored[0]?.title, titleMarker.title);
  const legacy = await http("/links", { method: "POST", body: JSON.stringify({ url: "https://example.com/rollback-write" }) });
  assert.equal(legacy.status, 201);
  const legacyLink = JSON.parse(legacy.body);
  await verifyTitleSchema(kubectl);
  report.rollbackCycle = { oldVersion, oldImage: report.before.image, oldWriteStatus: 201,
    titledRedirectStatus: 307, titlePreservedInDatabase: true, expandedSchemaRetained: true, legacyCode: legacyLink.code };
  await fs.writeFile(path.join(runDir, "rollback-evidence.json"), JSON.stringify(report.rollbackCycle, null, 2));
  console.log("Rollback verified; rolling forward to the SAME tested candidate digest");
  await publish();
  await verifyRelease();
  const restored = await http("/links/" + titleMarker.code);
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restored.body).title, titleMarker.title);
  const legacyRead = await http("/links/" + legacyLink.code);
  assert.equal(legacyRead.status, 200);
  assert.equal(JSON.parse(legacyRead.body).title, null);
  report.rollbackCycle.forwardVerified = true;
}

async function main() {
  assert.match(image, /^shortener:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/);
  assert.ok(!values.registry || !suppliedImage, "Registry mode builds and tests a fresh candidate; omit --image");
  assert.ok(!values["ci-fail"] || values.registry, "--ci-fail requires --registry");
  assert.ok(!values.registry || expectedVersion === version, "Fresh source version must match the expected version");
  assert.ok(values.registry, "Schema-aware releases require --registry and a verified --backup ID");
  assert.ok(values.backup, "Supply --backup with a recent verified backup ID before schema changes");
  assert.ok(!values["verify-rollback"] || !values.drill, "Do not combine two rollback drill modes");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
  const lock = await fs.open(path.join(reportsDir, "active.lock"), "wx");
  await lock.writeFile(id);
  try {
    baseline = await deployment();
    ownedGeneration = baseline.metadata.generation;
    rollbackTemplate = structuredClone(baseline.spec.template);
    accepted = JSON.parse(await fs.readFile(path.join(reportsDir, "last-success.json"), "utf8"));
    await fs.writeFile(path.join(runDir, "baseline-deployment.json"), JSON.stringify(baseline, null, 2));
    await fs.writeFile(path.join(runDir, "previous-accepted.json"), JSON.stringify(accepted, null, 2));
    assert.ok(baseline.spec.replicas > 0 && !baseline.spec.paused);
    assert.equal(baseline.status.observedGeneration, baseline.metadata.generation);
    assert.equal(baseline.status.readyReplicas, baseline.spec.replicas);
    assert.equal(baseline.status.updatedReplicas, baseline.spec.replicas);
    assert.equal(baseline.status.availableReplicas, baseline.spec.replicas);
    report.before = { image: baseline.spec.template.spec.containers.find(item => item.name === "api").image,
      revision: baseline.metadata.annotations["deployment.kubernetes.io/revision"], replicas: baseline.spec.replicas };
    assert.equal(report.before.image, accepted.imageRef, "Live Deployment must match the accepted release");
    report.backup = await requireVerifiedBackup(projectDir, values.backup, report.before.image);
    report.legacyRows = await preserveLegacyRows(kubectl);
    report.pvcBefore = JSON.parse(await kubectl("get", "pvc", "data-db-0", "-o", "json")).metadata.uid;
    await waitHealthy();
    const response = await http("/links", { method: "POST", body: JSON.stringify({ url: "https://example.com/release-check" }) });
    assert.equal(response.status, 201);
    link = JSON.parse(response.body);
    report.savedLink = link.short_path;
    await checkSavedLink();
    if (values.registry) await buildAndPush();
    else {
      report.unitTests = await runTests(["test/logging.test.js"], { timeout: 30000 });
      await buildAndImport();
    }
    monitor = sampleAvailability();
    report.phase = "schema-migration";
    report.migration = await executeMigrationJob({ kubectl, runDir, id, imageRef: report.imageRef,
      container: baseline.spec.template.spec.containers.find(c => c.name === "api") });
    report.schema = await verifyTitleSchema(kubectl);
    report.projectSchema = await verifyWorkspaceSchema(kubectl);
    await preserveLegacyRows(kubectl, report.legacyRows);
    await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    await publish();
    await verifyRelease();
    if (values["verify-rollback"]) await verifyRollbackCycle();
    await preserveLegacyRows(kubectl, report.legacyRows);
    assert.equal(JSON.parse(await kubectl("get", "pvc", "data-db-0", "-o", "json")).metadata.uid, report.pvcBefore);
    stopMonitor = true;
    await monitor;
    assert.equal(report.availability.failed, 0);
    report.existingRowsAndPvcPreserved = true;
    const manifestFile = path.join(projectDir, "k8s", "30-api.yaml");
    const manifest = await fs.readFile(manifestFile, "utf8");
    const imageLines = manifest.match(/^\s+image: localhost:5001\/shortener@sha256:[a-f0-9]{64}$/gm);
    assert.equal(imageLines?.length, 1, "Expected exactly one pinned application image in manifest");
    await fs.writeFile(manifestFile, manifest.replace(imageLines[0], imageLines[0].replace(/localhost:5001\/shortener@sha256:[a-f0-9]{64}/, report.imageRef)));
    report.status = "succeeded";
    report.phase = "completed";
  } catch (error) {
    report.error = error.message;
    report.status = "failed";
    process.exitCode = 1;
    if (patched) {
      await snapshotFailure();
      try { await recover(); }
      catch (rollbackError) { report.status = "rollback_failed"; report.rollbackError = rollbackError.message; }
    }
    console.error(error.message);
  } finally {
    stopMonitor = true;
    if (monitor) await monitor;
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    if (report.status === "succeeded") {
      await fs.writeFile(path.join(reportsDir, "last-success.json"), JSON.stringify(report, null, 2));
    }
    await lock.close();
    await fs.unlink(path.join(reportsDir, "active.lock"));
    console.log(`RESULT: ${report.status}; health samples ${report.availability.successful} passed, ${report.availability.failed} failed`);
    console.log("Release report: " + path.join(runDir, "report.json"));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
