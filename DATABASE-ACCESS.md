# Database Access Boundaries

## Status: preparation only, not deployed

On September 24, 2026, the next exercise was started: separate the runtime
database account from the schema migration account. No database users, passwords,
grants, ownership, Kubernetes Secrets, or Deployment templates were changed.
The accepted application remains the previously accepted 3.3.0 image. Local npm
script additions are not a new application release.

### Current recovery result: September 24, 2026, 19:44 Asia/Shanghai

The user recovered `WslService` from `Stop Pending` using an elevated terminal.
Afterward, distribution enumeration and an Ubuntu command completed. Docker
started, and the existing `shortener` cluster and local registry were started
without recreating them. Other projects and the earlier Compose stack were left
stopped. The WSL memory limit remains 2GB (Linux reported 1901MiB usable memory)
and swap remains 2GB. Recovery without changing that limit does not establish
the original root cause or guarantee capacity for larger workloads.

Verified at 19:43 local time:

- Both API Pods and `db-0` were Ready with their original names and UIDs. Each
  container had one restart following the environment restart, not zero.
- PVC UID `d6db7762-1e9e-4311-8b5a-45a84c08642c` remained Bound; the accepted
  3.3.0 image digest was unchanged.
- All 39 rows from the accepted release's pre-migration set matched their saved
  content hash. The saved title marker and migration ledger also matched.
- The database initially contained 60 links. This is not a whole-database
  pre-crash hash comparison; no complete 60-row pre-crash snapshot was available.
- All 73 source/live tests passed: 62 offline and 11 live. Live tests added five
  links. The backup workflow then added before/after-snapshot verification links.
- Backup `backup-2026-09-24T11-43-48-070Z-24ad260c` contains 66 snapshot rows and
  passed an isolated restore, full record/title/schema/ledger comparisons, and
  application read/write checks. Live health sampling: 10 passed, 0 failed.
  Temporary restore containers were removed and live workloads were unchanged.
- The read-only audit completed as `policy-failed`, correctly identifying the
  existing superuser login `shortener` on both replicas. Its report is
  `.incidents/db-access-2026-09-24T11-42-18-082Z-f749ca04/report.json`.

Both audit and backup operation locks were released. No role grants, passwords,
Secrets, or application Deployment configuration changed during recovery.
The backup restore report is under the backup directory at
`verifications/verify-2026-09-24T11-43-48-073Z-d06a25a5/report.json`.
Only local application/registry connectivity was exercised; an Ubuntu startup
warning reported NAT networking falling back to VirtioProxy, and external
image downloads were not tested in this recovery.

The incident notes below are historical, not outstanding recovery instructions.

### Initial failure

Initial live verification was blocked by Docker/WSL startup failures:
`Wsl/Service/CreateInstance/CreateVm/HCS/0x800705aa` and
`Wsl/Service/AttachDisk/CreateVm/HCS/0x800705aa`. Kubernetes on port 6550
was unavailable. WSL shutdown and Docker restarts did not recover the engine;
restarting `WslService` was denied to the current session. Ubuntu started once,
but a later start failed with the same error. This does not establish a specific
root cause beyond the reported system-resource failure. No system reboot,
unregistration, factory reset, volume deletion, or data-disk rebuild was performed.

The source configuration still has these known dependencies:

- `k8s/30-api.yaml` supplies administrator credentials to API and init containers.
- The migration Job copies API environment references in `title-release-support.js`.
- Release verification reads the migration ledger through an API Pod connection.
- CI currently uses a single temporary administrator for migrations and API tests.
- Backups omit database roles and ACLs. Restoring rows does not restore privilege boundaries.

## Read-only acceptance tool

### Follow-up after the Windows restart

Windows reported a new boot at September 24, 2026, 19:19:27 (Asia/Shanghai).
Recovery was not successful: Docker waited for its internal init API, `docker ps`
returned HTTP 500, and Kubernetes port 6550 refused connections. The historical
`0x800705aa` log entries predate this reboot; they are not a newly observed error
code for this attempt.

`wsl --version` completed (2.7.12.0), but distribution enumeration timed out
after 15 seconds and again after 12 seconds. Docker's normal stop timed out;
its user processes were subsequently stopped. `wsl --shutdown` also timed out
after 20 seconds. All diagnostic command sessions were reaped. The current shell
is not an elevated administrator. No new database or Kubernetes changes were made.

The next action requested at that time was, in an elevated PowerShell, to try
`Restart-Service -Name WslService -ErrorAction Stop`, then, only if that finishes,
run `wsl --list --verbose`. Report errors or a wait longer than 30 seconds; do not
repeat resets or unregister distributions. Keep Docker closed for this check.
Service restart is a recovery attempt, not a proven fix. If it remains stuck,
collect focused WSL diagnostic evidence before further changes.

Verification before the reboot: all 62 offline source tests passed, including
13 new access-audit tests. The real cluster invocation returned `incomplete`
and released its operation lock. Its retained report is
`.incidents/db-access-2026-09-24T11-15-53-477Z-8f99e929/report.json`.
At that time the E: Docker data-disk file existed, but database contents could
not be revalidated while the engine was unavailable. The successful live
baseline audit and data checks are recorded in the current recovery result above.

The Windows restart alone did not restore service; the later elevated WSL
service recovery did. Do not reset Docker Desktop, unregister a WSL distribution,
or remove the data disk as a routine recovery action.

From `E:\k8s-learning\shortener`:

```powershell
npm.cmd run test:db-access
npm.cmd run audit:db-access
```

The audit has no apply mode and does not read Kubernetes Secret values. It uses
the existing operation lock, checks a stable Deployment and every API replica,
and runs bounded read-only PostgreSQL catalog queries using each API container's
actual environment. It verifies a required-column query without returning rows.
Reports go to `.incidents/db-access-<timestamp>-<suffix>/report.json` on E:.
Query errors are recorded as safe failure codes, not raw command diagnostics.

Results:

| Status | Meaning | Exit code |
| --- | --- | --- |
| `catalog-policy-passed` | All scoped checks passed on every stable replica | 0 |
| `policy-failed` | Complete evidence found an account or credential-policy violation | 1 |
| `incomplete` | Evidence could not be collected, changed during collection, or cleanup failed | 1 |

The prospective policy expects a `shortener_app` login using explicit `PGUSER`,
`PGPASSWORD`, and `PGDATABASE` references to `api-db-credentials`. These names are
reserved by the policy only; the tool does not create them. It allows CONNECT,
public schema USAGE, SELECT/INSERT on links, and SELECT on the migration ledger
for the current release checker. It rejects write access to the ledger, elevated
role attributes, role membership/switching, object ownership, temporary/schema
creation, grant options, and unexpected user-defined security-definer functions.
The SQL policy is explicitly scoped to PostgreSQL 17.

This is a point-in-time audit, not proof of successful role provisioning or a
whole-cluster security certification. It does not inspect Secret contents,
ConfigMap contents, image contents, all databases, network authentication rules,
Kubernetes RBAC, backup secrecy, future objects, or every possible escalation
path. Negative SQL probes and authentication tests still require an isolated
database. Unit tests use fabricated catalog/Kubernetes responses and cannot
prove the SQL executes correctly on the real PostgreSQL server.

## Next controlled implementation

1. Completed: restore Docker/WSL and verify the original cluster/PVC and recorded data.
2. Completed: retain the expected failing audit against the unchanged baseline.
3. Completed for this session: verify a fresh backup. Recheck its freshness and
   accepted image match before changing ownership or ACLs in a later session.
4. In a disposable PostgreSQL 17 instance, provision runtime and non-superuser
   migration logins. Prove allowed reads/inserts, real rejected SQL operations,
   repeat migrations, application startup, and credential authentication.
5. Test a narrow ownership/grant change for the two known tables. Do not use
   database-wide ownership reassignment, inherit the administrator role, or grant
   runtime access to every future table by default.
6. Give the migration Job explicit migration Secret references. Remove the admin
   Secret from all API Pod containers, including the init container. Generate new
   credentials through protected process input; do not persist them in reports.
7. Roll the existing 3.3 image onto runtime credentials with guarded template
   updates, availability sampling, per-Pod identity checks, API acceptance tests,
   preserved-row hashes, and a saved recovery template.
8. Exercise the release pipeline and an isolated backup restoration with rebuilt
   role/grant policy. Record where new credentials come from during recovery.

Do not use the historical 3.2 binary as an assumed rollback target after reducing
privileges: it performs startup DDL. A rollback must be tested with both the exact
binary and its credential/template contract. Do not silently restore administrator
access just to make a deployment appear healthy.

## Application-owner decisions

- Specify the actual business operations the service needs, not a generic admin role.
- Treat schema deployment credentials separately from request-serving credentials.
- Verify all containers and replicas, not only the main process of one healthy Pod.
- Require rejection evidence as well as successful requests.
- Distinguish restored data from restored security policy.
- If infrastructure is unavailable, preserve evidence and avoid unverified live changes.

## Official references consulted

- PostgreSQL 17: System Information Functions and Operators, access privilege
  inquiry functions (`has_table_privilege`, `has_any_column_privilege`, `pg_has_role`).
- Kubernetes: Good practices for Kubernetes Secrets, restrict credential access
  to containers that need it.
- Kubernetes: Distribute Credentials Securely Using Secrets, environment-variable
  consumers need container restart to observe an updated Secret.
- Microsoft Learn: WSL Troubleshooting Guide, distinguish userspace, distro, and
  WSL startup failures before choosing remediation.
