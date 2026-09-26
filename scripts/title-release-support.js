const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { backupDirectory, validateManifest, verifyArchive } = require("./backup-support");
const { titleMigration, migrationChecksum, assertTitleShape } = require("./migration-support");
const { projectMigration, verifyProjectSchema } = require("./project-migration");
const { authMigration, verifyAuthSchema } = require("./auth-migration");

function verifyMigrationResults(result) {
  assert.equal(result?.checksum, migrationChecksum(titleMigration));
  assert.ok(["applied", "already_applied"].includes(result.status));
  assert.equal(result.migrations?.length, 3, "All migration results are required before deployment");
  for (const migration of [titleMigration, projectMigration, authMigration]) {
    const item = result.migrations.find(item => item.id === migration.id);
    assert.equal(item?.checksum, migrationChecksum(migration));
    assert.ok(["applied", "already_applied"].includes(item.status));
  }
}

async function requireVerifiedBackup(project, backupId, currentImage) {
  const directory = backupDirectory(path.join(project, ".backups"), backupId);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "backup.json"), "utf8"));
  validateManifest(manifest);
  await verifyArchive(directory, manifest);
  assert.equal(manifest.application.platformManifest, currentImage.split("@")[1], "Backup must match the current application digest");
  const age = Date.now() - Date.parse(manifest.createdAt);
  assert.ok(age >= 0 && age < 24 * 60 * 60 * 1000, "Use a verified backup from the last 24 hours");
  let verification;
  for (const item of await fs.readdir(path.join(directory, "verifications"))) {
    const file = path.join(directory, "verifications", item, "report.json");
    let report;
    try { report = JSON.parse(await fs.readFile(file, "utf8")); } catch { continue; }
    if (report.status === "succeeded" && report.cleanup?.verified && report.dataVerification?.recordsMatch
        && report.applicationVerification?.health === 200 && report.archiveVerified?.sha256 === manifest.archive.sha256) {
      verification = item;
    }
  }
  assert.ok(verification, "Backup must have a successful isolated restore verification");
  return { backupId, verification, createdAt: manifest.createdAt, rows: manifest.source.summary.rowCount,
    archiveSha256: manifest.archive.sha256, note: "Backup snapshot does not include subsequent writes" };
}

function migrationJob({ id, imageRef, container }) {
  assert.match(id, /^\d{4}-\d{2}-\d{2}T[\dZ-]+-[a-f0-9]{8}$/);
  assert.match(imageRef, /^localhost:5001\/shortener@sha256:[a-f0-9]{64}$/);
  const name = "shortener-title-" + id.toLowerCase();
  const labels = { app: "schema-migration", "shortener.lab/release-id": id };
  return { apiVersion: "batch/v1", kind: "Job", metadata: { name, namespace: "shortener", labels },
    spec: { backoffLimit: 0, activeDeadlineSeconds: 60, ttlSecondsAfterFinished: 3600,
      template: { metadata: { labels }, spec: { restartPolicy: "Never", automountServiceAccountToken: false,
        terminationGracePeriodSeconds: 5, containers: [{ name: "migrate", image: imageRef, imagePullPolicy: "IfNotPresent",
          command: ["node", "migrate.js"], envFrom: structuredClone(container.envFrom || []), env: structuredClone(container.env || []),
          securityContext: { runAsNonRoot: true, runAsUser: 1000, readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "250m", memory: "128Mi" } } }] } } } };
}

async function executeMigrationJob({ kubectl, runDir, id, imageRef, container }) {
  const manifest = migrationJob({ id, imageRef, container });
  const name = manifest.metadata.name;
  const file = path.join(runDir, "migration-job.json");
  await fs.writeFile(file, JSON.stringify(manifest, null, 2));
  const services = JSON.parse(await kubectl("get", "services", "-o", "json"));
  for (const service of services.items) {
    const selectors = Object.entries(service.spec.selector || {});
    assert.ok(!selectors.length || !selectors.every(([k, v]) => manifest.spec.template.metadata.labels[k] === v),
      "Migration Pod must never enter an application Service");
  }
  let uid;
  let result;
  let attempted = false;
  try {
    attempted = true;
    uid = JSON.parse(await kubectl("create", "-f", file, "-o", "json")).metadata.uid;
    const deadline = Date.now() + 75000;
    let job;
    while (Date.now() < deadline) {
      job = JSON.parse(await kubectl("get", "job", name, "-o", "json"));
      assert.equal(job.metadata.uid, uid);
      if (job.status.conditions?.some(c => ["Complete", "Failed"].includes(c.type) && c.status === "True")) break;
      await delay(750);
    }
    const pods = JSON.parse(await kubectl("get", "pods", "-l", "job-name=" + name, "-o", "json"));
    await fs.writeFile(path.join(runDir, "migration-status.json"), JSON.stringify({ job: job.status,
      pods: pods.items.map(p => ({ name: p.metadata.name, status: p.status })) }, null, 2));
    const logs = await kubectl("logs", "job/" + name, "-c", "migrate", "--tail=40");
    await fs.writeFile(path.join(runDir, "migration.log"), logs + "\n");
    assert.ok(job.status.conditions?.some(c => c.type === "Complete" && c.status === "True"), "Migration Job failed; do not deploy");
    result = logs.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return {}; } })
      .find(item => item.event === "migration_completed");
    verifyMigrationResults(result);
    return { job: name, uid, ...result, schemaRollback: "never automatically drop expanded columns or project tables" };
  } finally {
    if (attempted) {
      const text = await kubectl("get", "job", name, "--ignore-not-found", "-o", "json");
      if (text) {
        const job = JSON.parse(text);
        assert.equal(job.metadata.labels?.["shortener.lab/release-id"], id, "Migration Job ownership changed");
        if (uid) assert.equal(job.metadata.uid, uid);
        await kubectl("delete", "job", name, "--wait=true", "--timeout=30s");
        assert.equal(await kubectl("get", "job", name, "--ignore-not-found", "-o", "name"), "");
      }
    }
  }
}

async function queryThroughApi(kubectl, sql, parameters = []) {
  const pods = JSON.parse(await kubectl("get", "pods", "-l", "app=api", "-o", "json"));
  const pod = pods.items.find(p => !p.metadata.deletionTimestamp && p.status.conditions?.some(c => c.type === "Ready" && c.status === "True"));
  assert.ok(pod, "A ready application Pod is required for bounded schema verification");
  const code = `const {Client}=require('pg');const c=new Client({connectionTimeoutMillis:2000,statement_timeout:3000});
    c.on('error',()=>{});(async()=>{try{await c.connect();const r=await c.query(${JSON.stringify(sql)},${JSON.stringify(parameters)});
      console.log(JSON.stringify(r.rows));}finally{await c.end()}})().catch(()=>process.exit(1));`;
  return JSON.parse(await kubectl("exec", pod.metadata.name, "-c", "api", "--", "node", "-e", code));
}

async function preserveLegacyRows(kubectl, previous) {
  const rows = await queryThroughApi(kubectl, `SELECT count(*)::int AS count,
    encode(sha256(convert_to(COALESCE(string_agg(json_build_array(code,url,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,E'\n' ORDER BY code COLLATE "C"),''),'UTF8')),'hex') AS hash,
    COALESCE(json_agg(code ORDER BY code), '[]'::json) AS codes
    FROM public.links WHERE ($1::text[] IS NULL OR code=ANY($1::text[]))`, [previous?.codes || null]);
  if (previous) assert.deepEqual(rows[0], previous, "Existing link rows changed during rollout");
  return rows[0];
}

async function verifyTitleSchema(kubectl) {
  const { titleShapeSql } = require("./migration-support");
  const shape = await queryThroughApi(kubectl, titleShapeSql);
  assertTitleShape(shape);
  const history = await queryThroughApi(kubectl, "SELECT checksum FROM public.lab_schema_migrations WHERE id=$1", [titleMigration.id]);
  assert.equal(history[0]?.checksum, migrationChecksum(titleMigration));
  return { shape, checksum: history[0].checksum };
}

async function verifyWorkspaceSchema(kubectl) {
  const db = { query: async (sql, parameters = []) => ({ rows: await queryThroughApi(kubectl, sql, parameters) }) };
  await verifyProjectSchema(db);
  await verifyAuthSchema(db);
  return { ids: [projectMigration.id, authMigration.id], verified: true };
}

module.exports = { requireVerifiedBackup, migrationJob, executeMigrationJob, queryThroughApi, preserveLegacyRows, verifyTitleSchema,
  verifyMigrationResults, verifyWorkspaceSchema };
