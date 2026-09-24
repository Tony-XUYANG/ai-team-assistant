const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const titleMigration = Object.freeze({
  id: "001_link_title",
  statements: Object.freeze(["ALTER TABLE public.links ADD COLUMN title VARCHAR(120)"]),
});
const titleShapeSql = `SELECT data_type, character_maximum_length, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'links' AND column_name = 'title'`;

function migrationChecksum(migration) {
  assert.match(migration.id, /^\d{3}_[a-z][a-z0-9_]{0,50}$/);
  assert.ok(Array.isArray(migration.statements) && migration.statements.length > 0 && migration.statements.length <= 10);
  assert.ok(migration.statements.every(sql => typeof sql === "string" && sql.trim().length > 0 && sql.length <= 8192));
  return createHash("sha256").update(JSON.stringify({ id: migration.id, statements: migration.statements })).digest("hex");
}

function assertTitleShape(rows) {
  assert.deepEqual(rows, [{ data_type: "character varying", character_maximum_length: 120,
    is_nullable: "YES", column_default: null }], "Title schema drift; inspect before proceeding");
}

// Only trusted, repository-owned SQL is accepted; this is not a user-SQL API.
// The caller supplies a dedicated connected Client with no active transaction.
async function applyTitleMigration(client, migration = titleMigration) {
  const checksum = migrationChecksum(migration);
  assert.equal(migration.id, titleMigration.id, "This lab runner handles only the title expansion");
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL statement_timeout = '2500ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
    await client.query("SET LOCAL transaction_timeout = '6000ms'");
    // Match the advisory lock already used by database.initialize().
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(20260924, 1) AS acquired");
    if (!lock.rows[0]?.acquired) throw Object.assign(new Error("Another schema operation is active"), { code: "MIGRATION_BUSY" });
    await client.query(`CREATE TABLE IF NOT EXISTS public.lab_schema_migrations (
      id TEXT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const history = await client.query("SELECT checksum FROM public.lab_schema_migrations WHERE id = $1", [migration.id]);
    let status;
    if (history.rows.length) {
      assert.equal(history.rows[0].checksum, checksum, "Migration checksum mismatch; do not edit applied migrations");
      status = "already_applied";
    } else {
      for (const sql of migration.statements) await client.query(sql);
      await client.query("INSERT INTO public.lab_schema_migrations (id, checksum) VALUES ($1, $2)", [migration.id, checksum]);
      status = "applied";
    }
    assertTitleShape((await client.query(titleShapeSql)).rows);
    await client.query("COMMIT");
    began = false;
    return { id: migration.id, checksum, status };
  } catch (error) {
    if (began) {
      try { await client.query("ROLLBACK"); }
      catch { error.rollbackFailed = true; }
    }
    throw error;
  }
}

function assertMigrationContainer(container, id, name) {
  assert.equal(container.Name, "/" + name, "Unexpected container name");
  assert.equal(container.Config.Labels?.["shortener.lab/migration-run"], id, "Container ownership mismatch");
  assert.ok(!(container.Mounts || []).some(m => ["bind", "volume"].includes(m.Type)), "Persistent mount; cleanup refused");
}

module.exports = { titleMigration, titleShapeSql, migrationChecksum, assertTitleShape, applyTitleMigration, assertMigrationContainer };
