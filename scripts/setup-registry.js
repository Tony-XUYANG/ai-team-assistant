const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");

const execute = promisify(execFile);
const project = path.resolve(__dirname, "..");
const nodeName = "k3d-shortener-server-0";
const ownerLabel = "shortener.lab/component";

async function docker(...args) {
  return (await execute("docker.exe", args, { cwd: project, timeout: 90000, windowsHide: true,
    env: { ...process.env, TEMP: path.resolve(project, "../tmp"), TMP: path.resolve(project, "../tmp") } })).stdout.trim();
}

async function copyConfig(localFile, remoteFile) {
  const expected = (await fs.readFile(localFile, "utf8")).trim().replace(/\r\n/g, "\n");
  const exists = await docker("exec", nodeName, "sh", "-c", 'if test -f "$1"; then echo yes; else echo no; fi', "check", remoteFile);
  if (exists === "yes") {
    const current = (await docker("exec", nodeName, "cat", remoteFile)).replace(/\r\n/g, "\n");
    assert.equal(current, expected, "Existing registry config differs; refuse to overwrite: " + remoteFile);
    return;
  }
  await docker("exec", nodeName, "mkdir", "-p", path.posix.dirname(remoteFile));
  await docker("cp", localFile, `${nodeName}:${remoteFile}.shortener-new`);
  await docker("exec", nodeName, "mv", `${remoteFile}.shortener-new`, remoteFile);
  assert.equal((await docker("exec", nodeName, "cat", remoteFile)).replace(/\r\n/g, "\n"), expected);
}

async function setupRegistry() {
  assert.equal(path.parse(project).root.toLowerCase(), "e:\\", "Registry setup is limited to the E: lab");
  const node = JSON.parse(await docker("inspect", nodeName))[0];
  assert.ok(node.NetworkSettings.Networks["k3d-shortener"]);
  const config = await docker("exec", nodeName, "cat", "/var/lib/rancher/k3s/agent/etc/containerd/config.toml");
  assert.ok(config.includes('config_path = "/var/lib/rancher/k3s/agent/etc/containerd/certs.d"'));
  const existing = await docker("ps", "-aq", "--filter", "name=^/shortener-registry$");
  if (existing) {
    const container = JSON.parse(await docker("inspect", "shortener-registry"))[0];
    assert.equal(container.Config.Labels?.[ownerLabel], "registry", "Container name is owned by another project");
  }
  await fs.mkdir(path.resolve(project, "../registry-data"), { recursive: true });
  await docker("compose", "-f", "infra/registry.compose.yaml", "up", "-d");
  const container = JSON.parse(await docker("inspect", "shortener-registry"))[0];
  assert.equal(container.Config.Labels[ownerLabel], "registry");
  assert.deepEqual(container.HostConfig.PortBindings["5000/tcp"], [{ HostIp: "127.0.0.1", HostPort: "5001" }]);
  assert.equal(Object.keys(container.HostConfig.PortBindings).length, 1);
  assert.ok(container.Mounts.some(m => m.Destination === "/var/lib/registry" && m.Type === "bind"
    && m.Source.replace(/\\/g, "/").toLowerCase().endsWith("/k8s-learning/registry-data")));
  let healthy = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:5001/v2/", { signal: AbortSignal.timeout(2000) });
      await response.text();
      if (response.status === 200) { healthy = true; break; }
    } catch { /* The registry may still be starting. */ }
    await delay(500);
  }
  assert.ok(healthy, "Registry did not become healthy");
  // K3s reads registries.yaml on the next start; hosts.toml activates this lab endpoint now.
  await copyConfig(path.join(project, "infra/registries.yaml"), "/etc/rancher/k3s/registries.yaml");
  await copyConfig(path.join(project, "infra/registry-hosts.toml"),
    "/var/lib/rancher/k3s/agent/etc/containerd/certs.d/localhost:5001/hosts.toml");
  await docker("exec", nodeName, "wget", "-qO-", "http://shortener-registry:5000/v2/");
  return { host: "localhost:5001", nodeEndpoint: "http://shortener-registry:5000",
    storage: "E:\\k8s-learning\\registry-data", nodeRestarted: false };
}

if (require.main === module) {
  setupRegistry().then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { setupRegistry };
