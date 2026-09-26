const { Client } = require("pg");
const { applyProjectMigration } = require("./scripts/project-migration");
const { applyAuthMigration } = require("./scripts/auth-migration");
const { applyTitleMigration } = require("./scripts/migration-support");

async function migrate() {
  const client = new Client({ connectionTimeoutMillis: 3000, statement_timeout: 5000,
    query_timeout: 6000, application_name: "shortener-schema-migration" });
  client.on("error", () => {});
  try {
    await client.connect();
    // Bootstrap fresh installations; the application never performs DDL itself.
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query("SET LOCAL transaction_timeout='6000ms'");
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(20260924, 1) AS acquired");
    if (!lock.rows[0].acquired) throw Object.assign(new Error("Schema operation busy"), { code: "MIGRATION_BUSY" });
    await client.query(`CREATE TABLE IF NOT EXISTS public.links (
      code VARCHAR(8) PRIMARY KEY, url TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query("COMMIT");
    const title = await applyTitleMigration(client);
    const projects = await applyProjectMigration(client);
    const auth = await applyAuthMigration(client);
    const result = { ...title, migrations: [title, projects, auth] };
    console.log(JSON.stringify({ event: "migration_completed", ...result }));
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Connection loss is possible after a server-side timeout. */ }
    throw error;
  } finally { await client.end(); }
}

if (require.main === module) {
  const timer = setTimeout(() => { console.error('{"event":"migration_deadline"}'); process.exit(2); }, 25000);
  migrate().catch(error => {
    const code = /^[A-Z0-9_]{5,32}$/.test(error.code || "") ? error.code : "MIGRATION_FAILED";
    console.error(JSON.stringify({ event: "migration_failed", code }));
    process.exitCode = 1;
  }).finally(() => clearTimeout(timer));
}

module.exports = { migrate };
