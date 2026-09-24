const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");
const { log, safeErrorCode } = require("./logger");
const { titleShapeSql, assertTitleShape } = require("./scripts/migration-support");

// Pool reads PGHOST, PGPORT, PGUSER, PGPASSWORD, and PGDATABASE.
const pool = new Pool({
  max: 5,
  connectionTimeoutMillis: 2000,
  statement_timeout: 2000,
});

pool.on("error", (error) => {
  log("error", "database_pool_error", { dependency: "postgresql", errorCode: safeErrorCode(error) });
});

async function initialize() {
  // Migrations run before rollout, not once per replica during startup.
  assertTitleShape((await pool.query(titleShapeSql)).rows);
  await checkHealth();
}

async function createLink(url, title = null) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomBytes(4).toString("hex");
    const result = await pool.query(
      "INSERT INTO links (code, url, title) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING RETURNING code, url, title",
      [code, url, title],
    );
    if (result.rowCount === 1) return result.rows[0];
  }
  throw new Error("Could not allocate a unique short code");
}

async function findLink(code) {
  const result = await pool.query("SELECT url FROM links WHERE code = $1", [code]);
  return result.rows[0]?.url;
}

async function checkHealth() {
  await pool.query("SELECT code, url, title, created_at FROM public.links LIMIT 0");
}

async function getLink(code) {
  return (await pool.query("SELECT code, url, title FROM public.links WHERE code = $1", [code])).rows[0];
}

module.exports = {
  initialize,
  createLink,
  findLink,
  getLink,
  checkHealth,
  close: () => pool.end(),
};
