# Database Changes Without Losing Application Rollback

## Completed follow-up

The historical isolated exercise below has now been followed by a real 3.3.0
title API release, Kubernetes migration Job, 3.2.0 rollback and 3.3.0 roll-forward.
See TITLE-RELEASE.md for current behavior and evidence. The statements below
about an unmigrated live database describe the earlier exercise only.

## Purpose and scope

This lesson adds an optional link title in a disposable database, verifies old
and new query compatibility, and exercises failure recovery. The live application
remains version 3.2.0. Its API does NOT yet support titles, and its database has
NOT been migrated. No application image was built, published, or deployed here.

The old client is the accepted 3.2.0 API image. The new-field client is a
JavaScript test fixture using the existing pg dependency, not a second HTTP
application or a candidate release. The fixture tests the database contract
needed before implementing and rolling out a title-aware API.

## Verified run

Executed September 24, 2026 against disposable PostgreSQL 17.11:
`.incidents/migration-2026-09-24T09-54-05-620Z-31b6dc44/report.json`.
Detailed fixture evidence is saved beside it in `exercise.json` and
`verify-old-restart.json`. All files are under `E:\k8s-learning\shortener`.

| Scenario | Observed result |
| --- | --- |
| New query before adding the column | SQLSTATE 42703: undefined column |
| Another schema operation holds the advisory lock | MIGRATION_BUSY, approximately 3ms; no schema changes |
| A reader transaction holds the table lock | SQLSTATE 55P03 after approximately 510ms; no schema changes |
| Add column, then deliberately divide by zero | SQLSTATE 22012; both the column and migration ledger creation rolled back |
| Apply the expansion successfully | Approximately 19ms on this tiny temporary table |
| Old API traffic across the expansion | 12 successful creates and 12 successful redirects |
| Repeat the same migration | already_applied; exactly one ledger row |
| Edit the already-applied migration definition | Checksum mismatch rejected |
| Mix old writes with new title-aware writes | 6 writes from each client; cross-reading verified |
| Make title required before retiring old writers | SQLSTATE 23502 for the old INSERT shape; test transaction fully rolled back |
| Stop the new-field client and restart the old API | Old writes and redirects still work; all existing rows and titles retained |

The old API restart check compared all 26 disposable records and their title
values before creating one additional verification record. The intentionally
failed NOT NULL transaction left no changed titles or extra records.

All 47 local unit and live endpoint regression tests passed. The live endpoint
tests create a sample short link before the migration drill's baseline is taken.
During the drill itself, all 14 live health samples succeeded. The live database's
37-row content hash, columns, constraints, and indexes matched before and after.
Live Deployment/StatefulSet specs, Pod UIDs and restart counts, PVC identity, and
the existing release-marker link also remained unchanged. All three temporary
containers and the exclusive run lock were removed.

These are bounded observations on a tiny lab database, not evidence of zero
blocking under production load or a completed Kubernetes rolling upgrade.

## The compatibility choice

The trusted migration definition in `scripts/migration-support.js` is:

```sql
ALTER TABLE public.links ADD COLUMN title VARCHAR(120);
```

There is no NOT NULL requirement and no default. The existing application names
the columns it writes: `INSERT INTO links (code, url) ...`. It does not require
title to create or redirect a link. An omitted column receives its default, or
NULL when it has none. The new-field client must therefore accept NULL titles
from existing rows and from old writers. [1]

The counterexample first backfills titles and sets NOT NULL inside a disposable
transaction. The old INSERT still omits title, so it fails. Backfilling historical
rows alone does not update every writer. The entire transaction is rolled back;
this is a negative compatibility test, not the final schema. [1][2]

## Suggested release order for this project

1. Define the API behavior for omitted, NULL, empty and overlong titles. Test the
   business contract separately from this SQL-level compatibility fixture.
2. Review backup/recovery readiness and realistic table size, traffic and lock
   behavior. Choose the migration window, stop conditions and responsible owner.
3. Apply and verify the nullable-column expansion before activating queries that
   depend on it. Do not publish the feature if this gate fails.
4. Deploy a title-aware API that tolerates old rows and concurrent old writers.
   Test old and new images together, then test the actual Deployment rollback.
5. If the new API fails, stop the new behavior or roll back the image while
   retaining the compatible column and any new title data. Verify old reads,
   writes, startup, and existing links against that expanded schema.
6. Only consider a later contract change, data backfill or tighter constraint
   after every writer and the rollback window have been accounted for. A title
   that is genuinely optional does not need a NOT NULL constraint at all.

Kubernetes Deployment rollback restores a previous Pod template; it does not
restore PostgreSQL contents or schema. The local release script already restores
an old template on failure, so a future database step must explicitly keep that
template compatible. Do not attach an automatic DROP COLUMN to image rollback. [3]

## Migration implementation

This is a small, single-migration teaching module, not a general migration
framework. There is deliberately no CLI accepting arbitrary SQL or a production
database URL. `applyTitleMigration` requires a dedicated connected pg Client
with no active transaction and trusted repository-owned SQL. All transaction
statements must use that same Client, not independent pool.query calls. [4]

The module keeps the DDL and ledger entry in one transaction. It records the
migration ID, SHA-256 of ID plus SQL statements, and applied timestamp in
`public.lab_schema_migrations`. A repeat validates the checksum and actual
column type, size, nullability and default. An unexpected preexisting column
without the matching ledger is an error, not a silent success. The checksum is
an accidental-change guard, not a signature or protection against a database
administrator who can alter the ledger.

It attempts transaction-level advisory lock `(20260924, 1)`, matching the key
used by the old application's startup schema initialization. A busy lock fails
immediately. Advisory locks coordinate cooperating code only; table locks still
matter. Transaction-level advisory locks are released when the transaction ends. [5]

Configured local timeouts are 500ms per lock wait, 2500ms per statement, 5000ms
idle inside a transaction, and a 6000ms transaction timeout. These are lab bounds,
not universal production defaults. A transaction timeout terminates the database
session; rollback may then be impossible on that connection. A failed COMMIT
acknowledgment can also leave the result uncertain: inspect the ledger and schema
with a fresh connection before deciding to retry. [6]

Adding this column still requires an ACCESS EXCLUSIVE table lock. The lock-wait
test holds ACCESS SHARE in another transaction. The runner times out instead
of waiting indefinitely. Even short DDL and bounded waits can affect traffic;
do not translate this successful low-load test into a no-downtime guarantee. [2][5][6]

## Running and inspecting the lab

From `E:\k8s-learning\shortener`:

```powershell
npm.cmd run test:migration
npm.cmd run drill:migration
```

Files worth reading for application-owner decisions:

- `scripts/migration-support.js`: trusted schema change, ledger, lock and timeout
  boundaries, repeat behavior, and transaction failure handling.
- `test/fixtures/migration-integration.cjs`: actual old/new query compatibility,
  failure injection, mixed clients and old-binary startup verification.
- `scripts/drill-migration.js`: local safety checks, isolated resources, original
  application image selection, live data preservation and cleanup.
- `test/migration.test.js`: seven focused tests registered in the source CI list.

Only the pure migration tests were added to the existing CI unit list. The
Docker/database compatibility exercise was executed locally; it is not yet a
hosted CI gate or part of the registry release pipeline. Hosted CI has not run.

## Safety and remaining work

The runner uses `.releases/active.lock`, healthy-cluster checks and at least
600MiB available Docker-VM memory. It creates a fresh network-isolated database
with generated credentials and a run-specific ownership marker. The old API and
driver share that temporary network namespace; no ports or persistent volumes
are exposed or attached. Temporary memory limits total 512MiB with no swap.

Live database access is limited to a read-only transaction for content/schema
summaries. Those full-table hashes are appropriate to the small lab, not an
unreviewed production-table scan. The summary is not a backup. Live schema
credentials are never passed to the migration fixture. Original data is never
restored over or deleted.

Cleanup checks exact container names, run labels and absence of persistent
mounts, then attempts all owned resources even if one fails. Commands have
timeouts, the fixture has a 60-second guard, and stage checks enforce a
four-minute run budget. These are bounded-stage safeguards, not instantaneous
cancellation. A hard kill or unavailable Docker daemon may leave temporary
resources or a stale lock: inspect the report and ownership before removal.

Not implemented here: a title-aware HTTP release, a Kubernetes migration Job,
production migration permissions, large resumable backfills, destructive
contract migrations, realistic lock contention testing, or automatic release
integration. The next deployment step must test a real candidate image against
the expanded schema and preserve the accepted rollback image.

## Official references

1. PostgreSQL 17 INSERT: https://www.postgresql.org/docs/17/sql-insert.html
2. PostgreSQL 17 ALTER TABLE: https://www.postgresql.org/docs/17/sql-altertable.html
3. Kubernetes Deployments: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
4. node-postgres transactions: https://node-postgres.com/features/transactions
5. PostgreSQL 17 locks: https://www.postgresql.org/docs/17/explicit-locking.html
6. PostgreSQL 17 timeouts: https://www.postgresql.org/docs/17/runtime-config-client.html
