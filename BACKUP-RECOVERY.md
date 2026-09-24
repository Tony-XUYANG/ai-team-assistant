# Backup and Recovery: Prove the Data Can Be Used

## Delivered capability

The lab can now create a PostgreSQL logical backup on E: and restore it into
a fresh, isolated PostgreSQL instance. A copy of the accepted application image
then validates business behavior against the restored data. The live Kubernetes
database is never a restore target. No data-loss fault was injected into it.

This is an application-owner recovery acceptance exercise, not an automated
production disaster-recovery system. The currently deployed application is 3.3.0.
The title release extended verification to titles and the migration ledger.

## Current title-aware recovery

The latest full verified snapshot from this release is
`.backups/backup-2026-09-24T10-16-34-884Z-78b37425`: 54 links, all title values,
and the migration ledger's content and schema verified in an isolated restore.
The restored API reported 3.3.0; health, pre-snapshot redirect, post-snapshot
absence and new writes all passed. All 11 live health samples passed. See
TITLE-RELEASE.md for the preceding failed table-allowlist check and its correction.
The earlier 25-record evidence below is retained as historical evidence.

## Verified result on September 24, 2026

Earlier full backup and verification:

```text
E:\k8s-learning\shortener\.backups\backup-2026-09-24T06-45-13-564Z-79a95e9b
```

| Check | Observed result |
| --- | --- |
| Snapshot captured | 14:45:15.824618 Asia/Shanghai, 06:45:15.824618 UTC |
| Backed-up links | 25 |
| Archive size | 2,326 bytes, compressed custom format |
| Archive integrity | Size, SHA-256 and PGDMP signature validated |
| Restored records | Count and hash of every code, URL and creation timestamp matched |
| Schema | Columns, defaults, nullability, primary key and index matched |
| Backup-before marker | `/f7de4122` returned 307 to its original target in the restored app |
| Backup-after marker | `/6e12b248` returned 404 in the restored app, but still 307 in the live app |
| Restored writes | Creating a new link returned 201; redirecting it returned 307 |
| App compatibility | Restored API reported 3.2.0 and passed its database health check |
| Restore command duration | 184 ms |
| Fresh database start through verified application | 5,434 ms |
| Live-service health samples | 11 passed, 0 failed |
| Existing Kubernetes resources | Pod UIDs/restart counts, workload generations and PVC unchanged |
| Temporary resources | Both verification containers removed; release lock cleared |

The archive SHA-256 is:

```text
673496bc7d1b23bb404fb92a9982070b3e203102c1e2b2b91922d78f9be785d2
```

The small record count and memory-backed temporary database make this a quick
exercise. These timings exclude incident detection, human decisions, off-machine
retrieval, infrastructure provisioning and traffic cutover. They are not a
production recovery-time objective or an availability guarantee.

`backup.json` contains immutable archive metadata and the snapshot comparison
data. `last-verification.json` records the most recent successful verification.
Every attempt has its own `verifications/<id>/report.json`; a previous successful
report does not erase a later failure. Use the command exit code and the report
for the run you are examining.

## What an application developer must decide

1. Define acceptable data loss with the business. A usable backup must precede
   the unwanted change; the newest backup may already contain that change.
2. Establish the recovery point and account for later writes. This exercise
   intentionally proves that a post-snapshot link is absent from the backup.
3. Recover into an isolated target before touching the live database. Confirm
   the target, archive, application version and ownership before any cutover.
4. Verify business meaning, not only a successful database command. Here the
   check includes every record plus old-link redirects and new writes.
5. Work with the DBA/platform owner on roles, secrets, privileges, storage,
   backups and traffic changes. This script does not authorize a production
   overwrite, data merge or endpoint cutover.
6. For an actual accidental deletion, preserve evidence and investigate whether
   restoring selected missing rows from a verified recovery database is safer
   than rewinding the entire live database. Reconciliation needs domain-specific
   checks to avoid losing valid writes made after the backup.

For this project, the key acceptance question is: can the recovered application
serve the correct old links and safely accept new ones, and what data would be
missing if we switched to this recovered copy?

## Repeat the local workflow

Run from `E:\k8s-learning\shortener` with Docker Desktop and this lab healthy.
The runner is intentionally fixed to context `k3d-shortener`, namespace
`shortener`, source Pod `db-0`, and host endpoint `http://127.0.0.1:8081`.

```powershell
node scripts/backup-database.js
```

This makes a new backup and proves it restores. It adds two synthetic links to
the live source: one before and one after the backup. They are retained, not
deleted. The restored application's new test link is only in the disposable copy.

To verify an existing backup again without taking a new one:

```powershell
node scripts/backup-database.js --verify backup-2026-09-24T06-45-13-564Z-79a95e9b
```

`--verify` accepts a generated backup ID, not a free-form path or connection
string. It still checks the running source service and marker links, so this
is currently a lab acceptance runner, not an offline restore utility for a
destroyed cluster. It requires the saved local image IDs to remain available.

Pure local guard tests, without a database connection:

```powershell
npm.cmd run test:backup
```

Ten tests cover path confinement, exact binary checksums, same-length corruption,
truncation, invalid archive headers, manifest validation, full-record/schema
comparison, container ownership, and isolated tmpfs representations.

## How the verification works

1. Take the shared local release/incident lock and verify source health and the
   accepted application artifact. Compare the linux/amd64 manifest, not an OCI
   index digest with a config digest.
2. Open a short read-only repeatable-read transaction, export its snapshot and
   compute the expected data/schema summary in that same transaction.
3. Run PostgreSQL 17 `pg_dump --format=custom --snapshot=...` inside the source
   database Pod. Stream bytes directly to an E: `.partial` file without a TTY or
   text decoding. Only rename to `database.dump` after successful completion.
4. Store archive size, SHA-256, source version, timestamp, image identities and
   marker records. Restrict the backup directory ACL to the current Windows user
   and SYSTEM. Exclude `.backups` from both source control and Docker builds.
5. Create a fresh PostgreSQL 17 container with generated verification credentials,
   no network interfaces beyond loopback, no published ports, and a 128 MiB tmpfs
   data mount. Inspect Docker settings and Linux `/proc/mounts` before restoring.
6. Refuse a nonempty destination. Stream into `pg_restore --single-transaction
   --exit-on-error --no-owner --no-acl`; no `--clean` and no live database target
   are used. A failure must not be reported as an accepted restore.
7. Compare complete data/schema evidence before starting the verification API.
   Then start the accepted app image in the temporary database's network
   namespace. Its only database is `127.0.0.1`, with verification credentials.
8. Validate the pre/post-snapshot markers, health, version, new writes and
   redirects. Remove only containers with the matching run label and names,
   refusing cleanup if an unexpected persistent mount is found.
9. Check the live cluster state, source markers and health again. Save the
   verification report and release the lock. An incomplete or failed verification
   exits nonzero even when cleanup succeeds.

The checksum compares every current `links` record in a stable order, including
microsecond UTC timestamps, without writing all original URLs into a report.
The summary is deliberately limited to `public.links` (including titles when
present) and the optional `public.lab_schema_migrations` ledger. Unexpected
tables are rejected. The links table must be smaller than 16 MiB. Larger or more
complex schemas need expanded verification, streaming comparison, larger target
storage and different limits.

## What is not protected yet

- The dump contains sensitive application data. Files have restricted local
  permissions but are not encrypted. A SHA-256 beside its file detects accidental
  changes, not a malicious actor replacing both file and manifest.
- Source Docker data and backups are both on E:. There is no off-device/off-site
  copy, retention policy, backup schedule, monitoring or restore alerting. Losing
  that drive can lose both source and backups. No external upload was performed.
- `pg_dump` is a database backup, not a backup of cluster roles, Kubernetes
  Secrets, application code/images or infrastructure. Ownership and grants are
  not validated in this lab restore; production access must be provisioned and
  tested separately with appropriate least-privilege accounts.
- This logical archive restores its snapshot, not arbitrary later points in
  time. PostgreSQL point-in-time recovery requires a different setup involving
  a suitable base backup and archived WAL. This exercise has neither.
- The temporary API uses the restore owner for the lab. This proves functional
  compatibility, not production authorization or production performance. Query
  statistics, realistic load, migrations and full cutover remain separate checks.
- `tmpfs` is disposable storage, not secure erasure; Linux can swap its contents.
  This machine's configured WSL data/swap are on E:. Containers are removed after
  verification, but that is not a cryptographic deletion guarantee.
- A snapshot consistency check is not a coordinated database migration lock.
  Avoid concurrent schema changes while this local runner operates.
- Restore only archives from the trusted lab source. Restoring a dump can execute
  code defined by its source; neither a custom format nor a checksum proves trust.

After a forced process kill or host failure, `finally` might not execute. Inspect
the run report, the specific containers' names and `shortener.lab/restore-run`
labels, and any active release process before cleanup or removal of a stale lock.
Never use a broad container/volume prune as incident recovery. `.partial` files
and failed attempts are retained and must not be mistaken for verified backups.

## Development failures retained as evidence

- `backup-2026-09-24T06-39-33-977Z-d8110c35`: image identity check compared different
  digest levels. The preflight stopped before export. Fixed by comparing platform
  manifests.
- `backup-2026-09-24T06-40-43-905Z-0aee6fb9`: nested JSON output crossed line
  boundaries. Fixed with compact JSONB output; no restore was attempted.
- `backup-2026-09-24T06-41-50-781Z-25f3a62a`: a valid 23-record backup was retained
  after a tmpfs inspection mismatch. The temporary DB was removed. The same
  archive then passed a separate complete restore verification; it was not
  replaced to hide the failed attempt. A regression test covers both Docker
  tmpfs representations, plus the runner verifies the actual Linux mount.
- `backup-2026-09-24T06-45-13-564Z-79a95e9b`: the complete 25-record backup and
  restoration workflow succeeded from start to finish.

## Official references

- PostgreSQL 17 pg_dump: `https://www.postgresql.org/docs/17/app-pgdump.html`
- PostgreSQL 17 pg_restore: `https://www.postgresql.org/docs/17/app-pgrestore.html`
- Backup scope: `https://www.postgresql.org/docs/17/backup-dump.html`
- Point-in-time recovery: `https://www.postgresql.org/docs/17/continuous-archiving.html`
- Docker temporary storage: `https://docs.docker.com/engine/storage/tmpfs/`
