const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { migrationJob, executeMigrationJob, requireVerifiedBackup } = require("../scripts/title-release-support");
const { titleMigration, migrationChecksum } = require("../scripts/migration-support");
const id = "2026-09-24T10-10-00-000Z-1234abcd";
const imageRef = "localhost:5001/shortener@sha256:" + "a".repeat(64);
const container = { envFrom: [{ configMapRef: { name: "api-config" } }], env: [
  { name: "PGPASSWORD", valueFrom: { secretKeyRef: { name: "db-credentials", key: "POSTGRES_PASSWORD" } } },
] };

test("migration Job is bounded, runs exact digest, and references secrets without copying values", () => {
  const manifest = migrationJob({ id, imageRef, container });
  assert.equal(manifest.spec.backoffLimit, 0);
  assert.equal(manifest.spec.activeDeadlineSeconds, 60);
  assert.equal(manifest.spec.template.spec.restartPolicy, "Never");
  assert.equal(manifest.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(manifest.spec.template.spec.containers[0].command, ["node", "migrate.js"]);
  assert.equal(manifest.spec.template.spec.containers[0].image, imageRef);
  assert.deepEqual(manifest.spec.template.spec.containers[0].env, container.env);
  assert.notEqual(manifest.spec.template.spec.containers[0].env, container.env);
  assert.notEqual(manifest.spec.template.metadata.labels.app, "api");
  assert.throws(() => migrationJob({ id: "../bad", imageRef, container }));
  assert.throws(() => migrationJob({ id, imageRef: "shortener:latest", container }));
});

async function directory(t) {
  const root = path.resolve(__dirname, "../../tmp");
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, "job-test-"));
  t.after(async () => { assert.equal(path.dirname(dir), root); await fs.rm(dir, { recursive: true }); });
  return dir;
}

function fakeKube({ failed = false, foreign = false } = {}) {
  let exists = false;
  const calls = [];
  const manifest = migrationJob({ id, imageRef, container });
  const job = { ...manifest, metadata: { ...manifest.metadata, uid: "owned-uid" },
    status: { conditions: [{ type: failed ? "Failed" : "Complete", status: "True" }] } };
  const kubectl = async (...args) => {
    calls.push(args);
    if (args[0] === "create") { exists = true; return JSON.stringify(job); }
    if (args[0] === "logs") return JSON.stringify(failed ? { event: "migration_failed" } : {
      event: "migration_completed", status: "applied", checksum: migrationChecksum(titleMigration) });
    if (args[0] === "delete") { exists = false; return "deleted"; }
    if (args[1] === "services" || args[1] === "pods") return JSON.stringify({ items: [] });
    if (args[1] === "job") {
      if (!exists) return "";
      if (foreign && args.includes("--ignore-not-found")) {
        return JSON.stringify({ ...job, metadata: { ...job.metadata, labels: { "shortener.lab/release-id": "other" } } });
      }
      return JSON.stringify(job);
    }
    throw Error("Unexpected fake command");
  };
  return { kubectl, calls };
}

test("completed migration saves evidence and cleans only its Job", async t => {
  const f = fakeKube();
  const runDir = await directory(t);
  const result = await executeMigrationJob({ ...f, runDir, id, imageRef, container });
  assert.equal(result.status, "applied");
  assert.ok(f.calls.some(c => c[0] === "delete"));
  assert.ok((await fs.readFile(path.join(runDir, "migration.log"), "utf8")).includes("migration_completed"));
});

test("failed migration rejects publication and preserves failure evidence", async t => {
  const f = fakeKube({ failed: true });
  const runDir = await directory(t);
  await assert.rejects(executeMigrationJob({ ...f, runDir, id, imageRef, container }), /Migration Job failed/);
  assert.ok(f.calls.some(c => c[0] === "delete"));
  assert.ok((await fs.readFile(path.join(runDir, "migration-status.json"), "utf8")).includes("Failed"));
});

test("cleanup refuses a Job whose ownership changed", async t => {
  const f = fakeKube({ foreign: true });
  await assert.rejects(executeMigrationJob({ ...f, runDir: await directory(t), id, imageRef, container }), /ownership changed/);
  assert.ok(!f.calls.some(c => c[0] === "delete"));
});

test("backup release gate refuses path traversal before reading an archive", async () => {
  await assert.rejects(requireVerifiedBackup(path.resolve(__dirname, ".."), "../invalid", imageRef));
});
