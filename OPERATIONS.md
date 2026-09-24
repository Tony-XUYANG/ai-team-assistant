# Application Delivery and Operations

## Scope and working style

This project now follows an application-developer workflow: implement a change,
package it, release it, check customer-visible behavior, and recover from failure.
Routine setup and command execution are automated. The learning target is knowing
what you own, what evidence to check, and when to stop or reverse a release.

The assumed role is a JavaScript application developer working with a platform
team. Team boundaries vary; the table below is our learning scope, not a universal
job description. Low-level Linux commands are introduced when they resolve a
real symptom, not as a separate introductory course.

| Area | Application-owner responsibility | Evidence in this project |
| --- | --- | --- |
| Docker | Deliver a reproducible runtime and identify the exact artifact | Dockerfile, lockfile, unique image tag, manifest digest |
| Kubernetes | Declare how the app starts, becomes ready, updates, and stops | Deployment, probes, resource requests/limits, lifecycle settings |
| Linux | Investigate process exits, permissions, listening ports, and resource exhaustion | Pod status, logs, container shell when needed |
| Releases | Define acceptance checks, retain a known-good version, and recover on failure | release-local.js and per-release reports |
| Data | Understand schema compatibility and retention before a change | PostgreSQL PVC and existing-link verification |
| Team coordination | Report symptoms with scope, timestamps, version and evidence | Incident workflow below |

Cluster provisioning, node upgrades, storage infrastructure, organization-wide
RBAC and backups are platform/DBA collaboration topics in this learning path.
The app owner must know the dependencies and failure symptoms, but is not expected
to become the sole operator of every underlying system.

## Completed work item: release version 3.1.0

The product change adds `GET /version`, returning the application version and
the instance hostname. `/health`, `/live`, link creation and redirects keep their
existing contracts. This release does not alter the database schema.

Acceptance criteria:

1. Both application replicas run the intended image digest and report version 3.1.0.
2. The seven endpoint checks pass, including invalid input handling.
3. A link created before the release still redirects after it.
4. Sampled health requests succeed while the release is switching Pods.
5. A failed new revision restores the previous Pod template and remains a failed
   command, even if recovery succeeds.

Observed results from September 24, 2026:

| Run | Result |
| --- | --- |
| Initial automated release | Functional checks passed; 2 of 19 sampled health requests failed during replacement |
| Release after lifecycle adjustment | 7 checks passed; 34 sampled health requests succeeded, 0 failed |
| Deliberate startup-failure drill | New revision failed; prior template restored; saved link retained; 73 sampled health requests succeeded, 0 failed |

The evidence is in `.releases/2026-09-24T05-55-28-927Z-65dc0e2d/`,
`.releases/2026-09-24T05-58-45-925Z-39ec5739/`, and
`.releases/2026-09-24T05-59-29-340Z-996e8b8d/` respectively. Keep the initial failure
report: it explains the change rather than hiding the unsuccessful result.

Zero errors in these samples is limited evidence for this local exercise, not a
production availability guarantee or a load-test result.

## Completed work item: trace and recover a database incident

Version 3.2.0 adds request correlation and structured JSON logs. The accepted
release passed 8 isolated logging tests, 9 live endpoint tests, per-Pod version
checks and saved-link verification. Its 35 health samples passed with no failures.
The accepted digest is recorded in `k8s/30-api.yaml` and in
`.releases/2026-09-24T06-15-44-528Z-d506c930/report.json`.

### What the application now records

Responses handled by the application carry `X-Request-ID`. A supplied ID is
accepted only if it is 1-64 characters from the restricted character set; otherwise
a UUID is generated. IDs are correlation hints, not authentication or proof of
identity. A trusted gateway should own their generation in a production design.

Each JSON record includes UTC timestamp, level, event, version and hostname.
Request completion records also include request ID, method, normalized route,
status and duration. Dependency failures add the operation and an allowlisted
error code; arbitrary database messages and stacks are not serialized. Unknown
codes become `UNCLASSIFIED`, which needs further investigation, not a guess.

Request bodies, destination URLs, URL query strings, authorization headers and
cookies are not copied into application logs. Dynamic short codes use `/:code`
and unknown paths use `unmatched`. Never put secrets in a request ID. Successful
`/live` and `/health` requests are quiet; failed readiness requests are logged.
An internal status of 499 records a disconnected caller, not an HTTP response
successfully delivered to that caller. Logs go to stdout and can be read through
`kubectl logs`; they are not yet shipped to a central log store.

`app.js` separates the HTTP server from process startup so the logging behavior
can be tested with a fake dependency. `database.js` still uses real PostgreSQL
in the deployed service. Startup, shutdown and idle connection failures use the
same structured logger. The release gate runs isolated logging tests before
building/publishing, then tests the deployed service. Test counts come from the
test runner rather than a hardcoded success message.

### Observed incident, September 24, 2026

The successful exercise started its fault at 14:23:04.633 Asia/Shanghai
(06:23:04.633 UTC); recovery verification completed at 14:23:21.487.
This is a bounded local exercise, not a production recovery-time commitment.

The fault scaled only `shortener/db` from one replica to zero after verifying
PVC retention. It did not delete the StatefulSet, PVC, database files, Service,
application Deployment or cluster. The following observations were captured:

| Evidence | Result | Application-owner interpretation |
| --- | --- | --- |
| Direct request inside each API Pod to `/live` | 200 | HTTP process still responds |
| Direct request to `/health` and `POST /links` | 503 on both replicas | The database-dependent operation is unavailable |
| Matching `request_failed` logs | `dependency=postgresql`, `errorCode=ECONNREFUSED` | Investigate the database connection path; do not infer a password problem |
| API state | Running, Ready=false, restart count still 0 | The process is running but should not receive normal Service traffic |
| API EndpointSlices | Both endpoints ready=false | No ready application backend remained |
| db-client EndpointSlices | No endpoints | No database backend was available in this controlled fault |
| Windows entry point after readiness withdrawal | `UND_ERR_SOCKET` | A transport failure, not an application-generated 503 response |
| `/proc/1/status` and UID | Process present, UID 1000, roughly 64 MiB RSS | Runtime evidence collected without reading environment secrets |
| Recovery | API 2/2 ready, DB 1/1 ready, `/health` 200 | Dependencies and routing recovered |
| Existing short link | 307 to the original destination | Previously saved data remained accessible |
| PVC UID, volume and API Pod UIDs | Unchanged; API restart counts unchanged | Recovery needed neither data replacement nor application restart |

A representative error is in the successful report:

```json
{
  "requestId": "db-2026-09-24T06-23-02-347Z-94f68c84-fault-0-links",
  "event": "request_failed",
  "route": "/links",
  "status": 503,
  "dependency": "postgresql",
  "operation": "createLink",
  "errorCode": "ECONNREFUSED"
}
```

This is an excerpt, not the entire log line. Search the same request ID to find
its `request_completed` record, duration, timestamp and Pod. An error code alone
does not prove the root cause. Here it is combined with the intentional database
scale-down and the empty database endpoint list.

### Decisions you own

1. Establish impact: both app replicas failed database operations; one healthy
   process or one successful liveness check did not prove business availability.
2. Correlate a failed request with its Pod, version, route and dependency error.
   If the request never reached the app, use the gateway/transport evidence too;
   there may be no application request ID for that failure.
3. Check the dependency before restarting or scaling the API. In this incident,
   extra API replicas would still depend on the unavailable single database.
4. Restore the changed dependency setting, then verify user behavior and saved
   data. If you do not own database operations, give the database/platform owner
   the timestamp, scope, request ID, error code and endpoint evidence.
5. Keep liveness and readiness responsibilities distinct. In this lab a database
   outage should withdraw readiness without inducing an API restart loop.
6. Close the incident only after checking ready replicas, a real request, the
   old link, and the absence of leftover fault configuration. A green Pod alone
   is not the full acceptance criterion.

### Exercise runner and evidence

`node scripts/drill-database.js` repeats this disruptive exercise on the fixed
local `k3d-shortener` context and `shortener` namespace only. Do not use it against
a shared/production cluster. It creates synthetic links but never deletes data.
It shares the release lock, checks the original object UID/generation, preflights
the capture code inside both Pods, saves observations, and restores replicas in
`finally`. Observations have a deadline and individual commands have timeouts.

Recovery is attempted on handled failures and interrupts, but cannot be promised
after forced process termination, host power loss or an unreachable API server.
After such an interruption inspect the live `db` StatefulSet and the saved patch
files before restoring replicas; do not blindly remove the lock or overwrite a
concurrent operator's change. The report distinguishes a failed exercise from
failed recovery. A failed exercise exits nonzero even when recovery succeeds.

Evidence directories under `E:\k8s-learning\shortener\.incidents`:

- `db-2026-09-24T06-19-14-318Z-2811bf96`: capture script newline escaping failed;
  recovery verified. Fixed with `String.raw`, syntax validation and live preflight.
- `db-2026-09-24T06-20-39-966Z-264bd19c`: empty EndpointSlice data exposed a null
  handling bug in the capture tool; recovery verified. Added null/empty handling
  and 3 focused regression tests. Unknown endpoint readiness is treated as ready,
  matching the Kubernetes API contract, so it cannot falsely prove withdrawal.
- `db-2026-09-24T06-23-02-347Z-94f68c84`: complete exercise and recovery succeeded.
  `report.json`, per-Pod logs, `observations.json` and `readiness-events.json`
  preserve the evidence. The synthetic private marker did not appear in logs.

For a nondisruptive full regression run against the running Kubernetes service:

```powershell
$env:TEST_BASE_URL = "http://127.0.0.1:8081"
node --test test/logging.test.js test/drill-database.test.js test/smoke.test.js test/version.test.js test/request-id.test.js
```

The 8 application logging checks, 3 exercise-parser checks and 9 live endpoint
checks total 20 tests. The exercise-parser tests do not connect to the cluster.

## Local release entry point

The following section is historical documentation of the earlier tar-import
release path, which the current schema-aware runner rejects. The current command
is `node scripts/release-local.js --registry --backup <verified-backup-id>`;
see TITLE-RELEASE.md and CI-CD.md for migration, candidate testing and failure
gates. The accepted 3.3.0 digest is reconciled into `k8s/30-api.yaml`.

From `E:\k8s-learning\shortener` with Docker Desktop and the lab cluster running:

```powershell
node scripts/release-local.js
```

This uses JavaScript directly and works when PowerShell blocks `.ps1` scripts.
`npm.cmd run release:local` is equivalent on Windows. If Docker Hub authentication
requires this machine's proxy, set `HTTP_PROXY` and `HTTPS_PROXY` to
`http://127.0.0.1:7890` in that terminal; the proxy must be running. Keep localhost
in `NO_PROXY`.

The command performs the following sequence:

1. Confirm the existing Deployment is available and no rollout is in progress.
2. Record the prior revision/template and create a link for data-retention checks.
3. Build a unique image tag; export only linux/amd64 to the E: temporary directory.
4. Import the artifact into this local cluster and deploy its immutable digest.
5. Wait for the rollout; verify each Pod, run endpoint tests, and verify the saved link.
6. Accept only if all sampled health requests succeeded; otherwise attempt recovery.
7. Write commands, image details, test outcomes and recovery outcomes to `.releases/`.

The default command builds the current source. To deploy an already-built local
artifact instead, use `--image shortener:<existing-tag>` and set
`--expected-version <version>` if different from package.json. It never chooses
another cluster or namespace: this tool is intentionally limited to `k3d-shortener`
and namespace `shortener` on this Windows machine.

After a successful new artifact, reconcile its `imageRef` from `report.json` into
`k8s/30-api.yaml` so a later apply does not revert the app to an older digest. This
is explicit review work; the release command does not silently rewrite source
manifests. That was the historical behavior. The current schema-aware runner
reconciles the accepted digest only after final checks; the manifest now matches 3.3.0.

## Failure handling

The script uses a local lock and checks the Deployment UID/generation before
publishing. On a failed release it verifies that the current template still
belongs to that release, then restores the saved template with an atomic
generation check. If another actor changed the Deployment, it stops recovery
instead of overwriting their change.

Kubernetes reports rollout progress and failures. This script implements the
automatic rollback; Kubernetes does not automatically undo a failed Deployment.

Reports distinguish `succeeded`, `rolled_back`, `rollback_failed`, and other
failures. A rolled-back release still exits with code 1, which tells a calling
pipeline that the intended release was not accepted. `.releases/last-success.json`
is updated only by an accepted release.

The deliberate failure drill has already been run. It adds a failing startup
command to a new revision and verifies rollback. It does not change the database:

```powershell
$release = Get-Content .releases/last-success.json -Raw | ConvertFrom-Json
node scripts/release-local.js --image $release.image --drill
```

Expected outcome: command exit 1 and report status `rolled_back`. Inspect both;
exit code alone cannot distinguish a successful recovery from recovery failure.
This drill is only for the local learning cluster.

If the process is forcibly killed, its lock may remain. Check that no release
process is still active and inspect live deployment state before removing that
specific stale lock. Do not start another release over an uncertain rollout.

## Why the lifecycle settings matter

The first release's failed samples coincided with Pod replacement. We did not
capture a packet trace, so the exact cause is not proven. The termination timing
was consistent with requests reaching an old Pod while routing changes propagated.

The Deployment now waits for 5 seconds of readiness before counting a replacement
as available, retains zero unavailable replicas during a rolling update, and
allows one extra Pod. A `preStop` hook gives routing 5 seconds to settle before
SIGTERM. The 20-second termination budget also includes the application's
8-second shutdown deadline. These values are lab defaults that need measurement
under real traffic, long requests, proxies and resource limits.

## Incident workflow

Start by recording the release ID, affected route, HTTP result and when the
symptom began. Then check Deployment progress, Pod state/events, application logs,
and only then the affected process/network/storage layer. Avoid restarting every
component before collecting evidence.

| Symptom | First evidence | Decision to make |
| --- | --- | --- |
| New revision never becomes ready | Rollout status, new Pod events, previous container logs | Bad image/config/startup command, or missing dependency? Roll back the app if caused by the release |
| Pod repeatedly restarts | Last termination reason, exit code, previous logs | Process crash, probe failure, or resource limit? Fix the cause before increasing replicas |
| Application returns 503 | App logs, readiness, db-0 status and db-client endpoints | Database unavailable, credentials/network issue, or application error? |
| OOMKilled | Termination reason and memory observations | Leak, workload growth or undersized limit? Measure before changing requests/limits |
| Works inside Pod, fails from Windows | Service selector/endpoints, targetPort, NodePort and local port mapping | Find the broken hop instead of rebuilding the image |
| Rollback restores app but errors remain | Saved-link check and schema/data changes | An image rollback does not undo database changes |

Useful commands are kept here as lookup material:

```powershell
Set-Alias kubectl "E:\k8s-learning\shortener\scripts\kubectl-lab.cmd"
kubectl -n shortener get pods
kubectl -n shortener describe deployment api
kubectl -n shortener logs -l app=api -c api --tail=80 --prefix
kubectl -n shortener get events --sort-by=.lastTimestamp
kubectl -n shortener get endpointslices
```

For a specific restarting Pod, use `kubectl logs <pod-name> -c api --previous`
with the same namespace. Enter its shell only when logs and status do not answer
the question. Never paste `.env`, kubeconfig credentials or Secret values into
an incident report.

## What this lab does not yet provide

The title API is now deployed as 3.3.0. TITLE-RELEASE.md records a real migration
Job, new/old image compatibility, three actual rollouts, 122 successful health
samples, and a title/ledger-aware 54-record recovery verification. The database
expansion remains in place across application rollback. New-feature clients must
be gated during mixed-version rollout or rollback; no automatic feature flag
was added. Release commands now require `--registry --backup <verified-backup-id>`.

Database compatibility now has a separate local exercise:
`npm.cmd run drill:migration`. MIGRATIONS.md records the nullable-column
expansion, bounded lock wait, transactional DDL failure, mixed old/new clients
and old-binary restart verification. That earlier isolated exercise did not
migrate the live database; the follow-up above now has. Consult CI-CD.md and the
GitHub Actions run for the relevant commit for hosted candidate-test results.

Resource troubleshooting now has a bounded, repeatable JavaScript exercise:
`npm.cmd run drill:resources`. See RESOURCES.md for the real 500m/50m/500m CPU
comparison, Linux counters, the disposable OOMKilled Pod, and verified cleanup.
The live resource settings were not changed. Zero HTTP errors did not mean
the restricted instance could sustain all offered arrivals.


The registry-backed local pipeline and candidate testing are now verified (see
CI-CD.md). The public source repository is `Tony-XUYANG/ai-team-assistant`;
GitHub Actions defines isolated candidate checks, not live deployment.
The local HTTP registry is not a secured production registry. The cluster has
one node and one PostgreSQL replica. A local logical database backup
and isolated restoration have now been tested; see BACKUP-RECOVERY.md for the
25-record recovery and verification evidence. It has no scheduled/off-device
backup or tested live cutover, TLS ingress, central logs/metrics, alerting, distributed release lock, vulnerability
gate or production workload sizing. No real production deployment was performed.

Registry releases now run source and isolated candidate-image tests before
publication, then check live endpoints after the candidate joins the Service.
Differences in real data, configuration or load can still expose a faulty
candidate during that window. Production delivery needs broader CI coverage
and staging/canary controls appropriate to
the application. The strict zero-failed-sample gate is useful for this lab, but
production thresholds should follow agreed service objectives.

Registry-backed local delivery is complete. Hosted deployment integration, backup scheduling,
off-device storage and recovery ownership still need explicit design. We will work
through those as concrete delivery responsibilities, not command memorization.

## Official references

- https://kubernetes.io/docs/concepts/containers/images/
- https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- https://kubernetes.io/docs/tutorials/services/pods-and-endpoint-termination-flow/
