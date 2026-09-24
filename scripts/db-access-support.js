const assert = require("node:assert/strict");

const runtimeRole = "shortener_app";
const runtimeSecret = "api-db-credentials";

// Catalog checks are read-only. Negative DDL tests belong in a disposable database.
const accessSql = `SELECT jsonb_build_object(
  'currentUser', current_user, 'sessionUser', session_user,
  'database', current_database(), 'serverMajor', current_setting('server_version_num')::int / 10000,
  'login', r.rolcanlogin, 'superuser', r.rolsuper, 'createRole', r.rolcreaterole,
  'createDatabase', r.rolcreatedb, 'replication', r.rolreplication, 'bypassRls', r.rolbypassrls,
  'connect', has_database_privilege(current_database(), 'CONNECT'),
  'temporary', has_database_privilege(current_database(), 'TEMPORARY'),
  'databaseCreate', has_database_privilege(current_database(), 'CREATE'),
  'databaseOwner', d.datdba = r.oid,
  'schemaUsage', has_schema_privilege('public', 'USAGE'),
  'schemaGrant', has_schema_privilege('public', 'USAGE WITH GRANT OPTION'),
  'databaseGrant', has_database_privilege(current_database(), 'CONNECT WITH GRANT OPTION'),
  'schemaOwner', n.nspowner = r.oid,
  'linksExists', to_regclass('public.links') IS NOT NULL,
  'ledgerExists', to_regclass('public.lab_schema_migrations') IS NOT NULL,
  'linksOwner', COALESCE((SELECT relowner = r.oid FROM pg_class WHERE oid = to_regclass('public.links')), false),
  'ledgerOwner', COALESCE((SELECT relowner = r.oid FROM pg_class WHERE oid = to_regclass('public.lab_schema_migrations')), false),
  'linksSelect', has_table_privilege(to_regclass('public.links'), 'SELECT'),
  'linksInsert', has_table_privilege(to_regclass('public.links'), 'INSERT'),
  'linksForbidden', has_table_privilege(to_regclass('public.links'), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
  'linksColumnForbidden', has_any_column_privilege(to_regclass('public.links'), 'UPDATE,REFERENCES'),
  'linksGrant', has_any_column_privilege(to_regclass('public.links'), 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION'),
  'ledgerSelect', has_table_privilege(to_regclass('public.lab_schema_migrations'), 'SELECT'),
  'ledgerForbidden', has_table_privilege(to_regclass('public.lab_schema_migrations'), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
  'ledgerColumnForbidden', has_any_column_privilege(to_regclass('public.lab_schema_migrations'), 'INSERT,UPDATE,REFERENCES'),
  'ledgerGrant', has_any_column_privilege(to_regclass('public.lab_schema_migrations'), 'SELECT WITH GRANT OPTION'),
  'reachableRoles', COALESCE((SELECT jsonb_agg(x.rolname ORDER BY x.rolname) FROM pg_roles x
    WHERE x.oid <> r.oid AND (pg_has_role(x.oid, 'MEMBER') OR pg_has_role(x.oid, 'SET') OR pg_has_role(x.oid, 'USAGE'))), '[]'::jsonb),
  'writableSchemas', COALESCE((SELECT jsonb_agg(x.nspname ORDER BY x.nspname) FROM pg_namespace x
    WHERE has_schema_privilege(x.oid, 'CREATE')), '[]'::jsonb),
  'executableDefiners', COALESCE((SELECT jsonb_agg(p.oid::regprocedure::text ORDER BY p.oid) FROM pg_proc p
    JOIN pg_namespace s ON s.oid = p.pronamespace WHERE p.prosecdef
    AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND has_function_privilege(p.oid, 'EXECUTE')), '[]'::jsonb)
) AS access
FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
JOIN pg_namespace n ON n.nspname = 'public' WHERE r.rolname = current_user`;

const required = ["login", "connect", "schemaUsage", "linksExists", "ledgerExists", "linksSelect", "linksInsert", "ledgerSelect"];
const forbidden = ["superuser", "createRole", "createDatabase", "replication", "bypassRls", "temporary",
  "databaseCreate", "databaseOwner", "schemaOwner", "schemaGrant", "databaseGrant", "linksOwner", "ledgerOwner",
  "linksForbidden", "linksColumnForbidden", "linksGrant", "ledgerForbidden", "ledgerColumnForbidden", "ledgerGrant"];
const emptyLists = ["reachableRoles", "writableSchemas", "executableDefiners"];

function databaseFindings(access) {
  assert.ok(access && typeof access === "object" && !Array.isArray(access), "Missing database evidence");
  for (const key of ["currentUser", "sessionUser", "database"]) {
    assert.ok(typeof access[key] === "string" && access[key].length > 0, "Invalid database identity evidence");
  }
  assert.ok(Number.isInteger(access.serverMajor), "Missing server version evidence");
  const findings = [];
  if (access.serverMajor !== 17) findings.push("unsupported-postgresql-version");
  if (access.currentUser !== runtimeRole || access.sessionUser !== runtimeRole) findings.push("runtime-identity-not-separated");
  for (const key of [...required, ...forbidden]) {
    // A NULL privilege result often means the target object does not exist.
    assert.equal(typeof access[key], "boolean", "Missing boolean evidence: " + key);
    if (required.includes(key) ? !access[key] : access[key]) findings.push("database-policy:" + key);
  }
  for (const key of emptyLists) {
    assert.ok(Array.isArray(access[key]) && access[key].every(x => typeof x === "string"), "Missing list evidence: " + key);
    if (access[key].length) findings.push("database-policy:" + key);
  }
  return findings;
}

function podCredentialFindings(spec) {
  assert.ok(spec && Array.isArray(spec.containers) && spec.containers.length > 0, "Missing Pod specification");
  const findings = [];
  if (spec.automountServiceAccountToken !== false) findings.push("service-account-token-not-disabled");
  if (spec.ephemeralContainers?.length) findings.push("ephemeral-containers-present");
  const secret = (name, where) => {
    if (name !== runtimeSecret) findings.push("unexpected-secret:" + where);
  };
  const containers = [...spec.containers, ...(spec.initContainers || []), ...(spec.ephemeralContainers || [])];
  for (const c of containers) {
    for (const source of c.envFrom || []) {
      if (source.secretRef) secret(source.secretRef.name, c.name + ":envFrom");
      else if (source.configMapRef?.name !== "api-config") findings.push("unexpected-config-source:" + c.name);
    }
    for (const e of c.env || []) {
      if (e.valueFrom?.secretKeyRef) secret(e.valueFrom.secretKeyRef.name, c.name + ":" + e.name);
      if (["PGPASSWORD", "DATABASE_URL", "POSTGRES_PASSWORD"].includes(e.name) && Object.hasOwn(e, "value")) {
        findings.push("inline-credential:" + c.name + ":" + e.name);
      }
    }
  }
  const api = spec.containers.filter(c => c.name === "api");
  assert.equal(api.length, 1, "Exactly one API container is required");
  for (const key of ["PGUSER", "PGPASSWORD", "PGDATABASE"]) {
    const refs = (api[0].env || []).filter(e => e.name === key);
    if (refs.length !== 1 || refs[0].valueFrom?.secretKeyRef?.name !== runtimeSecret
        || refs[0].valueFrom.secretKeyRef.key !== key || refs[0].valueFrom.secretKeyRef.optional === true) {
      findings.push("runtime-secret-reference:" + key);
    }
  }
  for (const volume of spec.volumes || []) {
    if (volume.secret) secret(volume.secret.secretName, "volume:" + volume.name);
    if (volume.csi || volume.hostPath || volume.persistentVolumeClaim) findings.push("unreviewed-volume:" + volume.name);
    for (const source of volume.projected?.sources || []) {
      if (source.secret) secret(source.secret.name, "projected:" + volume.name);
      if (source.serviceAccountToken) findings.push("projected-service-account-token");
    }
  }
  return [...new Set(findings)];
}

function readyApiPods(deployment, podList) {
  assert.equal(deployment.kind, "Deployment");
  assert.equal(deployment.metadata?.name, "api");
  assert.equal(deployment.metadata?.namespace, "shortener");
  assert.ok(Number.isInteger(deployment.spec.replicas) && deployment.spec.replicas > 0 && !deployment.spec.paused);
  assert.equal(deployment.status?.observedGeneration, deployment.metadata.generation, "Deployment observation is stale");
  for (const key of ["readyReplicas", "availableReplicas", "updatedReplicas", "replicas"]) {
    assert.equal(deployment.status?.[key], deployment.spec.replicas, "Deployment is not stable: " + key);
  }
  assert.ok(Array.isArray(podList.items), "Missing Pod list");
  assert.equal(podList.items.length, deployment.spec.replicas, "Unexpected or terminating API Pods");
  for (const pod of podList.items) {
    assert.equal(pod.metadata?.namespace, "shortener");
    assert.equal(pod.metadata?.labels?.app, "api");
    assert.ok(!pod.metadata.deletionTimestamp && pod.status?.phase === "Running");
    assert.ok(pod.status.conditions?.some(c => c.type === "Ready" && c.status === "True"), "API Pod is not Ready");
    assert.ok(pod.status.containerStatuses?.find(c => c.name === "api")?.ready, "API container is not Ready");
  }
  return podList.items;
}

function probeProgram() {
  return `const {Client}=require('pg');
    const c=new Client({connectionTimeoutMillis:2000,statement_timeout:3000,query_timeout:4000,
      application_name:'shortener-access-audit',options:'-c default_transaction_read_only=on'});
    c.on('error',()=>{});
    const timer=setTimeout(()=>process.exit(2),10000);
    (async()=>{try{await c.connect();await c.query('BEGIN READ ONLY');
      const r=await c.query(${JSON.stringify(accessSql)});
      await c.query('SELECT code,url,title,created_at FROM public.links LIMIT 0');
      await c.query('ROLLBACK');console.log(JSON.stringify(r.rows[0]?.access));
    }finally{await c.end()}})().catch(()=>{console.error('ACCESS_PROBE_FAILED');process.exitCode=1})
      .finally(()=>clearTimeout(timer));`;
}

module.exports = { runtimeRole, runtimeSecret, required, forbidden, emptyLists, accessSql,
  databaseFindings, podCredentialFindings, readyApiPods, probeProgram };
