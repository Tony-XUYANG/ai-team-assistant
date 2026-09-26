const assert = require("node:assert/strict");
const { applyMigration, migrationChecksum } = require("./migration-support");

const authMigration = Object.freeze({
  id: "003_account_sessions",
  statements: Object.freeze([
    `CREATE TABLE public.accounts (
      id UUID PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
      password_hash TEXT,
      activation_hash CHAR(64) UNIQUE,
      activation_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT account_credential CHECK (
        (password_hash IS NOT NULL AND activation_hash IS NULL AND activation_expires_at IS NULL) OR
        (password_hash IS NULL AND activation_hash IS NOT NULL AND activation_expires_at IS NOT NULL))
    )`,
    `ALTER TABLE public.projects ADD COLUMN account_id UUID REFERENCES public.accounts(id)`,
    `CREATE INDEX projects_account_created ON public.projects (account_id, created_at DESC, id DESC)`,
    `CREATE TABLE public.auth_sessions (
      id CHAR(64) PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES public.accounts(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX sessions_account ON public.auth_sessions (account_id, created_at DESC)`,
    `CREATE TABLE public.auth_attempts (
      id CHAR(64) PRIMARY KEY,
      attempts INTEGER NOT NULL CHECK (attempts > 0),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ]),
});

async function verifyAuthSchema(db) {
  const ledger = await db.query("SELECT checksum FROM public.lab_schema_migrations WHERE id=$1", [authMigration.id]);
  assert.equal(ledger.rows[0]?.checksum, migrationChecksum(authMigration), "Account migration ledger mismatch");
  await db.query(`SELECT a.id,a.username,a.password_hash,a.activation_hash,a.activation_expires_at,a.created_at,
    s.id,s.account_id,s.created_at,s.expires_at,p.account_id,r.id,r.attempts,r.started_at
    FROM public.accounts a,public.auth_sessions s,public.projects p,public.auth_attempts r LIMIT 0`);
  const constraints = (await db.query(`SELECT conrelid::regclass::text AS table_name,contype,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid IN ('public.accounts'::regclass,'public.auth_sessions'::regclass,'public.projects'::regclass)`)).rows;
  const tableName = value => value.includes(".") ? value : `public.${value}`;
  const normalized = constraints.map(c => ({ ...c, table_name: tableName(c.table_name),
    definition: c.definition.replace(/\s+/g, " ") }));
  for (const table of ["public.projects", "public.auth_sessions"]) assert.ok(normalized.some(c => c.table_name === table
    && c.contype === "f" && /FOREIGN KEY \(account_id\) REFERENCES (?:public\.)?accounts\(id\)/.test(c.definition)), "Account foreign key missing");
  for (const column of ["username", "activation_hash"]) assert.ok(normalized.some(c => c.table_name === "public.accounts"
    && c.contype === "u" && c.definition === `UNIQUE (${column})`), "Account uniqueness missing");
  assert.ok(normalized.some(c => c.table_name === "public.accounts" && c.contype === "c" && c.definition.includes("password_hash IS NOT NULL")), "Account credential constraint missing");
}

const applyAuthMigration = client => applyMigration(client, authMigration, verifyAuthSchema);
module.exports = { authMigration, applyAuthMigration, verifyAuthSchema };
