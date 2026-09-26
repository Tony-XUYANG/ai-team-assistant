const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { hashToken, newToken, validUsername } = require("../auth");

async function main() {
  const [username, ...flags] = process.argv.slice(2);
  assert.ok(validUsername(username), "Usage: node scripts/provision-account.js <username> [--claim-legacy | --reset]");
  assert.ok(flags.every(flag => ["--claim-legacy", "--reset"].includes(flag)) && new Set(flags).size === flags.length);
  assert.ok(!(flags.includes("--claim-legacy") && flags.includes("--reset")));
  const root = path.resolve(__dirname, "..", ".workspace");
  const envFile = path.join(root, ".env");
  await fs.access(envFile);
  const output = path.join(root, `activation-${username}-${randomUUID()}.txt`);
  const token = newToken();
  const input = { username, activationHash: hashToken(token), claimLegacy: flags.includes("--claim-legacy"), reset: flags.includes("--reset") };
  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const prefix = ["compose", "--project-name", "team-assistant-workspace", "--env-file", envFile, "-f", "workspace.compose.yaml"];
  const { stdout } = await promisify(execFile)(docker, [...prefix, "ps", "-q", "api"], { cwd: path.resolve(__dirname, ".."), windowsHide: true });
  const container = stdout.trim();
  assert.match(container, /^[a-f0-9]{12,64}$/, "Start the workspace before provisioning an account");
  const code = `const {Client}=require('pg');const {provisionAccount}=require('./auth-store');
    const input=JSON.parse(process.argv[1]);const db=new Client({connectionTimeoutMillis:2000,statement_timeout:6000});
    (async()=>{try{await db.connect();const result=await provisionAccount(db,input);
      console.log(JSON.stringify({id:result.id,adopted:result.adopted}));}finally{await db.end()}})()
      .catch(error=>{console.error(error.code||error.message);process.exitCode=1});`;
  const result = await promisify(execFile)(docker, ["exec", container, "node", "-e", code, JSON.stringify(input)],
    { cwd: path.resolve(__dirname, ".."), windowsHide: true, timeout: 15000 });
  const provisioned = JSON.parse(result.stdout);
  await fs.writeFile(output, token + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ username, adopted: provisioned.adopted, activationCodeFile: output,
    expiresInHours: 24, loginUrl: "http://127.0.0.1:8082/login" }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
