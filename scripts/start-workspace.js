const { spawn, execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs/promises");
const net = require("node:net");
const { randomBytes } = require("node:crypto");
const { promisify } = require("node:util");

const project = path.resolve(__dirname, "..");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const root = path.join(project, ".workspace");
const envFile = path.join(root, ".env");
const args = ["compose", "--project-name", "team-assistant-workspace", "--env-file", envFile, "-f", "workspace.compose.yaml"];

function available(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
async function main() {
  if (process.platform === "win32" && path.parse(project).root.toLowerCase() !== "e:\\") {
    throw Error("Keep this workspace and its generated data on E:");
  }
  await fs.mkdir(root, { recursive: true });
  if (process.platform === "win32") {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true });
    const sid = stdout.trim();
    if (!/^S-1-5-\d+(?:-\d+)+$/.test(sid)) throw Error("Cannot identify local account");
    await promisify(execFile)("icacls.exe", [root, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true });
  }
  const hadCredentials = await fs.access(envFile).then(() => true, () => false);
  const existingVolumes = await promisify(execFile)(docker, ["volume", "ls", "--filter", "label=com.docker.compose.project=team-assistant-workspace", "--format", "{{.Name}}"], { windowsHide: true, timeout: 15000 });
  if (!hadCredentials && existingVolumes.stdout.trim()) throw Error("Existing workspace data has no credential file; restore .workspace/.env before starting");
  // Never replace the generated password: the existing volume was initialized with it.
  try {
    await fs.writeFile(envFile, `WORKSPACE_PASSWORD=${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  const env = { ...process.env };
  if (process.platform === "win32") {
    env.TEMP = env.TMP = path.resolve(project, "../tmp");
    await fs.mkdir(env.TEMP, { recursive: true });
  }
  let runtime;
  try { runtime = JSON.parse(await fs.readFile(path.join(root, "runtime.json"), "utf8")); } catch { /* First startup. */ }
  let port = runtime?.port || 8082;
  if (!Number.isInteger(port) || port < 8082 || port > 8099) throw Error("Invalid workspace port");
  if (!await available(port)) {
    const result = await promisify(execFile)(docker, [...args, "port", "api", "8000"], { cwd: project, env, windowsHide: true, timeout: 15000 })
      .catch(() => ({ stdout: "" }));
    if (result.stdout.trim() !== `127.0.0.1:${port}`) {
      while (port <= 8099 && !await available(port)) port++;
      if (port > 8099) throw Error("No free workspace port in 8082-8099");
    }
  }
  env.WORKSPACE_PORT = String(port);
  await new Promise((resolve, reject) => {
    const child = spawn(docker, [...args, "up", "-d", "--build", "--wait", "--wait-timeout", "120"], { cwd: project, stdio: "inherit", env, windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(Error("Workspace startup failed")));
  });
  const url = `http://127.0.0.1:${port}`;
  await fs.writeFile(path.join(root, "runtime.json"), JSON.stringify({ port, url, updated_at: new Date().toISOString() }, null, 2));
  console.log("Workspace ready: " + url);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
