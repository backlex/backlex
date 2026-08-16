---
title: Audit logs & sensitive-read auditing
description: What the activity store records, how it maps to the Logs page, and the opt-in access trail for sensitive collections.
---

Backlex keeps a security/audit trail in the `activity` table. The admin **Logs**
page reads it directly. This guide covers what is and isn't recorded, the
namespaces the UI groups by, and the opt-in **sensitive-read audit** for
regulated data.

## What gets recorded (and what doesn't)

The audit store is for **accountability**, not request tracing. By design it
records:

- **Mutations** — every create / update / delete on collections and items, plus
  schema, role, webhook, flow, function, and storage changes. Written by
  `recordActivity` / `logActivity` (`apps/web/src/server/services/activity.ts`).
- **Server errors** — any `5xx` is logged as a `request.error` row by the global
  error handler (`middleware/error.ts`). `4xx` are expected and deliberately
  skipped.

It does **not** record reads (`GET`) by default. Reads are 90%+ of traffic;
writing every one to a durable table would bloat it and bury the changes that
matter. The full per-request HTTP trail lives in your platform's log stream
(Cloudflare Workers Observability, stdout on Bun/Node) — not in `activity`.

> This split — durable audit log for mutations + security events, ephemeral
> access log for every request — is the standard model (AWS CloudTrail vs access
> logs, GCP Admin Activity vs Data Access logs, Directus Activity).

### Redaction

Every `payload`/`response` is run through `redact()` before insert: keys matching
`token | secret | password | api[-_]?key | authorization | cookie | session` are
replaced with `[redacted]`. Audit rows never store credentials verbatim.

## Action namespaces → Logs lenses

Actions are dot-namespaced (`item.create`, `schema.update`, `access.read`). The
prefix before the first `.` drives both the Stream-view **source lens** and the
Table-view category chip, and the `/api/activity?action=<prefix>` filter is a
`LIKE '<prefix>%'`:

| Prefix | Lens | Examples |
|---|---|---|
| `item` / `schema` / `role` | Data | `item.create`, `schema.update` |
| `access` | **Access** | `access.read` |
| `webhook` / `flow` | Automation | `flow.run` |
| `function` | Functions | `function.invoke` |
| `storage` | Storage | `storage.upload` |
| `mcp` | **Agents** | `mcp.call`, `mcp.denied` |
| `request.error` | HTTP | 5xx errors |

### Authorization writes

Everything that changes *who may do what* lands under `role.*`, and everything
that changes *who may get in* under `auth.*` — so an access review is two
filters, not a hunt.

| Action | What happened |
|---|---|
| `role.create` / `role.update` / `role.delete` | Role CRUD. The update row carries `adminFrom` / `adminTo` when the privilege flag flipped, because "changed: [admin]" does not say which direction. |
| `role.create` / `role.delete` on a permission id | A grant was attached to or revoked from a role. |
| `role.create` / `role.delete` on a **user** id | A role was handed to or taken from a person. Filed under the user, because an auditor asks what *this account* was given. |
| `auth.create` | A workspace invite was issued. |
| `auth.update` | Suspend, reactivate, rename, or a two-factor reset. |
| `auth.delete` | Sessions revoked, an invite revoked, or a member removed from the workspace. |

**Grants are recorded by shape, never by content.** A permission row's
`condition` DSL and its `fields` allow-list are *not* stored — the log keeps
`hasCondition` and `fieldCount` instead. [Redaction](#redaction) only inspects
key *names*, so an email address or identifier written inside a condition
string would pass straight through it. For the same reason an invite token, a
session id, and anything from a two-factor enrolment are all absent.

## Sensitive-read auditing (opt-in)

Some data (health records, PII, financial rows) is subject to "who *viewed* this
record" requirements (HIPAA, PCI-DSS, government). For those cases a collection
can opt into read auditing.

### Enabling

Per collection — **Collection → Settings → Scoping & lifecycle → Audit reads**,
or set `auditReads: true` on `POST`/`PATCH /api/collections`. Off by default.

When on, every read path records one `access.read` activity row.

**REST:**

- `GET /api/items/:slug` (list)
- `GET /api/items/:slug/:id` (by-id)
- `GET /api/items/:slug/export`
- `POST /api/items/:slug/search`
- `POST /api/items/:slug/aggregate`

**GraphQL** — the same rows, with `payload.surface: "graphql"` so the two are
distinguishable in the log:

- `<collection>` / `<collection>Page` (list)
- `<Collection>(id:)` (by-id)
- `<collection>Search`, `<collection>Aggregate`
- **nested relations** (`{ visits { patient } }`) — one row per batch, because
  the loader reads them as one `WHERE id IN (…)`. This is the read most worth
  recording and the easiest to miss: it never touches the by-id resolver, so a
  hook on the two obvious entry points alone would leave a bulk read of the
  sensitive collection — through an un-audited one — invisible.

The rows surface under the **Access** lens in Logs, filterable via
`/api/activity?action=access`.

Both surfaces go through one service (`services/items/read-audit.ts`), the way
the write path already shares `performCreate`/`performUpdate`. That is the point:
GraphQL recorded nothing for as long as it had its own read path, and a second
implementation is how the two would drift again.

### Security & permissions interplay

- **Reads are still gated first.** The audit hook fires *after*
  `requirePermission(collection, "read")` resolves and the data is fetched, so a
  denied read (`401`/`403`) never produces an `access.read` row — only reads the
  caller was actually allowed to make are logged. The row's `userId` / `ip` /
  `userAgent` identify the caller.
- **Metadata only — never row values.** An `access.read` row stores *who / when /
  ip + the query shape, result count, and the item id(s) returned* (list) or the
  *viewed item id + the field names returned* (by-id). It never stores field
  **values**, so the audit trail can't itself become a second copy of the
  sensitive data it's protecting. (`response` is always null for reads.)
- **A relation batch records what it actually read.** An id the caller asked for
  but was not allowed to see resolved to `null` and was never read, so it is not
  in the row's `ids` — recording it would claim an access that did not happen.
- **Non-admins** only ever see their own `activity` rows via `/api/activity`, so
  the access trail doesn't leak who-viewed-what to ordinary users.
- **Fire-and-forget.** Auditing runs via `keepAlive` (`waitUntil`) and swallows
  its own errors, so it adds no latency to reads and a failed audit insert can
  never fail or slow the read itself.

### Coverage & limits

- Covers REST item reads (and therefore the public SDK and MCP, which use the
  same routes) **and GraphQL item reads**, including nested relations.
- Still not audited, and each for a stated reason rather than by oversight:
  `GET /:slug/:id/revisions` and `/transitions` (they read metadata about a row,
  not the row), and the changefeed `/:slug/changes` (a sync client polls it
  continuously, so a row per poll would drown the log it is meant to make
  readable). If a deployment needs those, say so — they are cheap to add now
  that both surfaces share one hook.
- `durationMs` is null on GraphQL rows: one request can read several
  collections, so a per-request elapsed figure would be the same number on every
  row and would describe none of them.

## MCP tool auditing

Every MCP `tools/call` fans out into an internal sub-fetch, so the *underlying*
REST route logs its own `item.create` row. What that misses is the layer above:
which **tool** an agent reached for, whether a guard refused it, and how long it
took. Those land under `mcp.*`:

| Action | When |
|---|---|
| `mcp.call` | A tool ran and returned a result |
| `mcp.error` | A tool ran and reported an error (or threw) |
| `mcp.denied` | A [guard](./mcp.md#mcp-guards) refused the call before the tool ran |
| `mcp.resource` | A `resources/read` served workspace data |

Rows carry `collection: "system_mcp"` and put the canonical dotted tool id (or
the `backlex://…` URI) in `item_id`, so `/api/activity?action=mcp&itemId=collections.delete`
answers "who has been deleting rows through an agent". The payload records the
tool's `kind`, which mount served it, the calling key id when one was used, and a
**summarised** copy of the arguments — long strings clipped, long arrays cut to
a head plus a count, and anything over 8 KB replaced by its key list, so a bulk
insert doesn't get copied into the audit log. Secrets are redacted by the same
[redactor](#redaction) as everything else.

Volume is tuned with `MCP_AUDIT_LEVEL`:

| Value | Records |
|---|---|
| `all` | Every call and every resource read |
| `writes` (default) | Write/destruct calls only |
| `off` | Nothing |

Refusals (`mcp.denied`) and errors (`mcp.error`) are recorded at **every**
level, including `off` — those are the security-relevant events and they're rare
by construction, so dropping them would defeat the point.

## Retention

A daily cron tick (`services/scheduler.ts`) prunes old rows:

| Rows | Env | Default |
|---|---|---|
| All activity | `ACTIVITY_RETENTION_DAYS` | 90 days |
| `access.*` only | `ACCESS_AUDIT_RETENTION_DAYS` | 30 days |
| `mcp.*` only | `MCP_AUDIT_RETENTION_DAYS` | 30 days |

`access.read` and `mcp.*` rows are higher-volume, so they get shorter dedicated
clocks (`pruneOldActivityByPrefix(ctx, days, "<prefix>.")`) on top of the global
prune. Set any of them to `0` to disable that pass.

The same daily tick also prunes three tables that used to grow forever —
finished jobs (`JOBS_RETENTION_DAYS`, 30; `JOBS_DEAD_LETTER_RETENTION_DAYS`, 90),
webhook deliveries (`WEBHOOK_DELIVERIES_RETENTION_DAYS`, 30) and item revisions
(`REVISIONS_RETENTION_DAYS`, 180). See `docs/jobs.md` and `docs/webhooks.md`.
