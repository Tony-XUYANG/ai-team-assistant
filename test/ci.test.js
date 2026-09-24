const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { testSummary, validateImage, verifyRegistryManifest, redactDiagnostics } = require("../scripts/ci-support");

test("CI accepts complete TAP success and rejects skipped, pending or absent results", () => {
  const output = "# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n";
  assert.deepEqual(testSummary(output), { count: 2, passed: 2 });
  for (const changed of ["", output.replace("pass 2", "pass 1"), output.replace("fail 0", "fail 1"),
    output.replace("skipped 0", "skipped 1"), output.replace("todo 0", "todo 1"), output.replace("cancelled 0", "cancelled 1")]) {
    assert.throws(() => testSummary(changed));
  }
});

test("CI publication cannot name an arbitrary external registry", () => {
  assert.equal(validateImage("shortener:ci-123"), "shortener:ci-123");
  for (const image of ["shortener", "ghcr.io/user/app:v1", "shortener:tag;echo", "shortener:", "other:tag"]) {
    assert.throws(() => validateImage(image));
  }
});

test("published bytes and the tested platform digest must both match", () => {
  const bytes = Buffer.from(JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: "sha256:" + "a".repeat(64) } }));
  const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  assert.equal(verifyRegistryManifest(bytes, digest, digest), digest);
  assert.throws(() => verifyRegistryManifest(Buffer.concat([bytes, Buffer.from(" ")]), digest, digest));
  assert.throws(() => verifyRegistryManifest(bytes, digest, "sha256:" + "b".repeat(64)));
  assert.throws(() => verifyRegistryManifest(bytes, null, digest));
});

test("CI container diagnostics redact disposable database passwords", () => {
  const data = JSON.stringify({ Env: ["PGPASSWORD=private-test-1", "POSTGRES_PASSWORD=private-test-2", "PGUSER=ci_lab"] });
  const sanitized = redactDiagnostics(data);
  assert.ok(!sanitized.includes("private-test"));
  assert.deepEqual(JSON.parse(sanitized).Env, ["PGPASSWORD=[REDACTED]", "POSTGRES_PASSWORD=[REDACTED]", "PGUSER=ci_lab"]);
  assert.equal(redactDiagnostics("POSTGRES_PASSWORD=private-test\nnext"), "POSTGRES_PASSWORD=[REDACTED]\nnext");
});
