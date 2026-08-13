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

## Sensitive-read auditing (opt-in)

Some data (health records, PII, financial rows) is subject to "who *viewed* this
record" requirements (HIPAA, PCI-DSS, government). For those cases a collection
can opt into read auditing.

### Enabling

Per collection — **Collection → Settings → Scoping & lifecycle → Audit reads**,
or set `auditReads: true` on `POST`/`PATCH /api/collections`. Off by default.

When on, both REST read paths record one `access.read` activity row each:

- `GET /api/items/:slug` (list)
- `GET /api/items/:slug/:id` (by-id)

The rows surface under the **Access** lens in Logs, filterable via
`/api/activity?action=access`.

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
- **Non-admins** only ever see their own `activity` rows via `/api/activity`, so
  the access trail doesn't leak who-viewed-what to ordinary users.
- **Fire-and-forget.** Auditing runs via `keepAlive` (`waitUntil`) and swallows
  its own errors, so it adds no latency to reads and a failed audit insert can
  never fail or slow the read itself.

### Coverage & limits

- Covers REST item reads (and therefore the public SDK, which uses the same
  routes). **GraphQL reads are not yet audited** — they run through separate
  resolvers; that hook is a follow-up.
- Aggregate reads (`POST /api/items/:slug/aggregate`) are not audited.

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
