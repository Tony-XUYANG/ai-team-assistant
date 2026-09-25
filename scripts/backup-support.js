const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const summarySql = String.raw`
SELECT jsonb_build_object(
  'rowCount', (SELECT count(*) FROM public.links),
  'dataSha256', (SELECT encode(sha256(convert_to(COALESCE(string_agg(
    json_build_array(code, url, to_char(created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text, E'\n' ORDER BY code COLLATE "C"
  ), ''), 'UTF8')), 'hex') FROM public.links),
  'titleDataSha256', CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='links' AND column_name='title') THEN
    (SELECT encode(sha256(convert_to(COALESCE(string_agg(json_build_array(code,to_jsonb(l)->'title')::text,
      E'\n' ORDER BY code COLLATE "C"),''),'UTF8')),'hex') FROM public.links l) ELSE NULL END,
  'columns', (SELECT json_agg(c ORDER BY c.ordinal_position) FROM (
    SELECT column_name, data_type, character_maximum_length, is_nullable,
      column_default, ordinal_position
    FROM information_schema.columns WHERE table_schema='public' AND table_name='links'
  ) c),
  'constraints', (SELECT json_agg(c ORDER BY c.name) FROM (
    SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='public.links'::regclass
  ) c),
  'indexes', (SELECT json_agg(i ORDER BY i.indexname) FROM (
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='links'
  ) i)
);`;

const migrationSummarySql = String.raw`
SELECT jsonb_build_object(
  'rowCount', (SELECT count(*) FROM public.lab_schema_migrations),
  'dataSha256', (SELECT encode(sha256(convert_to(COALESCE(string_agg(
    json_build_array(id,checksum,to_char(applied_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,E'\n' ORDER BY id COLLATE "C"),''),'UTF8')),'hex')
    FROM public.lab_schema_migrations),
  'columns', (SELECT json_agg(c ORDER BY c.ordinal_position) FROM (
    SELECT column_name,data_type,character_maximum_length,is_nullable,column_default,ordinal_position
    FROM information_schema.columns WHERE table_schema='public' AND table_name='lab_schema_migrations'
  ) c),
  'constraints', (SELECT json_agg(c ORDER BY c.name) FROM (
    SELECT conname AS name,contype AS type,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='public.lab_schema_migrations'::regclass
  ) c),
  'indexes', (SELECT json_agg(i ORDER BY i.indexname) FROM (
    SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='lab_schema_migrations'
  ) i)
);`;

function projectSummarySql(table) {
  assert.ok(["projects", "project_entries"].includes(table));
  const timestamps = table === "projects" ? ["created_at", "updated_at"] : ["created_at", "occurred_at"];
  const normalized = timestamps.map(column => `'${column}',to_char(t.${column} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`).join(",");
  return `SELECT jsonb_build_object(
    'rowCount',(SELECT count(*) FROM public.${table}),
    'dataSha256',(SELECT encode(sha256(convert_to(COALESCE(string_agg(
      (to_jsonb(t) || jsonb_build_object(${normalized}))::text,E'\\n' ORDER BY id),''),'UTF8')),'hex')
      FROM public.${table} t),
    'columns',(SELECT json_agg(c ORDER BY ordinal_position) FROM (
      SELECT column_name,data_type,character_maximum_length,is_nullable,column_default,ordinal_position
      FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}') c),
    'constraints',(SELECT json_agg(c ORDER BY name) FROM (
      SELECT conname AS name,contype AS type,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='public.${table}'::regclass) c),
    'indexes',(SELECT json_agg(i ORDER BY indexname) FROM (
      SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='${table}') i)
  );`;
}

function validateBackupTables(tables) {
  assert.ok(Array.isArray(tables));
  const hasMigrations = tables.includes("public.lab_schema_migrations");
  const expected = hasMigrations ? ["public.lab_schema_migrations", "public.links"] : ["public.links"];
  if (tables.includes("public.projects")) {
    assert.ok(hasMigrations, "Project tables require a migration ledger");
    expected.push("public.project_entries", "public.projects");
  }
  assert.deepEqual(tables, expected,
    "Unexpected tables; extend backup verification before continuing");
  return hasMigrations;
}

function backupDirectory(root, id) {
  assert.match(id, /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/,
    "Use a generated backup ID, not an arbitrary path");
  const directory = path.resolve(root, id);
  assert.equal(path.dirname(directory), path.resolve(root));
  return directory;
}

async function checksum(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function verifyArchive(directory, manifest) {
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.archive.file, "database.dump");
  assert.ok(Number.isSafeInteger(manifest.archive.bytes) && manifest.archive.bytes > 5);
  assert.match(manifest.archive.sha256, /^[a-f0-9]{64}$/);
  const file = path.join(directory, "database.dump");
  const actual = await checksum(file);
  assert.equal(actual.bytes, manifest.archive.bytes, "Backup file size changed");
  assert.equal(actual.sha256, manifest.archive.sha256, "Backup checksum mismatch; restore refused");
  const handle = await fs.promises.open(file, "r");
  try {
    const header = Buffer.alloc(5);
    await handle.read(header, 0, 5, 0);
    assert.equal(header.toString("ascii"), "PGDMP", "Not a PostgreSQL custom-format archive");
  } finally { await handle.close(); }
  return file;
}

function validateManifest(manifest) {
  assert.equal(manifest.formatVersion, 1);
  for (const name of ["application", "postgres"]) {
    assert.match(manifest.application[name], /^sha256:[a-f0-9]{64}$/, "Expected immutable local image ID");
  }
  assert.match(manifest.application.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isSafeInteger(manifest.source.summary.rowCount) && manifest.source.summary.rowCount > 0);
  assert.match(manifest.source.summary.dataSha256, /^[a-f0-9]{64}$/);
  for (const name of ["columns", "constraints", "indexes"]) {
    assert.ok(Array.isArray(manifest.source.summary[name]) && manifest.source.summary[name].length > 0);
  }
  for (const link of [manifest.beforeBackup, manifest.afterBackup].filter(Boolean)) {
    assert.match(link.code, /^[a-f0-9]{8}$/);
    assert.equal(typeof link.target, "string");
    assert.ok(["http:", "https:"].includes(new URL(link.target).protocol));
  }
  assert.ok(manifest.beforeBackup, "Backup verification marker is missing");
  if (manifest.source.tables?.includes("public.projects")) {
    validateBackupTables(manifest.source.tables);
    assert.deepEqual(Object.keys(manifest.source.summary.projects || {}).sort(), ["project_entries", "projects"],
      "Project backup evidence is missing");
    for (const table of Object.values(manifest.source.summary.projects)) {
      assert.ok(Number.isSafeInteger(table.rowCount) && table.rowCount >= 0);
      assert.match(table.dataSha256, /^[a-f0-9]{64}$/);
      for (const key of ["columns", "constraints", "indexes"]) assert.ok(Array.isArray(table[key]) && table[key].length > 0);
    }
  }
}

function assertSameData(expected, actual) {
  assert.equal(actual.rowCount, expected.rowCount, "Restored row count differs");
  assert.equal(actual.dataSha256, expected.dataSha256, "Restored record contents differ");
  if (Object.hasOwn(expected, "titleDataSha256")) {
    assert.equal(actual.titleDataSha256, expected.titleDataSha256, "Restored title contents differ");
  }
  if (Object.hasOwn(expected, "migrations")) {
    assert.deepEqual(actual.migrations, expected.migrations, "Restored migration ledger data/schema differ");
  }
  if (Object.hasOwn(expected, "projects")) {
    assert.deepEqual(actual.projects, expected.projects, "Restored project records/schema differ");
  }
  for (const key of ["columns", "constraints", "indexes"]) {
    assert.deepEqual(actual[key], expected[key], "Restored " + key + " differ");
  }
}

function assertOwnedContainer(container, id, name) {
  assert.equal(container.Name, "/" + name, "Unexpected container name");
  assert.equal(container.Config.Labels?.["shortener.lab/restore-run"], id,
    "Container does not belong to this verification; refusing cleanup");
  assert.ok(!(container.Mounts || []).some(mount => ["volume", "bind"].includes(mount.Type)),
    "Unexpected persistent mount; refusing cleanup");
}

function assertDatabaseIsolation(container) {
  assert.equal(container.HostConfig.NetworkMode, "none");
  assert.equal(Object.keys(container.HostConfig.PortBindings || {}).length, 0);
  const destination = "/var/lib/postgresql/data";
  const configured = Object.hasOwn(container.HostConfig.Tmpfs || {}, destination);
  const mounted = (container.Mounts || []).some(m => m.Type === "tmpfs" && m.Destination === destination);
  assert.ok(configured || mounted, "Restore database must use temporary storage");
  assert.ok(!(container.Mounts || []).some(m => ["bind", "volume"].includes(m.Type)),
    "Restore database must not mount persistent data");
}

module.exports = { summarySql, migrationSummarySql, projectSummarySql, validateBackupTables, backupDirectory, checksum, verifyArchive, validateManifest, assertSameData, assertOwnedContainer, assertDatabaseIsolation };
