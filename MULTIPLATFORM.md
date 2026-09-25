# Multi-Platform Foundation (3.9.0)

## Decision

Keep the existing JavaScript workbench, Node.js API and PostgreSQL database.
Prepare a shared HTTP contract before implementing native clients. Flutter is
the intended next client option for Windows, macOS and Android, not an installed
dependency or a client delivered by this release. No Dart, Flutter SDK, mobile
package, desktop installer or PWA/offline support has been added.

The client talks to the API; only the server talks to PostgreSQL. Docker, Linux
and Kubernetes remain deployment concerns, not a requirement on an end user's
phone or desktop. The existing local 8081 Kubernetes lab is unchanged.

## Implemented API Boundary

New clients use `/api/v1`. The web workbench now uses that prefix too.
The original `/projects` paths remain available without redirects or a changed
success payload. Existing legacy errors remain `{ "error": "..." }`.
API major version 1 and application version 3.9.0 are independent.

| Method | Versioned route | Purpose |
| --- | --- | --- |
| GET, POST | `/api/v1/projects` | List or create projects |
| GET | `/api/v1/projects/:id` | Read project metadata |
| GET, POST | `/api/v1/projects/:id/entries` | Read history or append a revision |
| GET | `/api/v1/projects/:id/brief` | Read the bounded handoff brief |
| GET | `/api/v1/openapi.json` | Read the machine-readable contract |

The checked-in contract is `api/openapi.json` (OpenAPI 3.1.0, JSON Schema
2020-12). It includes request and response fields, required/nullable values,
status enums, pagination, sources, attention previews, brief truncation and
error responses. Server-side text normalization, valid calendar dates and
source URL validation remain authoritative where prose describes additional
constraints. The contract endpoint contains schemas only, never project data.

`/health`, `/live`, `/version`, `/links` and short redirects are unchanged;
there are no `/api/v1` aliases for those operational or legacy link routes.
Unknown API versions and unsupported methods return 404, without fallback.

## Client Rules

- Use a configurable API base URL; keep database credentials out of clients.
- Send UTF-8 JSON, keep request bodies within 16 KiB, and handle optional nulls.
- Parse RFC 3339 response dates including numeric UTC offsets. Submit event
  times in the documented UTC `Z` format, not local-time strings.
- Ignore added response fields. Breaking changes require an explicit contract
  version decision and migration plan rather than silently changing v1.
- Follow `next_offset` and show truncated sections; one response is not a full
  project export. Offset pagination is not a snapshot during concurrent writes.
- Read the latest revision before correcting an entry. Never silently retry a
  POST after a timeout, connection failure or 503: the result may be uncertain
  and no idempotency-key or offline replay protocol exists yet.
- Keep caller-declared confirmation, sources and owner labels visible. None
  establishes a verified identity or an independently checked fact.

Every v1 response includes `X-API-Version: 1`, `X-Request-ID` and
`Cache-Control: no-store`. v1 errors add stable `code` and `request_id` fields:

```json
{
  "error": "entry already superseded; read current history and retry",
  "code": "revision_conflict",
  "request_id": "client-correlation-id"
}
```

Clients should branch on HTTP status and `code`, not English message text.
Error codes are `validation_error`, `cross_origin_denied`, `not_found`,
`revision_conflict`, `payload_too_large`, `internal_error`, and
`service_unavailable`. The request ID in the body matches the response header.

## Delivery Gates

1. Current release: versioned API, backward compatibility and executable
   contract checks. The web workbench exercises the same API native clients
   will use. There is no database migration in this release.
2. Before real multi-user or remote access: implement authentication, workspace
   ownership and server-enforced project authorization, with negative access
   tests, HTTPS deployment and a credential-handling design.
3. Then build a small Flutter client against the authenticated API: project
   overview, brief, record creation and revision conflicts. Verify builds and
   behavior separately on Windows, macOS and Android before claiming support.
4. Add notifications, secure token storage, deep links and offline editing only
   after their platform-specific behavior, replay and conflict rules are tested.

Do not open the current unauthenticated service on the LAN or Internet to try
a phone client. `127.0.0.1` addresses the device running the client, not another
computer. This release changes neither network bindings nor browser CORS policy.
No login, team permission, cloud sync or AI provider is implemented.

## Verification

Run `npm.cmd run test:api-contract` for route compatibility, schema validation,
stable errors, unknown-version rejection and private log boundaries. These
source tests use a disposable in-memory stub and do not touch saved projects.

`npm.cmd run ci` additionally collects successful and failing responses from
the actual image backed by isolated PostgreSQL, then validates those samples
against the checked-in contract with Ajv. It also retains the existing API,
database, migration and restore checks. Ajv is a development-only dependency;
the application image only serves the static specification.

Reports and synthetic contract samples stay in the ignored `.ci/` directory on
E:. `npm.cmd run test:ui` tests the web client against the v1 routes. The live UI
test still intentionally retains its labeled synthetic project and history.

Reference specifications: OpenAPI 3.1.0 and Ajv's JSON Schema 2020-12 support.
