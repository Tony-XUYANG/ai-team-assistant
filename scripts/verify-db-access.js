const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { databaseFindings, podCredentialFindings, readyApiPods, probeProgram } = require("./db-access-support");

const execute = promisify(execFile);
const project = path.resolve(__dirname, "..");
const root = path.resolve(project, "..");

async function collectAudit(kubectl) {
  const get = async (...args) => JSON.parse(await kubectl("get", ...args, "-o", "json"));
  const deployment = await get("deployment", "api");
  const pods = readyApiPods(deployment, await get("pods", "-l", "app=api"));
  const findings = podCredentialFindings(deployment.spec.template.spec).map(code => ({ scope: "deployment", code }));
  const evidence = [];
  for (const pod of pods) {
    const access = JSON.parse(await kubectl("exec", pod.metadata.name, "-c", "api", "--", "node", "-e", probeProgram()));
    for (const code of [...podCredentialFindings(pod.spec), ...databaseFindings(access)]) {
      findings.push({ scope: pod.metadata.name, code });
    }
    // Only catalog evidence, never container environments or Secret objects.
    evidence.push({ name: pod.metadata.name, uid: pod.metadata.uid,
      restarts: pod.status.containerStatuses.find(c => c.name === "api").restartCount, access });
  }
  const after = await get("deployment", "api");
  assert.equal(after.metadata.uid, deployment.metadata.uid, "Deployment replaced during audit");
  assert.equal(after.metadata.generation, deployment.metadata.generation, "Deployment changed during audit");
  const afterPods = readyApiPods(after, await get("pods", "-l", "app=api"));
  const identities = values => values.map(p => [p.metadata.uid,
    p.status.containerStatuses.find(c => c.name === "api").containerID,
    p.status.containerStatuses.find(c => c.name === "api").restartCount]).sort();
  assert.deepEqual(identities(afterPods), identities(pods), "API processes changed during audit");
  return { status: findings.length ? "policy-failed" : "catalog-policy-passed", findings, pods: evidence,
    deployment: { uid: deployment.metadata.uid, generation: deployment.metadata.generation },
    limitation: "Point-in-time checks for this lab's roles, schema, and Pod credential references. Not mutation probes, authentication, RBAC, or whole-cluster security certification." };
}

async function main() {
  assert.equal(process.argv.length, 2, "No arguments are accepted; this audit cannot apply changes");
  const id = "db-access-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(4).toString("hex");
  const directory = path.join(project, ".incidents", id);
  await fs.mkdir(directory, { recursive: true });
  const report = { id, startedAt: new Date().toISOString(), status: "incomplete", readOnly: true };
  const lockFile = path.join(project, ".releases", "active.lock");
  let lock;
  let phase = "operation-lock";
  try {
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    lock = await fs.open(lockFile, "wx");
    await lock.writeFile(id);
    const kubectl = async (...args) => {
      try {
        const result = await execute(path.join(root, "bin", "kubectl.exe"), [
          "--kubeconfig", path.join(root, "kubeconfig.yaml"), "--cache-dir", path.join(root, ".kube-cache"),
          "--context=k3d-shortener", "--request-timeout=10s", "-n", "shortener", ...args,
        ], { cwd: project, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
          env: { ...process.env, TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp") } });
        return result.stdout.trim();
      } catch {
        // Do not serialize command errors: their output might contain credentials.
        throw new Error("KUBERNETES_READ_OR_PROBE_FAILED");
      }
    };
    phase = "cluster-and-database-audit";
    Object.assign(report, await collectAudit(kubectl));
  } catch {
    report.status = "incomplete";
    report.failure = { phase, code: "AUDIT_NOT_COMPLETED" };
  } finally {
    if (lock) {
      try {
        await lock.close();
        assert.equal(await fs.readFile(lockFile, "utf8"), id, "Operation lock ownership changed");
        await fs.unlink(lockFile);
        report.lockReleased = true;
      } catch { report.status = "incomplete"; report.lockReleased = false; }
    }
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  }
  console.log(`Database access audit: ${report.status}. Report: ${path.join(directory, "report.json")}`);
  if (report.status !== "catalog-policy-passed") process.exitCode = 1;
}

if (require.main === module) main().catch(() => { console.error("ACCESS_AUDIT_FAILED"); process.exitCode = 1; });
module.exports = { collectAudit };
