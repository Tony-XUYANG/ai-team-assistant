# Shipping Titles: Migration, Rollout, Rollback, and Recovery

## Current result

The local Kubernetes service at `http://127.0.0.1:8081` now runs **3.3.0** on
two API replicas. Optional titles are persisted in PostgreSQL. Existing short
links still redirect with 307. This is a completed local release, not a hosted
CI run or a production deployment.

The accepted digest in the live Deployment, both Pods, the registry and
`k8s/30-api.yaml` is:

```text
localhost:5001/shortener@sha256:2abe16fba99d5bb28181b89ca2f8cebf6e29f1acd4f6544963f5ff67ed289dff
```

Release report: `.releases/2026-09-24T10-13-39-213Z-8c369ffa/report.json`.
All paths in this document are relative to `E:\k8s-learning\shortener`.

## API contract

Create a link with `POST /links`:

```json
{"url":"https://example.com/guide","title":"Deployment guide"}
```

The 201 response includes `code`, `url`, `title` and `short_path`.
`GET /links/<code>` returns the same metadata with `Cache-Control: no-store`.
`GET /<code>` remains a 307 redirect; titles never enter the Location header.

- Omitted title or explicit null stores NULL; old payloads still work.
- Strings are trimmed at both ends and must contain 1-120 Unicode code points
  after trimming. This counts code points, not grapheme clusters or UTF-16 units.
- Empty/whitespace-only values, non-strings, malformed surrogate sequences and
  ASCII control characters are rejected with 400 before any database write.
- Titles and destination URLs are absent from request logs. Metadata route logs
  use `/links/:code`, not raw short codes. Database errors remain generic 503s.
- Metadata is public to anyone possessing/guessing a short code, just like the
  existing redirect. There is no authentication, authorization or private-link
  security claim in this lab. Do not store confidential titles.

PowerShell example, after rollout has completed:

```powershell
$body = @{url='https://example.com/guide';title='Deployment guide'} | ConvertTo-Json
$link = Invoke-RestMethod 'http://127.0.0.1:8081/links' -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod ("http://127.0.0.1:8081/links/" + $link.code)
```

## Executed release sequence

1. Created a pre-change backup with an isolated restore verification. It captured
   38 rows in `.backups/backup-2026-09-24T10-06-16-792Z-c0edb866` and is preserved.
   Its snapshot does not include writes made afterwards.
2. Passed 48 source tests, built one immutable candidate, and tested its startup
   rejection on a missing schema. Ran its migration and confirmed repeat execution
   is `already_applied` before starting the candidate HTTP server.
3. Passed 11 candidate-image endpoint tests. Ran the actual accepted 3.2 image
   beside 3.3 against the same temporary database. Old writes were readable by
   the new API with title null; new titled writes redirected through the old API.
4. Pushed to the local registry and verified the bytes/digest. No public registry
   or Git remote was used.
5. Ran the candidate's `node migrate.js` as a real Kubernetes Job using Secret
   references. The Job applied the nullable-column migration before changing
   the API Deployment. Logs and termination evidence were saved, then the owned
   Job was removed.
6. Rolled out 3.3.0 and validated every Pod's version plus 11 live endpoint tests.
7. Created a titled marker, restored the 3.2.0 Pod template, and verified old API
   writes and redirects against the expanded schema. A database query confirmed
   the title survived. No column or data was dropped during rollback.
8. Rolled forward to the EXACT SAME tested 3.3 image, repeated live acceptance,
   read the titled marker through the new metadata endpoint, and verified that
   the old-version rollback write has a null title.
9. Verified all pre-release link codes, URLs and timestamps plus the PVC identity;
   reconciled the accepted digest into the Kubernetes manifest and saved the
   successful release record. All 122 health samples passed across the migration
   and three rollouts. These are periodic samples, not proof that every possible
   request was interruption-free.

New-feature traffic was withheld during mixed-version rollout. This matters:
the old API ignores an unknown `title` property, so sending titled creates to
the mixed Service could silently lose the title. There is no server-side feature
flag or automatic client gating here. In this local exercise the runner controls
all feature traffic. A real rollout needs a client/feature gate or versioned
routing, and rollback must disable/revert clients that require the new metadata
endpoint or title persistence before old servers are reintroduced.

## Migration and release safety

`migrate.js` bootstraps a new database's base table and runs the existing
checksummed `001_link_title` expansion. Application startup performs schema checks
only; it does not migrate once per replica. Readiness queries actual required
columns, so a reachable database with the wrong schema is not considered ready.

The Job has `backoffLimit: 0`, a 60-second active deadline, no service-account
token and a non-root read-only container. Migration SQL has bounded lock and
statement/transaction timeouts. Secrets are referenced, not copied into reports.
It uses the existing lab DB role; a least-privilege migration/runtime role split
has not been implemented. Completed and failed owned Jobs are cleaned only after
capturing evidence. Jobs can be executed more than once in some failure cases,
so the migration ledger and repeat checks still matter. [1]

The release requires a verified backup ID less than 24 hours old that matches
the currently accepted application digest. It verifies archive bytes and an
isolated restore report. This is a lab gate, not proof of zero data loss: backup
freshness and intervening writes must be assessed for the actual recovery plan.

The registry path now owns schema-aware delivery. The old tar-import release
path is rejected to avoid bypassing migration gates. The PowerShell deployment
helper checks for the title column but does not bootstrap or migrate a new
database. The tested release runner expects an existing healthy lab deployment;
fresh cluster provisioning with Jobs is not covered by this release test.

From the project directory, first run `node scripts/backup-database.js`, obtain
its successful backup ID, then use:

```powershell
node scripts/release-local.js --registry --backup <verified-backup-id>
```

Add `--verify-rollback` only for an intentional rollback/roll-forward rehearsal.
The original 3.2-to-3.3 demonstration used the pre-change backup listed above.
Future releases require a backup of the then-current accepted image, not that
historical 3.2 backup.

On migration failure the API is not patched. On deployment failure, the runner
checks UID/generation/ownership before restoring the previous Pod template. It
never runs an automatic destructive down migration. An ambiguous migration
response requires checking the ledger/schema; the compatible expansion may have
committed even if the client failed. Deployment rollback covers the Pod template,
not PostgreSQL contents. [2]

## Post-release backup verification

The first post-release backup attempt was deliberately blocked by the existing
table allowlist when it found the new migration-history table. Its failure report
remains under `.backups/backup-2026-09-24T10-15-35-920Z-10ad96b7`. No incomplete
backup was presented as successful.

Verification was extended to the explicitly supported migration ledger rather
than allowing arbitrary tables. The successful follow-up backup is:

```text
.backups/backup-2026-09-24T10-16-34-884Z-78b37425
```

Its isolated restoration verified **54 full link records**, an independent hash
covering titles including NULLs, and the migration ledger's row contents, column
definitions, constraints and indexes. The restored 3.3 application passed health,
old-link redirect, snapshot-boundary and new-write checks. All 11 live health
samples passed and temporary restore containers were removed. The live database
contains later test/verification writes beyond this snapshot.

The title/ledger backup fix and one logging-message clarification were made to
local operations scripts after the successful release. They do not change the
deployed application files or accepted image. The recorded release source
fingerprint remains the historical build input, not a claim that subsequent
working-tree operations scripts are identical. Never rewrite past release
evidence to hide this distinction.

Final regression: **60 tests passed** (49 source tests and 11 live endpoint tests).
The additional source test covers the migration-ledger backup check added after
the original release's 48-source-test gate. Earlier exercises were re-run:
`.incidents/migration-2026-09-24T10-19-39-130Z-2c77c778/report.json` and
`.incidents/resources-2026-09-24T10-20-30-497Z-b31b245c/report.json` both succeeded,
with cleanup and live-workload preservation verified. The resource fixture now
explicitly migrates its disposable database before starting 3.3. The historical
schema exercise intentionally retains the immutable 3.2 image.

Compose also declares a one-shot migration service, and the API depends on its
successful completion. Configuration is validated without starting the stopped
Compose stack or touching its separate volume. That updated Compose startup
path has not been exercised end to end. [3]

## What you should be able to decide

- Define nullable/empty/length behavior and maintain existing clients' contract.
- Identify which schema change must precede code rollout and what traffic must
  wait for all replicas to upgrade.
- Prove old and new binaries both work on the expanded schema, not only that
  `ALTER TABLE` succeeded.
- State which clients/features must be disabled before rolling back code.
- Retain compatible schema and new data during image rollback; treat destructive
  cleanup as a later, separately reviewed change.
- Update backup verification whenever schema or business data changes.
- Distinguish real successful local tests from untested production guarantees.

## Official references

1. https://kubernetes.io/docs/concepts/workloads/controllers/job/
2. https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
3. https://docs.docker.com/compose/how-tos/startup-order/
