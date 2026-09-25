const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const unitFiles = ["test/logging.test.js", "test/drill-database.test.js", "test/backup.test.js", "test/ci.test.js", "test/resource.test.js", "test/migration.test.js", "test/title.test.js", "test/title-release.test.js", "test/db-access.test.js", "test/projects.test.js"];
const acceptanceFiles = ["test/smoke.test.js", "test/version.test.js", "test/request-id.test.js", "test/title-acceptance.test.js", "test/projects-acceptance.test.js"];

function redactDiagnostics(text) {
  return String(text).replace(/\b(POSTGRES_PASSWORD|PGPASSWORD)=([^"'\s\\]+)/g, "$1=[REDACTED]");
}

function testSummary(output) {
  const value = key => Number(output.match(new RegExp(`^# ${key} (\\d+)\\s*$`, "m"))?.[1]);
  const count = value("tests");
  const passed = value("pass");
  assert.ok(count > 0 && passed === count && value("fail") === 0 && value("skipped") === 0
    && value("cancelled") === 0 && value("todo") === 0, "All CI checks must pass without skips or pending tests");
  return { count, passed };
}

function validateImage(image) {
  assert.match(image, /^shortener:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, "Only local shortener image tags are accepted");
  return image;
}

function verifyRegistryManifest(bytes, digest, expected) {
  assert.match(digest || "", /^sha256:[a-f0-9]{64}$/);
  assert.equal("sha256:" + createHash("sha256").update(bytes).digest("hex"), digest, "Registry manifest hash mismatch");
  assert.equal(digest, expected, "Published artifact differs from tested artifact");
  const manifest = JSON.parse(bytes.toString());
  assert.equal(manifest.mediaType, "application/vnd.oci.image.manifest.v1+json");
  assert.match(manifest.config?.digest || "", /^sha256:[a-f0-9]{64}$/);
  return digest;
}

async function sourceFingerprint(project) {
  const files = ["Dockerfile", ".dockerignore", "package.json", "package-lock.json", "server.js", "app.js", "database.js", "logger.js", "migrate.js", "projects.js", "project-store.js"];
  async function walk(folder) {
    const entries = await fs.readdir(path.join(project, folder), { withFileTypes: true });
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink(), "Source snapshot does not follow symlinks");
      const relative = folder + "/" + entry.name;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  for (const folder of ["scripts", "test", "infra", ".github"]) await walk(folder);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const data = await fs.readFile(path.join(project, file));
    hash.update(file + "\0" + data.length + "\0").update(data);
  }
  return { sha256: hash.digest("hex"), files };
}

module.exports = { unitFiles, acceptanceFiles, testSummary, validateImage, verifyRegistryManifest, sourceFingerprint, redactDiagnostics };
