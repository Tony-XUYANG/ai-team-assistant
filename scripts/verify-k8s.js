const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const projectDir = path.resolve(__dirname, "..");
const learningRoot = path.resolve(projectDir, "..");
const executable = path.join(learningRoot, "bin", "kubectl.exe");
const baseUrl = "http://127.0.0.1:8081";

function kubectl(...args) {
  return execFileSync(executable, [
    "--kubeconfig", path.join(learningRoot, "kubeconfig.yaml"),
    "--cache-dir", path.join(learningRoot, ".kube-cache"),
    "--context", "k3d-shortener", "--request-timeout=15s",
    "-n", "shortener", ...args,
  ], { encoding: "utf8", timeout: 70000, windowsHide: true }).trim();
}

function get(type, name) {
  return JSON.parse(kubectl("get", type, name, "-o", "json"));
}

function pods(label) {
  return JSON.parse(kubectl("get", "pods", "-l", label, "-o", "json")).items;
}

function ready(pod) {
  return !pod.metadata.deletionTimestamp &&
    pod.status.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True");
}

async function waitFor(description, predicate) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(2000);
  }
  throw new Error(`Timed out: ${description}`);
}

async function checkLink(shortPath, target) {
  const response = await fetch(`${baseUrl}${shortPath}`, {
    redirect: "manual", signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), target);
}

async function waitForLink(shortPath, target) {
  let transientFailures = 0;
  await waitFor("link service recovery", async () => {
    let response;
    try {
      response = await fetch(`${baseUrl}${shortPath}`, {
        redirect: "manual", signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
      transientFailures += 1;
      return false;
    }
    if (response.status === 503) {
      await response.text();
      transientFailures += 1;
      return false;
    }
    assert.equal(response.status, 307, "A missing saved link must not be retried");
    assert.equal(response.headers.get("location"), target);
    return true;
  });
  console.log(`Service recovered after ${transientFailures} transient failed requests`);
}

async function main() {
  assert.equal(get("deployment", "api").spec.replicas, 2, "This lab test expects two API replicas");
  await waitFor("two ready API pods", () => pods("app=api").filter(ready).length === 2);
  const target = "https://example.com/k8s-persistent-link";
  const response = await fetch(`${baseUrl}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: target }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 201);
  const link = await response.json();
  await checkLink(link.short_path, target);

  // Read through both replicas to verify they share the same database.
  for (const pod of pods("app=api")) {
    const code = `fetch('http://127.0.0.1:8000/${link.code}',{redirect:'manual'}).then(r=>{if(r.status!==307||r.headers.get('location')!==${JSON.stringify(target)})process.exit(1)}).catch(()=>process.exit(1))`;
    kubectl("exec", pod.metadata.name, "-c", "api", "--", "node", "-e", code);
  }
  console.log("PASS: both API replicas resolve the same database-backed link");

  const oldApi = pods("app=api")[0];
  console.log(`Deleting API pod ${oldApi.metadata.name}`);
  kubectl("delete", "pod", oldApi.metadata.name, "--wait=true", "--timeout=60s");
  await waitFor("API replacement", () => {
    const current = pods("app=api");
    return current.length === 2 && current.every(ready) &&
      current.every((pod) => pod.metadata.uid !== oldApi.metadata.uid);
  });
  await checkLink(link.short_path, target);
  console.log("PASS: Kubernetes replaces the API pod; the link still works");

  const oldDb = get("pod", "db-0");
  const oldClaim = get("pvc", "data-db-0");
  console.log("Deleting database pod db-0; retaining its PVC");
  kubectl("delete", "pod", "db-0", "--wait=true", "--timeout=60s");
  await waitFor("database replacement", () => pods("app=db").some((pod) =>
    pod.metadata.uid !== oldDb.metadata.uid && ready(pod)));
  await waitFor("API database reconnection", () => pods("app=api").filter(ready).length === 2);
  const newClaim = get("pvc", "data-db-0");
  assert.equal(newClaim.metadata.uid, oldClaim.metadata.uid);
  assert.equal(newClaim.spec.volumeName, oldClaim.spec.volumeName);
  await waitForLink(link.short_path, target);
  await waitFor("ready API pods after recovery", () => pods("app=api").filter(ready).length === 2);
  await checkLink(link.short_path, target);
  console.log("PASS: replacement database pod reuses the PVC and retains the link");
  console.log(`Verified link: ${baseUrl}${link.short_path}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
