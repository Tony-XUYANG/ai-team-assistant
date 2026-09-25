const assert = require("node:assert/strict");
const { applyMigration, migrationChecksum } = require("./migration-support");

const projectMigration = Object.freeze({
  id: "002_project_workspace",
  statements: Object.freeze([
    `CREATE TABLE public.projects (
      id UUID PRIMARY KEY,
      name VARCHAR(120) NOT NULL CHECK (length(btrim(name)) > 0),
      objective VARCHAR(2000) NOT NULL CHECK (length(btrim(objective)) > 0),
      constraints JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(constraints) = 'array'),
      source JSONB NOT NULL CHECK (jsonb_typeof(source) = 'object'),
      status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status::text IN ('active', 'paused', 'archived')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE public.project_entries (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES public.projects(id),
      kind VARCHAR(16) NOT NULL CHECK (kind::text IN ('progress', 'decision', 'blocker', 'action')),
      content VARCHAR(4000) NOT NULL CHECK (length(btrim(content)) > 0),
      verification VARCHAR(16) NOT NULL DEFAULT 'unverified'
        CHECK (verification::text IN ('confirmed', 'unverified', 'disputed')),
      status VARCHAR(16) NOT NULL,
      owner_ref VARCHAR(120),
      source JSONB NOT NULL CHECK (jsonb_typeof(source) = 'object'),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      supersedes_id UUID UNIQUE,
      UNIQUE (project_id, id),
      CONSTRAINT entry_project_revision FOREIGN KEY (project_id, supersedes_id)
        REFERENCES public.project_entries(project_id, id),
      CONSTRAINT entry_not_self CHECK (id IS DISTINCT FROM supersedes_id),
      CONSTRAINT entry_status CHECK (
        (kind::text IN ('progress', 'decision') AND status = 'recorded') OR
        (kind = 'blocker' AND status::text IN ('open', 'resolved')) OR
        (kind = 'action' AND status::text IN ('todo', 'doing', 'done', 'cancelled')))
    )`,
    "CREATE INDEX projects_updated_idx ON public.projects(updated_at DESC, id DESC)",
    "CREATE INDEX project_entries_project_idx ON public.project_entries(project_id, created_at DESC, id DESC)",
  ]),
});

async function verifyProjectSchema(client) {
  await client.query(`SELECT id, name, objective, constraints, source, status, created_at, updated_at
    FROM public.projects LIMIT 0`);
  await client.query(`SELECT id, project_id, kind, content, verification, status, owner_ref,
    source, occurred_at, created_at, supersedes_id FROM public.project_entries LIMIT 0`);
  const history = await client.query("SELECT checksum FROM public.lab_schema_migrations WHERE id = $1", [projectMigration.id]);
  assert.equal(history.rows[0]?.checksum, migrationChecksum(projectMigration), "Project migration ledger mismatch");
  const constraints = await client.query(`SELECT conname, contype, convalidated FROM pg_constraint
    WHERE conrelid = 'public.project_entries'::regclass
      AND conname IN ('entry_project_revision', 'entry_status', 'project_entries_supersedes_id_key')
    ORDER BY conname`);
  assert.deepEqual(constraints.rows, [
    { conname: "entry_project_revision", contype: "f", convalidated: true },
    { conname: "entry_status", contype: "c", convalidated: true },
    { conname: "project_entries_supersedes_id_key", contype: "u", convalidated: true },
  ], "Project integrity constraints are missing");
}

function applyProjectMigration(client) {
  return applyMigration(client, projectMigration, verifyProjectSchema);
}

module.exports = { projectMigration, applyProjectMigration, verifyProjectSchema };
