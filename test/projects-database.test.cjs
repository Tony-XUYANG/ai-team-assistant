const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { createProjectStore } = require("../project-store");
const { verifyProjectSchema, applyProjectMigration } = require("../scripts/project-migration");
assert.equal(process.env.SHORTENER_CI_FIXTURE, "isolated-tmpfs", "Run this SQL fixture only through scripts/ci.js");
assert.equal(process.env.PGDATABASE, "ci_lab");
const pool = new Pool({ max: 2, connectionTimeoutMillis: 2000, statement_timeout: 3000 });
const accountId = randomUUID();
let store;
const source = { kind: "note", label: "Database acceptance", captured_at: "2026-09-25T00:00:00.000Z" };
test.after(() => pool.end());

test.before(async () => {
  await pool.query(`INSERT INTO public.accounts (id, username, password_hash)
    VALUES ($1, $2, $3)`, [accountId, "db_" + accountId.replaceAll("-", ""), "database-test-password"]);
  store = createProjectStore(pool, accountId);
});

test("PostgreSQL enforces project-scoped revisions and legal status independently of HTTP", async () => {
  const one = await store.createProject({ name: "Database one", objective: "Verify integrity", status: "active", source });
  const two = await store.createProject({ name: "Database two", objective: "Verify isolation", status: "active", source });
  const first = await store.createProjectEntry(one.id, { kind: "action", content: "Original", status: "todo", verification: "unverified", source });
  const sql = `INSERT INTO public.project_entries(id,project_id,kind,content,status,source,supersedes_id)
    VALUES ($1,$2,'action','Direct SQL test',$3,$4,$5)`;
  await assert.rejects(pool.query(sql, [randomUUID(), two.id, "done", source, first.id]), { code: "23503" });
  await assert.rejects(pool.query(sql, [randomUUID(), one.id, "invalid", source, null]), { code: "23514" });
  await pool.query(sql, [randomUUID(), one.id, "done", source, first.id]);
  await assert.rejects(pool.query(sql, [randomUUID(), one.id, "done", source, first.id]), { code: "23505" });
});

test("database migration detects missing integrity constraints and altered history", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE public.project_entries DROP CONSTRAINT entry_project_revision");
    await assert.rejects(verifyProjectSchema(client), /constraints/);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("UPDATE public.lab_schema_migrations SET checksum=$1 WHERE id='002_project_workspace'", ["0".repeat(64)]);
    await assert.rejects(verifyProjectSchema(client), /ledger/);
    await client.query("ROLLBACK");
    await verifyProjectSchema(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("DDL collision rolls the whole new migration back in an isolated schema fixture", async () => {
  // This fixture runs only in disposable CI PostgreSQL, never through live acceptance.
  await pool.query("CREATE DATABASE project_migration_fixture");
  const fresh = new Pool({ database: "project_migration_fixture", max: 1, connectionTimeoutMillis: 2000, statement_timeout: 3000 });
  const db = await fresh.connect();
  try {
    await db.query("CREATE TABLE public.project_entries (collision BOOLEAN)");
    await assert.rejects(applyProjectMigration(db), { code: "42P07" });
    const result = await db.query("SELECT to_regclass('public.projects') AS projects, to_regclass('public.lab_schema_migrations') AS ledger");
    assert.deepEqual(result.rows[0], { projects: null, ledger: null });
  } finally { db.release(); await fresh.end(); }
});
