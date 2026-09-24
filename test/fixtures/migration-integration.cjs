const assert = require("node:assert/strict");
const { randomBytes, createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { Client } = require("pg");
// The harness installs this fixture beside the support module in an owned tmpfs.
const { titleMigration, titleShapeSql, assertTitleShape, applyTitleMigration } = require("./migration-support");

const clients = new Set();
const connectionErrors = [];
const result = { status: "started", checks: [] };
const target = "https://example.com/migration-lab";

async function connect(role) {
  const client = new Client({ host: "127.0.0.1", port: 5432, database: "migration_lab", user: "migration_lab",
    password: process.env.PGPASSWORD, application_name: "migration-lab-" + role,
    connectionTimeoutMillis: 2000, statement_timeout: 8000, query_timeout: 9000 });
  client.on("error", error => connectionErrors.push({ role, code: error.code || "CONNECTION_ERROR" }));
  clients.add(client);
  await client.connect();
  return client;
}

async function request(route, options = {}) {
  const started = performance.now();
  const response = await fetch("http://127.0.0.1:8000" + route, {
    ...options, redirect: "manual", signal: AbortSignal.timeout(4000),
    headers: { "content-type": "application/json", ...options.headers },
  });
  const body = await response.text();
  return { status: response.status, body, location: response.headers.get("location"),
    durationMs: Number((performance.now() - started).toFixed(2)) };
}

async function oldWrite(label) {
  const url = target + "?source=" + label;
  const response = await request("/links", { method: "POST", body: JSON.stringify({ url }) });
  assert.equal(response.status, 201, "Old API write must succeed");
  const link = JSON.parse(response.body);
  assert.match(link.code, /^[a-f0-9]{8}$/);
  assert.equal(link.url, url);
  return { code: link.code, url, durationMs: response.durationMs };
}

async function oldRead(link) {
  const response = await request("/" + link.code);
  assert.equal(response.status, 307);
  assert.equal(response.location, link.url);
  return response.durationMs;
}

async function expectedError(action, code) {
  const started = performance.now();
  let failure;
  try { await action(); } catch (error) { failure = error; }
  assert.ok(failure, "Expected operation to fail");
  assert.equal(failure.code, code);
  assert.ok(!failure.rollbackFailed, "Failed migration must roll back cleanly");
  return { code, durationMs: Number((performance.now() - started).toFixed(2)) };
}

async function assertPristine(client) {
  assert.deepEqual((await client.query(titleShapeSql)).rows, []);
  assert.equal((await client.query("SELECT to_regclass('public.lab_schema_migrations') AS table_name")).rows[0].table_name, null);
}

async function fingerprint(client) {
  const rows = (await client.query("SELECT code, url, created_at, title FROM public.links ORDER BY code COLLATE \"C\"")).rows;
  return { rowCount: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}

async function exercise(admin, migrator, blocker) {
  await assertPristine(admin);
  const original = await oldWrite("before-expansion");
  await oldRead(original);
  const originalRow = (await admin.query("SELECT code, url, created_at FROM public.links WHERE code=$1", [original.code])).rows[0];
  result.checks.push({ name: "new-column-query-before-expansion", ...await expectedError(
    () => admin.query("SELECT title FROM public.links LIMIT 1"), "42703") });

  await blocker.query("BEGIN");
  try {
    await blocker.query("SET LOCAL idle_in_transaction_session_timeout='5000ms'");
    await blocker.query("SELECT pg_advisory_xact_lock(20260924, 1)");
    result.checks.push({ name: "concurrent-migration-rejected", ...await expectedError(
      () => applyTitleMigration(migrator), "MIGRATION_BUSY") });
  } finally { await blocker.query("ROLLBACK"); }
  await assertPristine(admin);

  await blocker.query("BEGIN");
  try {
    await blocker.query("SET LOCAL idle_in_transaction_session_timeout='5000ms'");
    await blocker.query("LOCK TABLE public.links IN ACCESS SHARE MODE");
    result.checks.push({ name: "ddl-lock-wait-times-out", ...await expectedError(
      () => applyTitleMigration(migrator), "55P03") });
  } finally { await blocker.query("ROLLBACK"); }
  await assertPristine(admin);
  await oldRead(original);

  result.checks.push({ name: "failure-after-add-column-rolls-back", ...await expectedError(() => applyTitleMigration(migrator,
    { ...titleMigration, statements: [...titleMigration.statements, "SELECT 1/0"] }), "22012") });
  await assertPristine(admin);
  result.transactionalDdlAndLedgerRollbackVerified = true;

  const traffic = [];
  const operations = await Promise.allSettled([
    (async () => {
      for (let index = 0; index < 12; index++) {
        const link = await oldWrite("during-expansion-" + index);
        traffic.push({ writeMs: link.durationMs, redirectMs: await oldRead(link) });
        await delay(60);
      }
    })(),
    (async () => {
      await delay(100);
      const started = performance.now();
      result.migration = await applyTitleMigration(migrator);
      result.migration.durationMs = Number((performance.now() - started).toFixed(2));
    })(),
  ]);
  for (const operation of operations) if (operation.status === "rejected") throw operation.reason;
  result.oldApiDuringExpansion = { successfulWrites: traffic.length, successfulRedirects: traffic.length,
    failed: 0, samples: traffic };
  assert.deepEqual((await admin.query("SELECT code, url, created_at FROM public.links WHERE code=$1", [original.code])).rows[0], originalRow);
  assert.equal((await admin.query("SELECT title FROM public.links WHERE code=$1", [original.code])).rows[0].title, null);
  result.repeat = await applyTitleMigration(migrator);
  assert.equal(result.repeat.status, "already_applied");
  await assert.rejects(applyTitleMigration(migrator, { ...titleMigration,
    statements: [...titleMigration.statements, "SELECT 1"] }), /checksum mismatch/);
  result.appliedChecksumChangeRejected = true;

  const modern = await connect("new-field-client");
  const modernLinks = [];
  const oldLinks = [];
  for (let index = 0; index < 6; index++) {
    const code = randomBytes(4).toString("hex");
    const url = target + "?source=new-client-" + index;
    const title = "Release title " + index + " with 'quotes'";
    const [inserted, old] = await Promise.all([
      modern.query("INSERT INTO public.links (code, url, title) VALUES ($1, $2, $3) RETURNING code, url, title", [code, url, title]),
      oldWrite("mixed-old-" + index),
    ]);
    const link = inserted.rows[0];
    assert.equal(link.title, title);
    await oldRead(link);
    const readOld = (await modern.query("SELECT code, url, title FROM public.links WHERE code=$1", [old.code])).rows[0];
    assert.equal(readOld.title, null);
    assert.equal(readOld.url, old.url);
    modernLinks.push(link);
    oldLinks.push(old);
  }
  result.mixedClients = { newWrites: modernLinks.length, oldWrites: oldLinks.length,
    oldApiReadsNewRows: modernLinks.length, newClientReadsOldRows: oldLinks.length };

  const beforeTightening = await fingerprint(admin);
  await blocker.query("BEGIN");
  try {
    await blocker.query("SET LOCAL lock_timeout='500ms'");
    await blocker.query("SET LOCAL transaction_timeout='6000ms'");
    await blocker.query("UPDATE public.links SET title='temporary-backfill' WHERE title IS NULL");
    await blocker.query("ALTER TABLE public.links ALTER COLUMN title SET NOT NULL");
    result.checks.push({ name: "premature-not-null-breaks-old-insert-shape", ...await expectedError(
      () => blocker.query("INSERT INTO public.links (code, url) VALUES ($1, $2)",
        [randomBytes(4).toString("hex"), target + "?source=must-not-persist"]), "23502") });
  } finally { await blocker.query("ROLLBACK"); }
  assert.deepEqual(await fingerprint(admin), beforeTightening);
  assertTitleShape((await admin.query(titleShapeSql)).rows);
  result.prematureConstraintRollbackVerified = true;

  await modern.end();
  clients.delete(modern);
  const afterStoppingModern = await oldWrite("after-stopping-new-client");
  await oldRead(afterStoppingModern);
  for (const link of modernLinks) {
    assert.equal((await admin.query("SELECT title FROM public.links WHERE code=$1", [link.code])).rows[0].title, link.title);
    await oldRead(link);
  }
  result.newClientStoppedOldApiStillWorks = true;
  result.ledger = (await admin.query("SELECT id, checksum FROM public.lab_schema_migrations ORDER BY id")).rows;
  assert.equal(result.ledger.length, 1);
  result.retainedData = await fingerprint(admin);
  result.markers = [original, modernLinks[0], afterStoppingModern].map(({ code, url }) => ({ code, url }));
  result.schema = (await admin.query(titleShapeSql)).rows;
}

async function verifyRestart(admin, previous) {
  assert.equal(previous.status, "succeeded");
  assert.deepEqual(await fingerprint(admin), previous.retainedData, "Old API startup changed existing rows");
  assert.deepEqual((await admin.query("SELECT id, checksum FROM public.lab_schema_migrations ORDER BY id")).rows, previous.ledger);
  assertTitleShape((await admin.query(titleShapeSql)).rows);
  for (const link of previous.markers) await oldRead(link);
  const link = await oldWrite("after-old-binary-restart");
  await oldRead(link);
  assert.equal((await admin.query("SELECT title FROM public.links WHERE code=$1", [link.code])).rows[0].title, null);
  result.oldBinaryRestart = { existingRowsAndTitlesUnchanged: true, existingMarkers: previous.markers.length,
    oldWriteAndRedirectSucceeded: true, newColumnRetained: true, schemaReverted: false };
}

async function main() {
  assert.equal(process.env.PGHOST, "127.0.0.1");
  assert.equal(process.env.PGDATABASE, "migration_lab");
  assert.equal(process.env.PGUSER, "migration_lab");
  assert.match(process.env.LAB_MIGRATION_RUN || "", /^migration-\d{4}-\d{2}-\d{2}T[\dZ-]+-[a-f0-9]{8}$/);
  const [mode, previousText] = process.argv.slice(2);
  assert.ok(["exercise", "verify-old-restart"].includes(mode));
  try {
    const admin = await connect("inspection");
    const marker = (await admin.query("SELECT run_id FROM public.lab_instance")).rows;
    assert.deepEqual(marker, [{ run_id: process.env.LAB_MIGRATION_RUN }], "Refusing to touch an unowned database");
    result.database = (await admin.query("SELECT current_database() AS name, current_setting('server_version') AS version")).rows[0];
    assert.equal((await request("/health")).status, 200);
    if (mode === "exercise") await exercise(admin, await connect("migration"), await connect("lock-holder"));
    else await verifyRestart(admin, JSON.parse(previousText));
    assert.deepEqual(connectionErrors, []);
    result.status = "succeeded";
  } catch (error) {
    result.status = "failed";
    result.error = { message: error.message, code: error.code || null };
    process.exitCode = 1;
  } finally {
    const closed = await Promise.allSettled([...clients].map(client => client.end()));
    if (closed.some(item => item.status === "rejected")) {
      result.status = "failed";
      result.clientCloseFailed = true;
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(result));
}

const guard = setTimeout(() => { console.error("Migration fixture exceeded 60 seconds"); process.exit(2); }, 60000);
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => clearTimeout(guard));
