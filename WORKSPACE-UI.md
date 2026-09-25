# Local Project Workbench (3.7.0)

Resume a project from saved objectives, sources, progress, decisions, blockers,
and actions. This is a local JavaScript/Node.js and PostgreSQL preview, without
an AI provider, login, tenant isolation, or team permissions. Do not expose the
service publicly or enter sensitive team information.

## Start and stop

Docker Desktop must be running with its data disk on E:. This checkout uses
`E:\k8s-learning\shortener`; its local npm cache is configured on E:.

```powershell
cd E:\k8s-learning\shortener
npm.cmd run workspace:start
```

Open the printed URL, normally `http://127.0.0.1:8082`. If occupied by another
service, the script selects a port from 8082 through 8099 and remembers it in
`.workspace/runtime.json`. The script builds the image, waits for PostgreSQL,
runs additive migrations, and waits for the API health check.

The separate Compose project is `team-assistant-workspace`, with database volume
`team-assistant-workspace_workspace-data` inside the existing E: Docker disk.
It does not change the old 8080 Compose database or 8081 Kubernetes database/PVC.
Application and database memory limits total 384 MiB; migration adds up to
128 MiB temporarily. These limits do not include Docker or Kubernetes overhead.

The generated password is retained in `.workspace/.env`. On Windows the folder
is restricted to the current account and SYSTEM. Never print, commit, replace,
or delete that file while retaining the database. A missing credential file
with an existing workspace volume causes startup to stop, not reset the data.

Stop only this workbench, keeping data:

```powershell
docker compose --project-name team-assistant-workspace `
  --env-file .workspace\.env -f workspace.compose.yaml stop
```

Start again with `npm.cmd run workspace:start`. Never add `down -v` when data
must be retained. A persistent volume is not a backup; the historical Kubernetes
backup command targets the older lab, not this new workspace database.

## Workflows and limits

The project overview compares loaded projects by active actions, blockers, and
unverified records. Search, status filters, and sorting stay local to the
loaded page; use Load more to include later pages. Selecting a project opens its
workspace. The three views provide a handoff brief, immutable record history,
and project objectives/constraints/sources. The copy button turns the loaded
brief into Markdown for review before a person pastes it into an authorized
work channel or AI tool.
Project metadata can be created but is not editable in this version.

Every progress, decision, blocker, and action record requires a source. New and
revised records default to unverified. Confirmation is a recorder declaration,
not an independent check. Completing an action or resolving a blocker appends a
revision; the old record stays in history. Confirmed closed records appear in
the closed-items section. An unverified completion remains in unverified
information until a confirmed revision is supplied.

The brief uses saved records only, never inferred facts. Copying includes the
same trust boundary as the page: the confirmation state is a recorder assertion,
sources are references, and the output is not an AI answer. The browser only
writes to its local clipboard; it does not send the brief anywhere.

Each section is bounded to 50 records and reports truncation. JSON download
exports the loaded brief, not an unbounded history or database backup. Markdown
fallback opens when the clipboard is unavailable and provides manual selection
plus a download action. Select E: as the browser download destination; the
application cannot control the browser's default folder.

Failures retain the draft while the form stays open, not across a browser
refresh. Uncertain saves and revision conflicts disable resubmission. Check
history for the actual result before recording another change. Closing a dirty
form asks for confirmation. The UI exposes the request ID for troubleshooting.

Stored markup is rendered as text. Local icons, CSP, an explicit static-file
allowlist, and cross-origin browser-write checks reduce browser attack surface;
none of them replace authentication or authorization. Source references are
never fetched or executed by the server. Owner labels are not authenticated
identities.

## Verification

For a fresh checkout run `npm.cmd ci` first. On Windows the browser tests use
installed Edge, or `BROWSER_EXECUTABLE_PATH`; no browser download is required.
On Linux install the Playwright Chromium runtime before running UI tests.
Use an existing E: temporary directory on this machine:

```powershell
cd E:\k8s-learning\shortener
$env:TEMP = $env:TMP = 'E:\k8s-learning\tmp'
npm.cmd run test:ui
npm.cmd run ci
```

Fixture UI tests run on 8090 and do not modify the real database. The separate
live test below creates one clearly labeled acceptance project, completes its
task, verifies the closed-item section and old revision, and reloads the page.
It deliberately retains the sample; it never deletes user data. Use the port
printed during startup:

```powershell
$env:UI_BASE_URL = 'http://127.0.0.1:8082'
npm.cmd run test:ui
Remove-Item Env:UI_BASE_URL
```

Live tests accept only the local workspace port range. Reports and screenshots
are under `playwright-report`, `test-results`, and `.ui-artifacts` on E: and are
ignored by Git. Candidate CI builds the actual image, exercises the API and
PostgreSQL constraints, verifies project dump/restore, and cleans only its own
disposable containers. GitHub Actions runs candidate checks and fixture browser
tests; it does not deploy this workbench or the Kubernetes lab.

## Application-owner exercise

Check three different outcomes: the container is healthy, the user workflow
works, and the saved data/history remains correct. Use the request ID to trace
failed writes. Decide what evidence supports confirmation and completion. Keep
the preview local until authenticated ownership and authorization are in place.
