const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { backupDirectory, checksum, verifyArchive, validateManifest, assertSameData, assertOwnedContainer, assertDatabaseIsolation, validateBackupTables } = require("../scripts/backup-support");

const root = path.resolve(__dirname, "..", "..", "tmp");
const backupId = "backup-2026-09-24T06-30-00-000Z-1234abcd";
async function fixture(t, bytes = Buffer.from("PGDMP\x00\xff\r\nfixture")) {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "backup-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), root);
    assert.ok(path.basename(directory).startsWith("backup-test-"));
    await fs.rm(directory, { recursive: true });
  });
  await fs.writeFile(path.join(directory, "database.dump"), bytes);
  return { directory, file: path.join(directory, "database.dump"),
    manifest: { formatVersion: 1, archive: { file: "database.dump", ...await checksum(path.join(directory, "database.dump")) } } };
}

test("backup IDs cannot escape the backup root", () => {
  assert.equal(backupDirectory(root, backupId), path.join(root, backupId));
  for (const id of ["../source", "..\\source", "E:\\other", "backup-test", backupId + "/..", ""]) {
    assert.throws(() => backupDirectory(root, id));
  }
});

test("binary archive checksum accepts exact bytes", async t => {
  const f = await fixture(t);
  assert.equal(await verifyArchive(f.directory, f.manifest), f.file);
});

test("same-length archive corruption is rejected", async t => {
  const f = await fixture(t);
  const bytes = await fs.readFile(f.file);
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(f.file, bytes);
  await assert.rejects(verifyArchive(f.directory, f.manifest), /checksum mismatch/);
});

test("truncated archive is rejected", async t => {
  const f = await fixture(t);
  await fs.truncate(f.file, 5);
  await assert.rejects(verifyArchive(f.directory, f.manifest), /size changed/);
});

test("matching hash does not make an invalid archive header acceptable", async t => {
  const f = await fixture(t, Buffer.from("NOTPG-text-data"));
  await assert.rejects(verifyArchive(f.directory, f.manifest), /custom-format/);
});

test("archive metadata cannot redirect the restore to another file", async t => {
  const f = await fixture(t);
  f.manifest.archive.file = "../database.dump";
  await assert.rejects(verifyArchive(f.directory, f.manifest));
});

test("data validation checks contents and schema, not just row counts", () => {
  const data = { rowCount: 2, dataSha256: "a".repeat(64), columns: [{ name: "url" }],
    constraints: [{ name: "links_pkey" }], indexes: [{ name: "links_pkey" }] };
  assert.doesNotThrow(() => assertSameData(data, structuredClone(data)));
  for (const key of Object.keys(data)) {
    const changed = structuredClone(data);
    changed[key] = key === "rowCount" ? 3 : key === "dataSha256" ? "b".repeat(64) : [];
    assert.throws(() => assertSameData(data, changed));
  }
});

test("cleanup only accepts this run's ephemeral container", () => {
  const owned = { Name: "/restore-test", Config: { Labels: { "shortener.lab/restore-run": "run-1" } },
    Mounts: [{ Type: "tmpfs" }] };
  assert.doesNotThrow(() => assertOwnedContainer(owned, "run-1", "restore-test"));
  assert.throws(() => assertOwnedContainer(owned, "run-2", "restore-test"));
  assert.throws(() => assertOwnedContainer(owned, "run-1", "db-0"));
  for (const Type of ["volume", "bind"]) {
    assert.throws(() => assertOwnedContainer({ ...owned, Mounts: [{ Type }] }, "run-1", "restore-test"));
  }
});

test("title-aware backups detect changed titles and preserve legacy archive compatibility", () => {
  const data = { rowCount: 1, dataSha256: "a".repeat(64), columns: [{}], constraints: [{}], indexes: [{}],
    titleDataSha256: "b".repeat(64) };
  assertSameData(data, structuredClone(data));
  assert.throws(() => assertSameData(data, { ...data, titleDataSha256: "c".repeat(64) }), /title contents differ/);
  const legacy = { ...data };
  delete legacy.titleDataSha256;
  assertSameData(legacy, data);
});

test("backup accepts only explicitly verified tables and detects changed migration history", () => {
  assert.equal(validateBackupTables(["public.links"]), false);
  assert.equal(validateBackupTables(["public.lab_schema_migrations", "public.links"]), true);
  for (const tables of [[], ["public.links", "public.unknown"], ["public.lab_schema_migrations"], null]) {
    assert.throws(() => validateBackupTables(tables));
  }
  const expected = { rowCount: 1, dataSha256: "a".repeat(64), columns: [], constraints: [], indexes: [],
    migrations: { rowCount: 1, dataSha256: "b".repeat(64), columns: [{}], indexes: [{}] } };
  assertSameData(expected, structuredClone(expected));
  assert.throws(() => assertSameData(expected, { ...expected, migrations: { ...expected.migrations, rowCount: 0 } }), /migration ledger/);
});

test("manifest rejects mutable images, injected codes, and missing schema evidence", () => {
  const manifest = { formatVersion: 1,
    application: { application: "sha256:" + "a".repeat(64), postgres: "sha256:" + "b".repeat(64), version: "3.2.0" },
    source: { summary: { rowCount: 2, dataSha256: "c".repeat(64), columns: [{}], constraints: [{}], indexes: [{}] } },
    beforeBackup: { code: "1234abcd", target: "https://example.com/test" } };
  assert.doesNotThrow(() => validateManifest(manifest));
  for (const mutate of [
    m => { m.application.application = "shortener:latest"; },
    m => { m.beforeBackup.code = "');process.exit(0);//"; },
    m => { m.source.summary.indexes = null; },
    m => { delete m.beforeBackup; },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.throws(() => validateManifest(changed));
  }
});

test("isolation recognizes both Docker tmpfs representations", () => {
  const container = { HostConfig: { NetworkMode: "none", PortBindings: {} }, Mounts: [] };
  assert.throws(() => assertDatabaseIsolation(container));
  container.HostConfig.Tmpfs = { "/var/lib/postgresql/data": "rw,size=134217728" };
  assert.doesNotThrow(() => assertDatabaseIsolation(container));
  delete container.HostConfig.Tmpfs;
  container.Mounts = [{ Type: "tmpfs", Destination: "/var/lib/postgresql/data" }];
  assert.doesNotThrow(() => assertDatabaseIsolation(container));
  for (const mutate of [
    c => { c.HostConfig.NetworkMode = "bridge"; },
    c => { c.HostConfig.PortBindings = { "5432/tcp": [{}] }; },
    c => { c.Mounts.push({ Type: "bind", Destination: "/production" }); },
  ]) {
    const changed = structuredClone(container);
    mutate(changed);
    assert.throws(() => assertDatabaseIsolation(changed));
  }
});
