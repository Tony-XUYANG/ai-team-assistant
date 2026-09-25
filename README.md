# AI Team Assistant: Project Foundation

The planned product is an AI coordination assistant for individuals and teams,
including non-technical workers managing multiple projects. See
[PRODUCT-DIRECTION.md](PRODUCT-DIRECTION.md) for the proposed scope.

The implemented code is a JavaScript project-context API, URL-shortener service,
and Linux, Docker, and Kubernetes operations lab. Version 3.4.0 adds project
objectives, constraints, sourced records, revision history, and a deterministic
handoff brief. See [PROJECT-WORKSPACE.md](PROJECT-WORKSPACE.md) for the API.
AI integration, a collaboration UI, user accounts, and team authorization are
not implemented yet. The historical
package and infrastructure names remain `shortener` to preserve the working lab.

Local credentials, caches, database backups, incident reports, and generated
release artifacts are intentionally excluded from Git. Examples and operating
notes contain machine-specific E: paths and local registry references; they
are not a production-ready, portable installation package.

Public repository: https://github.com/Tony-XUYANG/ai-team-assistant

The app has no user authentication or tenant isolation yet. Keep the lab local;
publishing the source code does not make the running service ready for public use.

## Project context API: September 25, 2026

The current source and Compose image version is 3.4.0. The existing Kubernetes
lab remains on the accepted 3.3.0 image until an explicit release; its existing
data and PVC have not been migrated by this implementation step. Docker was
started and all three existing Pods were verified healthy on September 25.

New `/projects` endpoints preserve provenance, caller-declared verification,
and immutable entry revisions. The brief excludes superseded records and keeps
unverified/disputed information separate from confirmed facts. It does not call
an AI model or independently verify a claim. Pagination and brief truncation
metadata make incomplete results visible. Project scoping is enforced by queries
and a composite foreign key; it is not an account permission boundary.

The migration runner now applies the unchanged title migration and additive
`002_project_workspace` migration. CI tests source, HTTP behavior in the actual
image, PostgreSQL constraints, migration rollback, and project data restoration.
Backup verification recognizes both project tables, including their full data,
schema, constraints and indexes. Operational documents below describe the
accepted 3.3.0 lab and earlier exercises unless explicitly updated.

## Environment status: September 24, 2026

Docker/WSL and the original Kubernetes service have recovered after the stuck WSL
service was stopped and restarted from an elevated user terminal. The original
2GB WSL memory setting remains unchanged. No data volumes or cluster resources
were deleted or rebuilt. Recovery checks passed: the original PVC and accepted
3.3.0 image, 39 historical rows with a matching content hash, retained title and
migration ledger, 62 offline tests, and 11 live API tests. A new 66-row backup
was restored and verified in an isolated database on E:.
[DATABASE-ACCESS.md](DATABASE-ACCESS.md) records the evidence and the next
least-privilege exercise. The live baseline audit now runs, but account separation
has **not** been applied: both API replicas still use the administrator account.

## Current focus: delivering and operating an application

Start with [OPERATIONS.md](OPERATIONS.md) for application-owner responsibilities,
the tested release pipeline, its failure drill, and the incident workflow. The
accepted Kubernetes service is version 3.3.0 and exposes `/version` as well as `/health`.
Responses carry `X-Request-ID`; structured request/error logs correlate an HTTP
failure with its application instance and database operation. The database outage
exercise and its verified recovery are documented in OPERATIONS.md.

The current release entry point is `node scripts/release-local.js --registry --backup <verified-backup-id>`.
It tests source and the built image against an isolated database, publishes to
the local registry, deploys a verified digest, validates the release, and restores
the previous Pod template if rollout or acceptance fails. Reports are saved under
`.releases/`. [CI-CD.md](CI-CD.md) records the tested gates and rollback. Schema-aware
releases now require the registry path and a verified backup. GitHub Actions runs
isolated candidate checks on pushes and pull requests; consult the repository's
Actions tab for actual run results. It does not deploy to the local cluster or
publish application images.

The database backup entry point is `node scripts/backup-database.js`. It writes
to `.backups/` on E: and verifies the archive in an isolated temporary PostgreSQL
instance with the real application image. [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md)
records the historical 25-link recovery and the current 54-link title/ledger
recovery, the post-snapshot data boundary, and the
remaining protection gaps. It never restores over the live database.

The schema-compatibility exercise is `npm.cmd run drill:migration`.
[MIGRATIONS.md](MIGRATIONS.md) records the tested optional-title expansion,
lock/transaction failure handling, old/new query compatibility and old API
restart. It runs only in a disposable database using the preserved 3.2 image.
The next step is now complete: [TITLE-RELEASE.md](TITLE-RELEASE.md) records the
real migration Job, 3.3 title API, 3.2 rollback and 3.3 roll-forward verification.
`POST /links` accepts an optional title; `GET /links/<code>` reads persisted
metadata. Wait for rollout completion before sending title-dependent traffic.

## Kubernetes environment

The resource investigation entry point is `npm.cmd run drill:resources`.
[RESOURCES.md](RESOURCES.md) records the measured CPU-quota latency comparison,
the isolated Kubernetes OOM experiment, safety limits, and application-owner
decisions. It uses the accepted image without modifying the live Deployment.


The Kubernetes lab is running at `http://127.0.0.1:8081`. See
[KUBERNETES.md](KUBERNETES.md) for commands, recovery exercises, and stop/start
instructions. Its database is independent of the earlier Compose database.
Compose is currently stopped to leave memory for Kubernetes; its data is retained.

## Previous lesson: PostgreSQL and Docker Compose

The Compose lesson uses PostgreSQL to store links instead of an
in-memory Map. The original `shortener:1.0` image and stopped `shortener`
container are retained locally for comparison; their old in-memory links are
not migrated. Use the Compose commands below when returning to that lesson.

All examples below run in PowerShell unless marked `sh`.

| Component | Location or role |
| --- | --- |
| Source code | `E:\k8s-learning\shortener` |
| Docker data | `E:\DockerDate\DockerDesktopWSL\disk\docker_data.vhdx` |
| Ubuntu | `E:\k8s-learning\wsl\Ubuntu` |
| Host npm cache | `E:\k8s-learning\.npm-cache` |
| `api` service | Node.js application; host port 8080 maps to port 8000 |
| `db` service | PostgreSQL 17; accessible to the app as `db:5432` |
| Database volume | `shortener-lab_postgres-data`, inside the Docker data disk |

The database port is not published to Windows. The application connects through
the Compose network. `depends_on` with `service_healthy` makes initial startup
wait for the database health check. `/health` also checks the app's database
connection.

## Start and inspect

Docker Desktop must be running. This workspace already has a generated `.env`
file containing the database password. For a fresh checkout, copy `.env.example`
to `.env` only if `.env` does not exist, then replace its password placeholder
before the first startup. Do not commit `.env`.

```powershell
cd E:\k8s-learning\shortener
docker compose up -d --build --wait
docker compose ps
curl.exe http://127.0.0.1:8080/health
```

Expected health response:

```json
{"status":"ok","database":"ok"}
```

If the old container `shortener` is running and holds port 8080, stop it with
`docker stop shortener` before starting Compose.

## Create a link and query the database

Use the same PowerShell window so the variables remain available:

```powershell
$link = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/links" -ContentType "application/json" -Body '{"url":"https://example.com"}'
$shortUrl = "http://127.0.0.1:8080$($link.short_path)"
curl.exe -i $shortUrl
docker compose exec db psql -U shortener -d shortener -c "SELECT code, url FROM links ORDER BY created_at DESC LIMIT 5;"
```

The redirect response has status 307 and a Location header. The database row's
`code` matches `$link.code`. `url` is the original destination.

## Verify persistence

Restart both services, wait until they are healthy, then request the same link:

```powershell
docker compose restart
docker compose up -d --wait
curl.exe -i $shortUrl
```

The result should still be 307. Data is stored in the named volume mounted at
`/var/lib/postgresql/data`, not in the application's memory.

To replace both containers while keeping the named volume:

```powershell
docker compose up -d --force-recreate --wait
curl.exe -i $shortUrl
```

Normal `docker compose down` removes this project's containers and network but
keeps the named volume. Adding `-v` also deletes the database volume and its
links; do not use that option when you want to retain your data. Persistence
protects against container replacement, but is not a database backup.

## Logs and Linux practice

```powershell
docker compose logs --tail 20 api db
docker compose exec api sh
```

Inside the container, run these one at a time:

```sh
pwd
ls -l
whoami
ps
cat /etc/os-release
exit
```

## Automated checks

With both services healthy and Node.js installed on Windows:

```powershell
npm test
npm run test:persistence
```

The first command checks health, liveness, link creation and redirect, invalid inputs,
oversized requests, and missing routes. The second creates a test link,
restarts both services, replaces both containers, and verifies the link after
each step. It briefly interrupts this lab's service and leaves the stack running.
Both commands leave sample links in the database and never delete its volume.

## Files to read

- `compose.yaml`: services, environment variables, port mapping, health checks,
  startup dependency, and the named volume.
- `Dockerfile`: installs locked JavaScript dependencies and runs as user `node`.
- `server.js`: startup and shutdown handling.
- `app.js`: HTTP endpoints, input checks, and request correlation.
- `logger.js`: structured JSON records and allowlisted error codes.
- `database.js`: connection pool, table initialization, and parameterized SQL.
- `package-lock.json`: exact dependency versions used by `npm ci`.

## Docker Hub connection troubleshooting

This machine has a local proxy at `127.0.0.1:7890`. If a build times out fetching
a Docker Hub authentication token, and that proxy is running, set these variables
in the current PowerShell window before retrying:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
docker compose build api
```

These values are specific to this machine, not required Compose settings.

The new `/live` check requires rebuilding the Compose image from the current
source with `docker compose up -d --build --wait` before running `npm test`.
