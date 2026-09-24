const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const projectDir = path.resolve(__dirname, "..");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const baseUrl = "http://127.0.0.1:8080";

function compose(...args) {
  execFileSync(docker, ["compose", ...args], {
    cwd: projectDir,
    stdio: "inherit",
    timeout: 120000,
    windowsHide: true,
  });
}

async function verifyLink(shortPath, target, label) {
  const response = await fetch(`${baseUrl}${shortPath}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 307, label);
  assert.equal(response.headers.get("location"), target, label);
  console.log(`PASS: ${label}`);
}

async function main() {
  const target = "https://example.com/persistent-link";
  const response = await fetch(`${baseUrl}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: target }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 201);
  const link = await response.json();
  await verifyLink(link.short_path, target, "link works before restart");

  compose("restart");
  compose("up", "-d", "--wait", "--wait-timeout", "60");
  await verifyLink(link.short_path, target, "link survives app and database restart");

  compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "60");
  await verifyLink(link.short_path, target, "link survives replacement of both containers");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
