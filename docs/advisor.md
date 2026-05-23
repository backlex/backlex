---
title: Advisor
description: Automated lint over live workspace state — schema, permissions, and configuration.
---

The Advisor is an admin-only page (`/advisor` in the admin SPA) that runs an
automated lint over **live workspace state** — schema, permissions, and
configuration. Every finding is computed from real DB / env data; no
statistics are fabricated.

- **Endpoint:** `GET /api/admin/advisor` (admin role required).
- **Runs on demand.** There is no server cron or cache — the rules engine
  (`apps/web/src/server/services/advisor.ts`) executes on every request. The
  page header shows `Last run: <local time>` from the response's
  `generatedAt` field.
- **Tenant-scoped.** Findings only reflect the caller's active workspace.
  Roles, collections, permissions, and API keys are all filtered by
  `tenant_id`.

## Response shape

```jsonc
{
  "data": [ /* AdvisorCheck[] */ ],
  "score": 86,                       // 0–100, server-computed
  "generatedAt": "2026-05-22T14:32:00.000Z"
}
```

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
| `no-admin`               | `warn`  | no user in the tenant holds the `admin` role — admin surfaces have no operator                          |

### Performance

These are **static, schema-derived** index-presence checks. They introspect
which physical indexes exist (SQLite `PRAGMA index_list` / `index_info`, PG
`pg_index`) and flag hot query paths with no covering index. They do **not**
use query-level statistics (seq-scan counts, latencies) — the app does not
collect those, so no finding pretends to.

| rule            | level  | triggers when…                                                                                       |
|-----------------|--------|------------------------------------------------------------------------------------------------------|
| `owner-index`   | `warn` | an owner-scoped collection's physical table has no index leading with `owner_id`                     |
| `created-index` | `info` | a collection with a `created_at` column has no index covering it (the items query default-sorts `-created_at`) |

Each check is wrapped in `try/catch` and skips silently when a table is not
migrated or index introspection fails for a dialect.

## Grouping & dismiss (UI)

- Findings that share a `rule` are rendered as one collapsible group with a
  count badge and the worst severity icon; expanding it lists each individual
  finding. A rule with a single finding renders as a plain row.
- Tabs, summary tiles, and the score always count **individual** findings —
  five unscoped keys are five warnings, not one.
- Within each tab, findings/groups are ordered `error → warn → info`.
- **Dismiss is localStorage-only.** Dismissed finding ids are stored under
  `workeros.advisor.dismissed` in the browser; there is no server-side
  dismiss state and no DB table. Dismissing hides a finding locally and does
  not change the score.
