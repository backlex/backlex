---
title: Advisor
description: Automated lint over live workspace state — schema, permissions, configuration, and recorded traffic.
---

The Advisor is an admin-only page (`/advisor` in the admin SPA) that runs an
automated lint over **live workspace state** — schema, permissions,
configuration, and the traffic the API actually served. Every finding is
computed from real DB / env / span data; no statistics are fabricated.

- **Endpoints:**
  - `GET /api/admin/advisor?days=N` — run the checks (admin role required).
  - `GET /api/admin/advisor/insights?days=N&limit=N` — the runtime aggregation
    the traffic-derived rules are computed from.
  - `POST /api/admin/advisor/apply` — carry out a finding's remediation.
- **Runs on demand.** There is no server cron or cache — the rules engine
  (`apps/web/src/server/services/advisor.ts`) executes on every request. The
  page header shows `Last run: <local time>` from the response's
  `generatedAt` field.
- **Tenant-scoped.** Findings only reflect the caller's active workspace.
  Roles, collections, permissions, API keys, and spans are all filtered by
  `tenant_id`.
- **Available on every surface:** REST, the TypeScript SDK
  (`client.advisor.run / insights / apply`), GraphQL (`advisor`,
  `advisorInsights`, `advisorApply`), MCP (`advisor.run`, `advisor.insights`,
  `advisor.apply`), and the CLI (`backlex advisor`, `backlex advisor insights`,
  `backlex advisor --apply <id>`). All of them call the same service trio.

## Response shape

```jsonc
{
  "data": [ /* AdvisorCheck[] */ ],
  "score": 86,                       // 0–100, server-computed
  "generatedAt": "2026-05-22T14:32:00.000Z",
  "runtime": {                       // what the traffic rules had to work with
    "windowDays": 7,
    "spanCount": 18412,
    "sampleRate": 1,
    "truncated": false
  }
}
```

`runtime.spanCount === 0` means **no traffic-derived rule could fire** — which
is not the same as "no problems found". The page and the CLI both say so
explicitly rather than letting an empty result read as a clean bill of health.

Each `AdvisorCheck`:

| field        | meaning                                                       |
|--------------|---------------------------------------------------------------|
| `id`         | stable per-finding identifier                                 |
| `kind`       | `security` \| `performance`                                   |
| `level`      | `error` \| `warn` \| `info`                                   |
| `rule`       | rule-family id — findings sharing it are grouped in the UI    |
| `groupTitle` | category label shown when a rule has multiple findings        |
| `title`      | the specific finding headline                                 |
| `body`       | full explanation                                              |
| `fix`        | suggested remediation (copyable from the UI)                  |
| `resource`   | the affected object, e.g. `permissions · posts`               |
| `link`       | optional admin SPA route to the relevant page                 |
| `action`     | present when the advisor can apply the fix itself (see below) |
| `evidence`   | observed numbers behind a traffic-derived finding             |

`evidence` is what separates a **measured** finding from an inferred one. Its
presence means the numbers in `body` came from recorded spans:

```jsonc
"evidence": {
  "requests": 1240,     // spans seen — NOT extrapolated to a true request count
  "windowDays": 7,
  "p95": 812,           // ms, on latency findings
  "errorRate": 0.07,    // 5xx share, on error findings
  "share": 0.84         // share of the collection's list traffic, on index findings
}
```

## Score

```
score = max(0, 100 - errors * 18 - warns * 7)
```

Computed server-side over **all** findings (info findings do not affect it).
The score reflects real state — dismissing a finding in the UI does **not**
change it.

## Rule catalog

### Security

| rule                     | level   | triggers when…                                                                                          |
|--------------------------|---------|---------------------------------------------------------------------------------------------------------|
| `public-read`            | `error` | the `public` role has a `read` permission with a `null` condition — anonymous traffic can list every row |
| `public-write`           | `error` | the `public` role has a `create` / `update` / `delete` permission — anonymous traffic can mutate data    |
| `owner-scope`            | `error` | an owner-scoped collection's `authenticated` `update` permission has no DSL condition (or is missing)    |
| `apikey-noscope`         | `warn`  | an active, non-expired API key has `role_id = null` — it inherits its owner's full role set              |
| `apikey-expired`         | `info`  | an API key is past its `expires_at` but `revoked_at` is still null — harmless but stale                  |
| `oauth-incomplete`       | `warn`  | exactly one of `OAUTH_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` is set — the provider silently won't wire |
| `email-console-fallback` | `info`  | no workspace `email_config` and no env email credentials — mail logs to stdout instead of sending       |
| `sms-console-fallback`   | `warn`  | no workspace `sms_config` and no env SMS credentials — the console adapter reports every recipient as sent |
| `push-console-fallback`  | `warn`  | no workspace `push_config` and no env FCM/APNs/Web Push credentials — same, and it returns no invalid tokens |
| `permission-write-check` | `error`/`warn`/`info` | a write landed outside its role's `write` conditions — see below, this one is traffic-derived            |
| `no-admin`               | `warn`  | no user in the tenant holds the `admin` role — admin surfaces have no operator                          |

**Why SMS and push are `warn` where email is `info`.** All three console
adapters log the message instead of sending it, but only the messaging ones
*assert* that they delivered: `{ sent: recipients.length, failed: 0 }` is
byte-for-byte what a real provider returns on a perfect send, so the API
response, the activity row and the usage counters all agree that it went out.
An undelivered verification mail is eventually noticed by the person waiting
for it; an undelivered SMS is reported as delivered and nothing ever corrects
it. Push additionally returns no invalid tokens, so a device that should have
been pruned stays on the list.

**None of the three fires on managed cloud.** `buildContext` swaps the console
adapter for the control-plane gateway whenever the resolved spec is `console`
and the project is a managed one, so the fallback cannot happen there. Note
this is a *different* judgement from `backups-off`, which deliberately does not
skip on tenancy alone — a managed plan can exclude backups, so that rule keys on
`CLOUD_MANAGED_BACKUPS` (whether the platform really takes them) rather than on
who the tenant is. Ask what the platform does, not who is asking.

**`permission-write-check` is the one security rule that reads traffic**, so
unlike its neighbours it stays silent on a workspace with no recorded spans.
It answers the single question `PERMISSION_WRITE_CHECK` exists to raise:

| what it saw | level | what it means |
|---|---|---|
| the mode is `warn` and nothing was recorded | `info` | no recorded write in the window would be refused — this is the green light to set `PERMISSION_WRITE_CHECK=enforce` |
| the mode is `warn` and something was | `error` | flipping to `enforce` would start refusing a caller that changed nothing. Decide first: widen the condition, or fix the caller |
| the mode is `enforce` and something was | `warn` | writes are being refused right now. The caller is broken, but no row landed where it should not have |

The default is `warn`: a write outside its role's `write` conditions is
counted and allowed. That default is deliberate and not an oversight — a
tenant's integrations may have been writing cross-scope rows for months against
a rule that only ever filtered READS, and turning that into a 403 on upgrade
breaks a working application for somebody who changed nothing. This rule is
what makes the flip a measurement instead of a guess.

Two things the count deliberately does not include, both because "zero" has to
mean what an operator reads it as. Conditions that reach through a **relation**
(`author.department`) cannot be judged in memory and are allowed under either
setting, so they are outside the count either way. And one **request** counts
once however many rows it wrote — a 5,000-row import that misses the same
condition every time is one span and one finding.

### Performance

Two families, deliberately distinct.

**Static, schema-derived.** These introspect which physical indexes exist
(SQLite `PRAGMA index_list` / `index_info`, PG `pg_index`) and flag the hot
query paths the *schema implies*. They fire on a workspace with zero traffic.

| rule            | level  | triggers when…                                                                                       |
|-----------------|--------|------------------------------------------------------------------------------------------------------|
| `owner-index`   | `warn` | an owner-scoped collection's physical table has no index covering `owner_id`                          |
| `image-passthrough` | `warn` | no in-process image transformer loaded and no edge resize backend — `?w=`/`?h=` are accepted and ignored |
| `created-index` | `info` | a collection with a `created_at` column has no index covering it (the items query default-sorts `-created_at`) |

**Runtime, traffic-derived.** These aggregate the `spans` rows the request
middleware already writes and flag what actually happened. Every finding quotes
its observed numbers in `body` and carries `evidence`.

| rule               | level          | triggers when…                                                                                     |
|--------------------|----------------|-----------------------------------------------------------------------------------------------------|
| `slow-endpoint`    | `warn`/`error` | an endpoint's p95 ≥ 500 ms over ≥ 20 recorded requests (`error` at ≥ 2000 ms)                        |
| `endpoint-errors`  | `error`        | ≥ 5% of an endpoint's ≥ 10 recorded requests returned 5xx                                            |
| `hot-filter-index` | `warn`         | a column is filtered on ≥ 20% of a collection's ≥ 20 recorded list requests and has no covering index |
| `hot-sort-index`   | `warn`         | same, for sorting, at a ≥ 50% share (sorting names a column on essentially every list request)        |

Each rule caps at 5 findings so a broken deploy can't flood the page.

Every check is wrapped in `try/catch` and skips silently when a table is not
migrated or index introspection fails for a dialect.

#### How index coverage is decided

A column counts as covered when it leads an index, **or** when every column
before it in a composite index is pinned by equality on every query. Today that
pinned set is `tenant_id`, which is applied by `tenantFilter` on every read of
a managed collection. This is why a managed collection's
`(tenant_id, created_at, id)` pagination index correctly counts as covering a
`-created_at` sort — reading only the leading column would report a missing
index that isn't missing.

#### Where the traffic data comes from

The items list handler records the collection and the **local column names** its
query filters and sorts on into the span's `attributes` (`collection`,
`filters`, `sorts`). Only names — no filter values ever reach telemetry. A
dotted key that traverses a relation (`customer_id.city`) is recorded as its
head segment, since that is the column the local table has to look up.

When one (table, column) pair is reported by both families, the traffic-derived
finding wins and the static one is suppressed — one finding per real problem,
and the more informative one survives.

#### Honesty rules

- `requests` is the number of spans **seen**, never an estimate of the true
  request count.
- With `TRACES_SAMPLE_RATE` below 1, `runtime.sampleRate` rides along and every
  surface says the numbers describe a sample.
- Spans are pruned on a retention schedule, so a window longer than retention
  silently sees less data. `window.oldestSpanAt` exposes that, and the Insights
  tab calls it out when the oldest span is well after the window start.
- A window holding more than 20 000 spans is aggregated over the most recent
  20 000 and flagged with `truncated: true`.

## Runtime insights

`GET /api/admin/advisor/insights?days=7&limit=50` returns the aggregation
directly — it is also the third tab on the Advisor page.

```jsonc
{
  "endpoints": [                     // slowest first (p95 desc, ties by traffic)
    { "route": "GET /api/items/posts", "method": "GET", "path": "/api/items/posts",
      "requests": 1240, "p50": 210, "p95": 812, "p99": 1400, "maxMs": 2210,
      "avgMs": 305, "serverErrors": 0, "clientErrors": 3, "errorRate": 0 }
  ],
  "collections": [                   // busiest first
    { "collection": "posts", "listRequests": 1240, "p50": 210, "p95": 812,
      "filters": [{ "column": "status", "requests": 1040, "share": 0.84 }],
      "sorts":   [{ "column": "created_at", "requests": 1240, "share": 1 }] }
  ],
  "window": { "from": 0, "to": 0, "days": 7, "spanCount": 18412,
              "oldestSpanAt": 0, "sampleRate": 1, "truncated": false }
}
```

Concrete ids in a path fold to `:id` so `/api/items/posts/<uuid>` groups as one
endpoint. The **collection slug is deliberately not folded** — "which
collection is slow" is the question being asked.

## Applying a fix

Findings the server can remediate itself carry an `action`:

```jsonc
"action": {
  "type": "create-index",
  "table": "c_a1b2c3d4e5f6_posts",
  "indexName": "bx_idx_c_a1b2c3d4e5f6_posts_status",
  "columns": ["status"],
  "sql": "CREATE INDEX IF NOT EXISTS \"bx_idx_…_status\" ON \"c_…_posts\" (\"status\")"
}
```

`POST /api/admin/advisor/apply` takes **only** `{ id }` (plus the optional
`days` window the finding was produced under). The server re-runs the advisor,
matches the finding by id, and executes the statement *that fresh finding*
carries — the `sql` above is informational and is never accepted back from a
client. Consequences worth knowing:

- A finding that no longer holds can't be applied: the id stops resolving and
  the call 404s. That also makes replaying a stale fix impossible.
- A finding with no `action` is rejected with `VALIDATION`.
- Both dialects use `CREATE INDEX IF NOT EXISTS`, so a concurrent apply is a
  no-op rather than an error.
- Every apply writes an `advisor.apply` activity row carrying the finding id,
  the rule, and the exact statement.
- The endpoint is blocked in playground/demo mode (`DEMO_MODE`) — it runs DDL
  against a shared table. Advisor **reads** stay open there.

Index names are `bx_idx_<table>_<columns>`, truncated with a checksum suffix
when they would exceed PG's 63-byte identifier limit. Both the table and the
columns are verified against the live catalog before any statement is built.

## Grouping & dismiss (UI)

- Findings that share a `rule` are rendered as one collapsible group with a
  count badge and the worst severity icon; expanding it lists each individual
  finding. A rule with a single finding renders as a plain row.
- Tabs, summary tiles, and the score always count **individual** findings —
  five unscoped keys are five warnings, not one.
- Within each tab, findings/groups are ordered `error → warn → info`.
- **Dismiss is localStorage-only.** Dismissed finding ids are stored under
  `backlex.advisor.dismissed` in the browser; there is no server-side
  dismiss state and no DB table. Dismissing hides a finding locally and does
  not change the score.
