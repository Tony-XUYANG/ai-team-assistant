const test = require("node:test");
const assert = require("node:assert/strict");
const { runtimeRole, runtimeSecret, required, forbidden, emptyLists,
  databaseFindings, podCredentialFindings, readyApiPods, probeProgram } = require("../scripts/db-access-support");
const { collectAudit } = require("../scripts/verify-db-access");

function access() {
  return { currentUser: runtimeRole, sessionUser: runtimeRole, database: "shortener", serverMajor: 17,
    ...Object.fromEntries(required.map(k => [k, true])), ...Object.fromEntries(forbidden.map(k => [k, false])),
    ...Object.fromEntries(emptyLists.map(k => [k, []])) };
}
function spec() {
  return { automountServiceAccountToken: false, containers: [{ name: "api",
    envFrom: [{ configMapRef: { name: "api-config" } }],
    env: ["PGUSER", "PGPASSWORD", "PGDATABASE"].map(name => ({ name,
      valueFrom: { secretKeyRef: { name: runtimeSecret, key: name } } })) }] };
}
function state() {
  const deployment = { kind: "Deployment", metadata: { name: "api", namespace: "shortener", uid: "deployment-1", generation: 4 },
    spec: { replicas: 2, template: { spec: spec() } },
    status: { observedGeneration: 4, replicas: 2, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2 } };
  const items = [1, 2].map(i => ({ metadata: { name: "api-" + i, namespace: "shortener", uid: "pod-" + i, labels: { app: "api" } },
    spec: spec(), status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "api", ready: true, containerID: "container-" + i, restartCount: 0 }] } }));
  return { deployment, pods: { items } };
}

test("expected restricted identity satisfies catalog policy", () => {
  assert.deepEqual(databaseFindings(access()), []);
});
test("every required privilege is checked and every excess privilege is rejected", () => {
  for (const key of [...required, ...forbidden]) {
    const row = access(); row[key] = !row[key];
    assert.ok(databaseFindings(row).includes("database-policy:" + key), key);
  }
});
test("NULL, omitted, and mistyped catalog evidence cannot pass", () => {
  for (const key of [...required, ...forbidden, ...emptyLists, "database", "currentUser", "sessionUser", "serverMajor"]) {
    const row = access(); delete row[key];
    assert.throws(() => databaseFindings(row), key);
    row[key] = null;
    assert.throws(() => databaseFindings(row), key);
  }
  assert.throws(() => databaseFindings({ ...access(), superuser: "false" }));
});
test("identity switching, owner membership, schema creation and definer escalation fail", () => {
  assert.ok(databaseFindings({ ...access(), sessionUser: "admin" }).includes("runtime-identity-not-separated"));
  assert.ok(databaseFindings({ ...access(), currentUser: "admin" }).includes("runtime-identity-not-separated"));
  for (const key of emptyLists) {
    assert.ok(databaseFindings({ ...access(), [key]: ["unexpected"] }).includes("database-policy:" + key));
  }
  assert.ok(databaseFindings({ ...access(), serverMajor: 18 }).includes("unsupported-postgresql-version"));
});
test("Pod references require a separate runtime Secret and never expose inline values", () => {
  assert.deepEqual(podCredentialFindings(spec()), []);
  const pod = spec();
  pod.containers[0].env[1] = { name: "PGPASSWORD", value: "never-log-this" };
  const result = podCredentialFindings(pod);
  assert.ok(result.includes("inline-credential:api:PGPASSWORD"));
  assert.ok(result.includes("runtime-secret-reference:PGPASSWORD"));
  assert.ok(!JSON.stringify(result).includes("never-log-this"));
});
test("administrator secrets are caught in init, sidecar, and projected volume paths", () => {
  const pod = spec();
  pod.initContainers = [{ name: "wait-for-db", envFrom: [{ secretRef: { name: "db-credentials" } }] }];
  pod.containers.push({ name: "sidecar", env: [{ name: "ADMIN", valueFrom: { secretKeyRef: { name: "db-credentials", key: "password" } } }] });
  pod.volumes = [{ name: "admin", secret: { secretName: "db-credentials" } },
    { name: "projected", projected: { sources: [{ secret: { name: "migration-db-credentials" } }, { serviceAccountToken: {} }] } },
    { name: "host", hostPath: { path: "/" } }];
  const result = podCredentialFindings(pod);
  for (const expected of ["unexpected-secret:wait-for-db:envFrom", "unexpected-secret:sidecar:ADMIN",
    "unexpected-secret:volume:admin", "unexpected-secret:projected:projected", "projected-service-account-token", "unreviewed-volume:host"]) {
    assert.ok(result.includes(expected), expected);
  }
});
test("optional, duplicate and wrong Secret keys fail credential policy", () => {
  for (const mutation of [p => { p.containers[0].env[0].valueFrom.secretKeyRef.optional = true; },
    p => { p.containers[0].env[0].valueFrom.secretKeyRef.key = "POSTGRES_USER"; },
    p => { p.containers[0].env.push(structuredClone(p.containers[0].env[0])); }]) {
    const pod = spec(); mutation(pod);
    assert.ok(podCredentialFindings(pod).includes("runtime-secret-reference:PGUSER"));
  }
});
test("unreviewed service tokens and ephemeral containers are flagged", () => {
  const pod = spec(); delete pod.automountServiceAccountToken;
  pod.ephemeralContainers = [{ name: "debug" }];
  assert.ok(podCredentialFindings(pod).includes("service-account-token-not-disabled"));
  assert.ok(podCredentialFindings(pod).includes("ephemeral-containers-present"));
});
test("audit requires all replicas, not just one healthy Pod", () => {
  const s = state(); assert.equal(readyApiPods(s.deployment, s.pods).length, 2);
  for (const mutate of [s => { s.deployment.status.observedGeneration--; },
    s => { s.pods.items.pop(); }, s => { s.pods.items[1].status.conditions[0].status = "False"; },
    s => { s.pods.items[1].metadata.deletionTimestamp = "now"; }, s => { s.deployment.status.updatedReplicas = 1; }]) {
    const s = state(); mutate(s); assert.throws(() => readyApiPods(s.deployment, s.pods));
  }
});
test("database probe is syntactically valid JavaScript with a read-only bounded connection", () => {
  const code = probeProgram();
  assert.doesNotThrow(() => new Function(code));
  assert.ok(code.includes("BEGIN READ ONLY"));
  assert.ok(code.includes("default_transaction_read_only=on"));
  assert.ok(code.includes("SELECT code,url,title,created_at FROM public.links LIMIT 0"));
  assert.ok(!code.includes("process.env") && !code.includes("pg_authid") && !code.includes("rolpassword"));
});

function fakeKube({ database = access(), changeDeployment = false, restart = false, failure = false } = {}) {
  const s = state(); const calls = []; let deploymentReads = 0; let podReads = 0;
  const kubectl = async (...args) => {
    calls.push(args);
    if (args[0] === "get" && args[1] === "deployment") {
      deploymentReads++;
      if (changeDeployment && deploymentReads === 2) s.deployment.metadata.generation++;
      return JSON.stringify(s.deployment);
    }
    if (args[0] === "get" && args[1] === "pods") {
      podReads++;
      if (restart && podReads === 2) s.pods.items[1].status.containerStatuses[0].restartCount++;
      return JSON.stringify(s.pods);
    }
    if (args[0] === "exec") { if (failure) throw Error("probe failed"); return JSON.stringify(database); }
    throw Error("Unexpected mutating command");
  };
  return { kubectl, calls };
}
test("collector checks every replica without reading Kubernetes Secrets", async () => {
  const f = fakeKube(); const report = await collectAudit(f.kubectl);
  assert.equal(report.status, "catalog-policy-passed");
  assert.equal(report.pods.length, 2);
  assert.equal(f.calls.filter(a => a[0] === "exec").length, 2);
  assert.ok(!f.calls.some(a => a.includes("secret") || a.includes("secrets")));
});
test("collector reports policy violations rather than passing on readiness alone", async () => {
  const f = fakeKube({ database: { ...access(), superuser: true } });
  const report = await collectAudit(f.kubectl);
  assert.equal(report.status, "policy-failed");
  assert.equal(report.findings.filter(f => f.code === "database-policy:superuser").length, 2);
});
test("failed queries, concurrent deploys and container restarts invalidate the audit", async () => {
  for (const options of [{ changeDeployment: true }, { restart: true }, { failure: true }, { database: {} }]) {
    await assert.rejects(collectAudit(fakeKube(options).kubectl));
  }
});
