const test = require("node:test");
const assert = require("node:assert/strict");
const { titleMigration, titleShapeSql, migrationChecksum, assertTitleShape, applyTitleMigration,
  assertMigrationContainer } = require("../scripts/migration-support");

const shape = [{ data_type: "character varying", character_maximum_length: 120, is_nullable: "YES", column_default: null }];

function clientFixture({ checksum, locked = false, failSql, rollbackFails = false, rows = shape } = {}) {
  const calls = [];
  return { calls, async query(sql, parameters) {
    calls.push({ sql, parameters });
    if (sql === failSql) throw Object.assign(new Error("Deliberate test failure"), { code: "TEST_FAILURE" });
    if (sql === "ROLLBACK" && rollbackFails) throw new Error("Connection lost");
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: !locked }] };
    if (sql.startsWith("SELECT checksum")) return { rows: checksum ? [{ checksum }] : [] };
    if (sql === titleShapeSql) return { rows };
    return { rows: [] };
  } };
}

test("migration checksum is deterministic and changes with SQL or ID", () => {
  const checksum = migrationChecksum(titleMigration);
  assert.match(checksum, /^[a-f0-9]{64}$/);
  assert.equal(migrationChecksum(JSON.parse(JSON.stringify(titleMigration))), checksum);
  assert.notEqual(migrationChecksum({ ...titleMigration, statements: [...titleMigration.statements, "SELECT 1"] }), checksum);
  assert.notEqual(migrationChecksum({ ...titleMigration, id: "002_link_title" }), checksum);
  for (const migration of [{ id: "../outside", statements: ["SELECT 1"] }, { ...titleMigration, statements: [] },
    { ...titleMigration, statements: [null] }]) assert.throws(() => migrationChecksum(migration));
});

test("fresh migration uses one transaction, bounded waits, and a parameterized ledger", async () => {
  const client = clientFixture();
  assert.equal((await applyTitleMigration(client)).status, "applied");
  assert.equal(client.calls[0].sql, "BEGIN");
  assert.equal(client.calls.at(-1).sql, "COMMIT");
  assert.ok(client.calls.some(c => c.sql === "SET LOCAL lock_timeout = '500ms'"));
  assert.ok(client.calls.some(c => c.sql === "SET LOCAL transaction_timeout = '6000ms'"));
  const insert = client.calls.find(c => c.sql.startsWith("INSERT INTO public.lab_schema_migrations"));
  assert.deepEqual(insert.parameters, [titleMigration.id, migrationChecksum(titleMigration)]);
  assert.ok(!client.calls.some(c => c.sql === "ROLLBACK"));
});

test("repeat validates checksum and schema without applying DDL twice", async () => {
  const client = clientFixture({ checksum: migrationChecksum(titleMigration) });
  assert.equal((await applyTitleMigration(client)).status, "already_applied");
  assert.ok(!client.calls.some(c => c.sql.startsWith("ALTER TABLE") || c.sql.startsWith("INSERT INTO")));
  assert.ok(client.calls.some(c => c.sql === titleShapeSql));
});

test("checksum mismatch and schema drift fail closed and roll back", async () => {
  for (const options of [{ checksum: "0".repeat(64) }, { checksum: migrationChecksum(titleMigration), rows: [] }]) {
    const client = clientFixture(options);
    await assert.rejects(applyTitleMigration(client));
    assert.equal(client.calls.at(-1).sql, "ROLLBACK");
    assert.ok(!client.calls.some(c => c.sql === "COMMIT" || c.sql.startsWith("ALTER TABLE")));
  }
  for (const row of [{ ...shape[0], is_nullable: "NO" }, { ...shape[0], column_default: "'changed'" },
    { ...shape[0], character_maximum_length: 121 }, { ...shape[0], data_type: "text" }]) {
    assert.throws(() => assertTitleShape([row]));
  }
});

test("a concurrent schema operation is rejected before any DDL", async () => {
  const client = clientFixture({ locked: true });
  await assert.rejects(applyTitleMigration(client), { code: "MIGRATION_BUSY" });
  assert.ok(!client.calls.some(c => c.sql.startsWith("CREATE") || c.sql.startsWith("ALTER")));
  assert.equal(client.calls.at(-1).sql, "ROLLBACK");
});

test("SQL failure rolls back without losing the original error if rollback also fails", async () => {
  for (const rollbackFails of [false, true]) {
    const client = clientFixture({ failSql: titleMigration.statements[0], rollbackFails });
    await assert.rejects(applyTitleMigration(client), error => error.code === "TEST_FAILURE"
      && Boolean(error.rollbackFailed) === rollbackFails);
    assert.equal(client.calls.at(-1).sql, "ROLLBACK");
    assert.ok(!client.calls.some(c => c.sql === "COMMIT"));
  }
});

test("migration cleanup refuses another run and persistent mounts", () => {
  const container = { Name: "/temporary", Config: { Labels: { "shortener.lab/migration-run": "run" } }, Mounts: [] };
  assertMigrationContainer(container, "run", "temporary");
  assert.throws(() => assertMigrationContainer(container, "other", "temporary"));
  assert.throws(() => assertMigrationContainer(container, "run", "other"));
  for (const Type of ["bind", "volume"]) {
    assert.throws(() => assertMigrationContainer({ ...container, Mounts: [{ Type }] }, "run", "temporary"));
  }
});
