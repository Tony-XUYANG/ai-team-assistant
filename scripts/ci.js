const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs, promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { version } = require("../package.json");
const { assertOwnedContainer, assertDatabaseIsolation } = require("./backup-support");
const { unitFiles, acceptanceFiles, testSummary, validateImage, sourceFingerprint, redactDiagnostics } = require("./ci-support");
const { verifyMigrationResults } = require("./title-release-support");
const { projectSummarySql } = require("./backup-support");
const { createContractValidator } = require("./api-contract-support");

const execute = promisify(execFile);
const project = path.resolve(__dirname, "..");
const temp = path.resolve(project, "../tmp");
const dockerPath = process.platform === "win32" ? "docker.exe" : "docker";

async function runCI({ image, runDir, drillFail = false, oldImage }) {
  validateImage(image);
  if (oldImage) assert.match(oldImage, /^sha256:[a-f0-9]{64}$/);
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(temp, { recursive: true });
  const id = "ci-" + randomBytes(8).toString("hex");
  const dbName = "shortener-" + id + "-db";
  const apiName = "shortener-" + id + "-api";
  const migrateName = "shortener-" + id + "-migrate";
  const oldName = "shortener-" + id + "-old";
  const attempted = [];
  const report = { id, image, version, startedAt: new Date().toISOString(), status: "started",
    phase: "unit-tests", drillFail, published: false };
  async function run(executable, args, extraEnv = {}, timeout = 120000) {
    try {
      const result = await execute(executable, args, { cwd: project, windowsHide: true, timeout,
        maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...extraEnv, TEMP: temp, TMP: temp } });
      await fs.appendFile(path.join(runDir, "ci-commands.log"), redactDiagnostics(`${path.basename(executable)} ${args.join(" ")}\n${result.stdout}${result.stderr}\n`));
      return result.stdout.trim();
    } catch (error) {
      await fs.appendFile(path.join(runDir, "ci-commands.log"), redactDiagnostics(`FAILED ${path.basename(executable)} ${args.join(" ")}\n${error.stdout || ""}${error.stderr || ""}\n`));
      throw new Error(redactDiagnostics(`${path.basename(executable)} ${args[0]} failed: ${(error.stderr || error.stdout || error.message).trim()}`));
    }
  }
  const docker = (...args) => run(dockerPath, args);
  async function installTests() {
    const files = [];
    const installed = [...acceptanceFiles, "test/projects-database.test.cjs", "test/api-contract-samples.cjs"];
    for (const name of installed) files.push({ name, data: (await fs.readFile(path.join(project, name))).toString("base64") });
    const installer = `
      const fs=require('node:fs');
      const assert=require('node:assert/strict');
      const files=JSON.parse(fs.readFileSync(0,'utf8'));
      for(const file of files){
        assert.ok(${JSON.stringify(installed)}.includes(file.name));
        fs.writeFileSync('/app/'+file.name,Buffer.from(file.data,'base64'),{flag:'wx'});
      }
    `;
    await new Promise((resolve, reject) => {
      const child = spawn(dockerPath, ["exec", "-i", apiName, "node", "-e", installer], {
        cwd: project, windowsHide: true, env: { ...process.env, TEMP: temp, TMP: temp }, stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      const timer = setTimeout(() => child.kill(), 15000);
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
      child.stdin.on("error", () => {});
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("Writing tests to the isolated tmpfs failed: " + stderr));
      });
      child.stdin.end(JSON.stringify(files));
    });
    await fs.appendFile(path.join(runDir, "ci-commands.log"), "Installed acceptance test files into candidate tmpfs via stdin\n");
  }
  async function cleanup() {
    const removed = [];
    for (const name of [...attempted].reverse()) {
      const existing = await docker("ps", "-aq", "--filter", "name=^/" + name + "$");
      if (!existing) continue;
      const container = JSON.parse(await docker("inspect", name))[0];
      assertOwnedContainer(container, id, name);
      await docker("rm", "--force", name);
      assert.equal(await docker("ps", "-aq", "--filter", "name=^/" + name + "$"), "");
      removed.push(name);
    }
    return { verified: true, removed };
  }
  try {
    report.source = await sourceFingerprint(project);
    console.log("CI: running isolated source tests");
    const tests = [...unitFiles, ...(drillFail ? ["test/fixtures/ci-fail.fixture.cjs"] : [])];
    const output = await run(process.execPath, ["--test", "--test-reporter=tap", ...tests]);
    report.unit = { files: tests, ...testSummary(output) };
    await fs.writeFile(path.join(runDir, "unit.tap"), output + "\n");
    report.phase = "build";
    console.log("CI: building candidate " + image);
    await docker("build", "--platform=linux/amd64", "--label", "shortener.lab/source-sha256=" + report.source.sha256,
      "--label", "shortener.lab/ci-run=" + id, "-t", image, ".");
    const candidate = JSON.parse(await docker("image", "inspect", "--platform=linux/amd64", image))[0];
    assert.match(candidate.Descriptor?.digest || "", /^sha256:[a-f0-9]{64}$/);
    report.platformDigest = candidate.Descriptor.digest;
    report.localImageId = JSON.parse(await docker("image", "inspect", image))[0].Id;
    assert.equal(candidate.Config.Labels["shortener.lab/source-sha256"], report.source.sha256);
    report.phase = "candidate-integration";
    const pgImage = JSON.parse(await docker("image", "inspect", "postgres:17-alpine"))[0].Id;
    const password = randomBytes(24).toString("hex");
    attempted.push(dbName);
    await run(dockerPath, ["run", "-d", "--pull=never", "--platform=linux/amd64", "--name", dbName,
      "--label", "shortener.lab/restore-run=" + id, "--network", "none", "--memory", "256m", "--cpus", "0.5",
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=134217728", "--pids-limit", "128",
      "--env", "POSTGRES_USER=ci_lab", "--env", "POSTGRES_DB=ci_lab", "--env", "POSTGRES_PASSWORD",
      pgImage, "postgres", "-c", "shared_buffers=16MB", "-c", "max_connections=15"], { POSTGRES_PASSWORD: password });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await docker("exec", dbName, "pg_isready", "-h", "127.0.0.1", "-U", "ci_lab", "-d", "ci_lab"); ready = true; break; }
      catch { await delay(500); }
    }
    assert.ok(ready, "CI database did not become ready");
    assertDatabaseIsolation(JSON.parse(await docker("inspect", dbName))[0]);
    const credentials = ["--env", "PGHOST=127.0.0.1", "--env", "PGPORT=5432", "--env", "PGUSER=ci_lab",
      "--env", "PGDATABASE=ci_lab", "--env", "PGPASSWORD"];
    attempted.push(migrateName);
    await run(dockerPath, ["run", "-d", "--pull=never", "--name", migrateName, "--label", "shortener.lab/restore-run=" + id,
      "--network", "container:" + dbName, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "1000:1000", "--memory", "128m", "--cpus", "0.5", "--no-healthcheck", ...credentials,
      "--entrypoint", "sleep", report.localImageId, "120"], { PGPASSWORD: password });
    await docker("exec", migrateName, "node", "-e", `
      const db=require('./database');
      (async()=>{let rejected=false;try{await db.initialize()}catch{rejected=true}finally{await db.close()}
        if(!rejected)throw Error('Missing schema must fail startup');console.log('Unmigrated startup rejected')})()
        .catch(()=>process.exit(1));`);
    report.migration = JSON.parse(await docker("exec", migrateName, "node", "migrate.js"));
    verifyMigrationResults(report.migration);
    assert.equal(report.migration.status, "applied");
    report.repeatMigration = JSON.parse(await docker("exec", migrateName, "node", "migrate.js"));
    verifyMigrationResults(report.repeatMigration);
    assert.ok(report.repeatMigration.migrations.every(item => item.status === "already_applied"));
    assert.equal(report.repeatMigration.status, "already_applied");
    const migrationContainer = JSON.parse(await docker("inspect", migrateName))[0];
    assertOwnedContainer(migrationContainer, id, migrateName);
    await docker("rm", "--force", migrateName);
    attempted.push(apiName);
    await run(dockerPath, ["run", "-d", "--pull=never", "--platform=linux/amd64", "--name", apiName,
      "--label", "shortener.lab/restore-run=" + id, "--network", "container:" + dbName,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
      "--memory", "128m", "--cpus", "0.5", "--pids-limit", "64",
      "--tmpfs", "/app/test:rw,noexec,nosuid,size=2097152,mode=1777",
      "--env", "PGHOST=127.0.0.1", "--env", "PGPORT=5432", "--env", "PGUSER=ci_lab",
      "--env", "PGDATABASE=ci_lab", "--env", "PGPASSWORD", report.localImageId], { PGPASSWORD: password });
    await docker("exec", apiName, "node", "-e", `
      (async()=>{for(let i=0;i<40;i++){
        try{const r=await fetch('http://127.0.0.1:8000/health',{signal:AbortSignal.timeout(2000)});
          const data=await r.json(); if(r.status===200&&data.database==='ok')return;
        }catch{} await new Promise(resolve=>setTimeout(resolve,300));
      }process.exit(1)})()`);
    await installTests();
    const acceptance = await docker("exec", "--env", "TEST_BASE_URL=http://127.0.0.1:8000",
      "--env", "EXPECTED_VERSION=" + version, apiName, "node", "--test", "--test-reporter=tap", ...acceptanceFiles);
    report.candidate = { files: acceptanceFiles, ...testSummary(acceptance),
      database: "isolated tmpfs PostgreSQL", sourceCredentialsUsed: false };
    await fs.writeFile(path.join(runDir, "candidate.tap"), acceptance + "\n");
    report.phase = "api-contract";
    const samples = JSON.parse(await docker("exec", apiName, "node", "test/api-contract-samples.cjs"));
    const contractValidator = createContractValidator();
    for (const sample of samples) contractValidator.response(sample);
    report.apiContract = { version: "1", responses: samples.length, verified: true };
    await fs.writeFile(path.join(runDir, "api-contract-samples.json"), JSON.stringify(samples, null, 2) + "\n");
    report.phase = "candidate-integration";
    const databaseTests = await docker("exec", "--env", "SHORTENER_CI_FIXTURE=isolated-tmpfs", apiName,
      "node", "--test", "--test-reporter=tap", "test/projects-database.test.cjs");
    report.database = testSummary(databaseTests);
    await fs.writeFile(path.join(runDir, "database.tap"), databaseTests + "\n");
    await docker("exec", dbName, "pg_dump", "-U", "ci_lab", "-d", "ci_lab", "--format=custom", "--no-owner", "--no-acl",
      "--file=/var/lib/postgresql/data/ci-restore.dump");
    await docker("exec", dbName, "createdb", "-U", "ci_lab", "ci_restored");
    await docker("exec", dbName, "pg_restore", "-U", "ci_lab", "-d", "ci_restored", "--exit-on-error", "--single-transaction",
      "--no-owner", "--no-acl", "/var/lib/postgresql/data/ci-restore.dump");
    const restoreCheck = `const assert=require('node:assert/strict');const {Client}=require('pg');let phase='connect';
      (async()=>{const source=new Client({statement_timeout:3000}),restored=new Client({database:'ci_restored',statement_timeout:3000});
        try {await source.connect();await restored.connect();
          for(const [table,sql] of ${JSON.stringify(["projects", "project_entries"].map(table => [table, projectSummarySql(table)]))}) {
            phase=table+':query';
            const a=(await source.query(sql)).rows[0].jsonb_build_object;
            const b=(await restored.query(sql)).rows[0].jsonb_build_object;
            for(const key of Object.keys(a)){phase=table+':'+key;assert.deepEqual(a[key],b[key]);}
          }
          phase='schema';
          await require('./scripts/project-migration').verifyProjectSchema(restored);
          console.log(JSON.stringify({projectTablesRestored:true,contentsAndSchemaMatch:true}));
        } finally {await source.end();await restored.end()}
      })().catch(error=>{console.error(JSON.stringify({event:'project_restore_failed',phase,code:error.code||error.name,
        ...(phase.endsWith(':constraints')?{source:error.actual,restored:error.expected}:{})}));process.exit(1)});`;
    report.projectRestore = JSON.parse(await docker("exec", apiName, "node", "-e", restoreCheck));
    if (oldImage) {
      attempted.push(oldName);
      await run(dockerPath, ["run", "-d", "--pull=never", "--name", oldName, "--label", "shortener.lab/restore-run=" + id,
        "--network", "container:" + dbName, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "1000:1000", "--memory", "128m", "--cpus", "0.5", "--no-healthcheck", ...credentials,
        "--env", "PORT=8001", oldImage], { PGPASSWORD: password });
      report.oldNewCompatibility = JSON.parse(await docker("exec", apiName, "node", "-e", `
        const assert=require('node:assert/strict');
        async function req(port,route,options={}){const r=await fetch('http://127.0.0.1:'+port+route,
          {...options,redirect:'manual',signal:AbortSignal.timeout(3000)});const text=await r.text();
          return {status:r.status,location:r.headers.get('location'),data:text?JSON.parse(text):null};}
        (async()=>{let ready=false;for(let i=0;i<30;i++){try{if((await req(8001,'/health')).status===200){ready=true;break}}catch{}
          await new Promise(r=>setTimeout(r,300));}assert.ok(ready);
          const old=await req(8001,'/links',{method:'POST',body:JSON.stringify({url:'https://example.com/old-writer'})});
          assert.equal(old.status,201);const legacy=await req(8000,'/links/'+old.data.code);assert.equal(legacy.status,200);assert.equal(legacy.data.title,null);
          const modern=await req(8000,'/links',{method:'POST',body:JSON.stringify({url:'https://example.com/new-writer',title:'kept across rollback'})});
          assert.equal(modern.status,201);assert.equal(modern.data.title,'kept across rollback');
          const redirect=await req(8001,modern.data.short_path);assert.equal(redirect.status,307);assert.equal(redirect.location,modern.data.url);
          console.log(JSON.stringify({oldImage:${JSON.stringify(oldImage)},oldWriteNewRead:true,newWriteOldRedirect:true}));
        })().catch(e=>{console.error(e.message);process.exit(1)});`));
    }
    assert.equal((await sourceFingerprint(project)).sha256, report.source.sha256, "Source changed during CI; do not publish");
    assert.equal(JSON.parse(await docker("image", "inspect", "--platform=linux/amd64", image))[0].Descriptor.digest,
      report.platformDigest, "Candidate tag changed during CI");
    report.status = "succeeded";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
  } finally {
    try { report.cleanup = await cleanup(); }
    catch (error) { report.status = "failed"; report.cleanup = { verified: false, error: error.message }; }
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(runDir, "ci-report.json"), JSON.stringify(report, null, 2));
  }
  assert.equal(report.status, "succeeded", `CI rejected candidate in ${report.phase}; see ${path.join(runDir, "ci-report.json")}\n${report.error || report.cleanup?.error}`);
  console.log(`CI PASS: ${report.unit.count} source, ${report.candidate.count} API, ${report.database.count} PostgreSQL checks; project restore verified`);
  return report;
}

if (require.main === module) {
  const { values } = parseArgs({ options: { "drill-fail": { type: "boolean", default: false } } });
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(4).toString("hex");
  runCI({ image: `shortener:ci-${id.toLowerCase()}`, runDir: path.join(project, ".ci", id), drillFail: values["drill-fail"] })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runCI };
