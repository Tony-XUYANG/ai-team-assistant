# Project Context API (3.4.0)

Create a project, record context with sources, correct or complete work without
losing history, and retrieve a handoff brief. This is Node.js and PostgreSQL,
without an AI provider. The accepted Kubernetes lab still runs 3.3.0; this feature
is not deployed there.

Local validation on September 25, 2026 passed 72 source checks, 18 image HTTP
checks, 3 PostgreSQL checks, a dump/restore comparison of project data/schema,
and old 3.3 image compatibility on the expanded database. Disposable containers
were removed with ownership checks. No live Kubernetes migration was run.

## Application-owner responsibilities

- Define evidence and who confirmed it before calling a record a fact.
- Scope project references in both queries and database constraints.
- Ship additive migrations before new replicas start; retain old API tables.
- Test the actual image against PostgreSQL, conflicting writes and restore.
- Review migration results and a recent verified backup before rollout.
- Distinguish healthy containers, correct data and genuinely completed work.

## API

| Method | Route | Result |
| --- | --- | --- |
| POST | `/projects` | Create objective, constraints, status and source |
| GET | `/projects?limit=50&offset=0` | Projects and open item counts |
| GET | `/projects/:id` | Project metadata |
| POST | `/projects/:id/entries` | Append progress, decision, blocker or action |
| GET | `/projects/:id/entries?limit=50&offset=0` | History, including `is_current` |
| GET | `/projects/:id/brief` | Context grouped by verification and kind |

Responses use JSON, `Cache-Control: no-store` and `X-Request-ID`. Invalid inputs
return 400; oversized bodies 413; missing projects/predecessors 404; already-revised
predecessors 409; database failures 503. Unsupported routes/methods return 404.
Bodies are limited to 16 KiB. List limits are 1-100, offsets 0-1000000; responses
include `has_more` and `next_offset`. Lists order by creation time and ID.
Offset pages can shift with concurrent inserts, so they are not snapshot exports.
Project detail contains metadata, not unbounded history.

## Input and trust

A project requires `name` (1-120 characters), `objective` (1-2000) and `source`.
Optional `constraints` contains up to 30 strings of 1-500 characters. Status is
`active` by default; `paused` and `archived` are metadata, not access controls.
Project metadata is immutable in this first version.

Each entry requires `kind`, `content` (1-4000) and `source`. It can include
`owner_ref` (1-120) and `occurred_at`. PostgreSQL supplies `created_at`;
`occurred_at` is the caller's event time, defaulting to submission time.

| Kind | Default status | Allowed statuses |
| --- | --- | --- |
| progress | recorded | recorded |
| decision | recorded | recorded |
| blocker | open | open, resolved |
| action | todo | todo, doing, done, cancelled |

`verification` defaults to `unverified`; `confirmed` and `disputed` must be
explicit. Confirmation is a caller assertion, not an independent assessment.
The API does not authenticate a caller or verify a source.

A source requires `kind` (`url`, `document`, `message`, `note`, `other`) and
`label` (1-160). Optional fields are `locator` (1-2000) and `captured_at`.
URL sources require an HTTP/HTTPS locator without URL credentials. Other
locators are references, not paths the server opens. The server never fetches
sources, executes their contents or sends external messages. `captured_at`
defaults to submission time. Dates use valid UTC `YYYY-MM-DDTHH:mm:ss[.SSS]Z`.
Unsupported input fields are rejected. Do not put secrets in recorded context.

To revise an entry, POST its full replacement with `supersedes_id` set to the
current entry's ID. Project and kind must match. Old content remains in history;
only one successor is allowed. Concurrent revisions return one 201 and one 409.
Read the latest history before retrying a conflict. A revision defaults to
unverified again unless explicitly confirmed with evidence.

## Brief semantics

One PostgreSQL statement gives the brief a consistent snapshot. Only records
without a successor appear. Sections are:

- `confirmed_facts`: confirmed progress.
- `decisions`: confirmed decisions.
- `blockers`: confirmed open blockers.
- `next_actions`: confirmed todo/doing actions.
- `unverified` and `disputed`: current records with those verification states,
  including potential blockers/actions that have not been confirmed.
- `closed`: confirmed resolved blockers and done/cancelled actions.

Each section has `entries`, `total` and `truncated`, returning its newest 50
records by recording time. History supports pagination. An empty section means
no matching recorded information, not proof that a project has no problems.
Objectives and constraints stay in the project envelope, outside confirmed
facts. `mode` is `recorded_context`; `verification_basis` is `caller_asserted`.

## Try the workflow

Use the new Compose image only after Docker is running. It has a separate
database from Kubernetes. Keep the existing `.env`; do not replace it. The
following writes synthetic sample data to localhost:8080. Existing source,
data and report locations remain on E:.

```powershell
cd E:\k8s-learning\shortener
docker compose up -d --build --wait
$source = @{ kind = 'note'; label = 'Release review' }
$body = @{ name = 'Website release'; objective = 'Ship the reviewed homepage'; constraints = @('JavaScript only'); source = $source } | ConvertTo-Json -Depth 5
$project = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/projects -ContentType application/json -Body $body
$route = "http://127.0.0.1:8080/projects/$($project.id)"
$body = @{ kind = 'action'; content = 'Check homepage on mobile'; owner_ref = 'Project owner'; verification = 'confirmed'; source = $source } | ConvertTo-Json -Depth 5
$action = Invoke-RestMethod -Method Post -Uri "$route/entries" -ContentType application/json -Body $body
$body = @{ kind = 'action'; content = 'Mobile acceptance completed'; status = 'done'; verification = 'confirmed'; supersedes_id = $action.id; source = @{ kind = 'note'; label = 'Mobile acceptance report' } } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$route/entries" -ContentType application/json -Body $body
Invoke-RestMethod -Uri "$route/brief" | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$route/entries" | ConvertTo-Json -Depth 10
```

The brief moves the action into `closed`; history retains both records. A new
unverified record must stay out of facts. Referencing another project's entry
as a predecessor must return 404.

## Deployment and data

`002_project_workspace` adds two tables and indexes, leaving links and the title
migration intact. Both use advisory locking, bounded waits and a checksum ledger.
Startup verifies project schema and history; replicas never perform DDL.
Revisions lock their project during a short transaction. A composite foreign key
prevents cross-project predecessors; a unique constraint prevents forks. No
deletion endpoint or automated schema rollback exists.

`node scripts/ci.js` runs offline checks, builds the image, starts isolated tmpfs
PostgreSQL with fresh credentials, applies/repeats migrations and checks HTTP
and SQL behavior. It restores a dump into another disposable database and
compares full project rows/schema. Only labeled CI containers are removed.
Reports are in `.ci/` on E:. SQL fixtures must never run on an existing database;
they perform disposable DDL exercises and are separate from HTTP acceptance.

Backup tooling includes both project tables and old revisions in checks of
data, columns, constraints and indexes. Before Kubernetes rollout, take a fresh
verified backup with `node scripts/backup-database.js`, then use the registry
release entry point with that ID. Both migrations must report matching checksums.
Application rollback retains new tables; 3.3 does not expose project APIs.

Authentication, team authorization, user identity, UI, AI summaries, notifications
and integrations remain future work. `owner_ref` is a label, not an identity.
Scoped queries and UUIDs are not permissions: anyone reaching this local API can
read/write all projects. Account/workspace ownership requires a new migration
and an authenticated query boundary before multi-user deployment.
