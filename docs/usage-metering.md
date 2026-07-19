---
title: Usage metering & quotas
description: Per-workspace / per-API-key request counters, storage and row gauges, per-key rate limits and monthly quotas, and soft/hard workspace plan limits.
---

Backlex meters API usage per workspace and per API key, shows it on the admin
**Observability → Usage** page, and can enforce limits against it — from a
gentle "you're over budget" banner up to hard 429s. It closes the gap between
the platform's rate limiters (enforcement without measurement) and the metrics
dashboard (measurement without enforcement): the `usage_counters` ledger is a
store both sides share.

## What is measured

| Metric | Granularity | How |
|---|---|---|
| Requests | per workspace, per API key, per UTC day | Counted by the usage middleware on every metered `/api/*` response. Auth endpoints (`/api/auth/*`, tenant auth) and 429 responses are excluded — a throttled client doesn't burn its own quota. |
| Errors | same | The 5xx subset of requests. |
| Storage bytes | per workspace (gauge) | `SUM(files.size)`, refreshed by the cron sweep (~every 30 min). |
| DB rows | per workspace (gauge) | `COUNT(*)` across the workspace's collections, same sweep. |

Counts land in the dual-dialect `usage_counters` table — one row per
`(tenant, api_key, day)`; `api_key_id = ''` is the bucket for session/admin
traffic. Writes are **buffered per isolate** and flushed as a single
`ON CONFLICT … + excluded` upsert every ~20 events or 10 seconds (the cron
tick also flushes), so a busy deployment pays roughly one ledger write per
twenty requests. The trade-off: an isolate evicted mid-buffer under-counts by
at most one buffer — the ledger is quota-grade, not billing-grade.

## Per-API-key limits

Two admin-only knobs live on the key row (`Settings → API keys` to mint,
**Usage** page to edit):

- **`rateLimitPerMinute`** — a per-key requests-per-minute cap enforced by the
  global API limiter. Unlike the shared budget (600/min, cloud-only by
  default), an explicit per-key cap is enforced **even on self-host deploys
  where the global limiter is off**. Responses carry the standard
  `RateLimit-*` headers.
- **`monthlyQuota`** — requests per UTC month, checked against the ledger.
  Over-quota calls get **429 `QUOTA_EXCEEDED`** until the month rolls over
  (or an admin raises the quota). Distinct from `RATE_LIMITED` on purpose:
  clients should not retry-with-backoff a budget that resets next month.

Both are admin-only (on create and on `PATCH /api/api-keys/:id/limits`) — a
key owner must not be able to out-configure the global budget.

## Workspace plan limits

The `usageLimits` setting (admin-editable on the Usage page, stored in
`app_settings`) declares:

```jsonc
{
  "mode": "off" | "soft" | "hard",
  "maxRequestsPerMonth": 100000,   // or null = unlimited
  "maxStorageBytes": 1073741824,   // or null
  "maxDbRows": 50000               // or null
}
```

- **off** — limits are not evaluated at all.
- **soft** — overage is surfaced (`over: [...]` in the usage API, a banner in
  the admin) but nothing is blocked.
- **hard** — over-budget traffic is rejected:
  - requests → 429 `QUOTA_EXCEEDED` on `/api/*` for **API-key and workspace
    end-user traffic only**. Platform admin sessions are deliberately exempt
    so an over-quota workspace can never lock its own admin out of the page
    that raises the limit.
  - storage → uploads (direct PUT, from-URL import, TUS create) are rejected
    once `SUM(files.size)` reaches the cap.
  - rows → item creates are rejected while the row gauge is at/over the cap.
    The gauge refreshes on the sweep, so this fence is **approximate by
    design** — a burst can overshoot until the next sweep.

### Env pinning (managed cloud)

`USAGE_LIMIT_MODE`, `USAGE_LIMIT_REQUESTS_MONTH`, `USAGE_LIMIT_STORAGE_BYTES`
and `USAGE_LIMIT_DB_ROWS` override the setting **field-by-field** — this is
how a control plane injects a tenant's plan. Pinned fields render read-only in
the admin editor and are reported as `envPinned` by the usage API.

## Admin page

**Observability → Usage** shows the month's request/error totals with limit
progress bars, storage/row gauges, a per-day request chart (errors stacked in
red), and the per-key table (usage vs quota, rate limit, revoked keys keep
their history). The chart has a **consumer filter** — pick an API key (or the
sessions bucket) to see just its daily series. The **Export** button downloads
the current month's ledger as CSV; the **Limits** button edits workspace
limits; the row action edits a key's limits. All writes are optimistic.

## Exporting the ledger (billing)

The buffered write path is quota-grade; for revenue-grade metering, export the
raw ledger and reconcile downstream:

```
GET /api/admin/usage/export?from=2026-07-01&to=2026-07-31&format=csv
```

- One row per `(day, api_key_id)` with the key's name/prefix resolved
  (`api_key_id = ""` is the session/admin bucket; deleted keys export as
  `(deleted key)` — their counts survive key deletion).
- The in-memory counter buffer is **flushed before reading**, so requests the
  serving isolate has counted are always included. Counts still buffered on
  *other* isolates land within one flush window (~10s) — export at least that
  long after the period closes.
- `from`/`to` are inclusive UTC days; default is the current month-to-date;
  the range is capped at 366 days. `format=csv` returns an RFC 4180 file
  (every cell quoted), otherwise JSON.

## API surfaces (full parity)

Every surface calls the same `usageOverview` / `saveUsageLimits` service pair:

| Surface | Read | Write |
|---|---|---|
| REST | `GET /api/admin/usage/overview?days=30`, `GET /api/admin/usage/export?from&to&format` | `PUT /api/admin/usage/limits` |
| SDK | `client.usage.overview({ days })`, `client.usage.export({ from, to })` | `client.usage.setLimits(limits)` |
| GraphQL | `usageOverview(days: Int): JSON`, `usageExport(from: String, to: String): JSON` | `usageSetLimits(limits: JSON): Boolean` |
| MCP | `usage.overview`, `usage.export` | `usage.set_limits` |
| CLI | `backlex usage overview | series | export | limits` | `backlex usage set-limits --data '…'` |

Per-key limits ride the API-keys surface: `POST /api/api-keys` accepts
`rateLimitPerMinute` / `monthlyQuota` (admin-only), and
`PATCH /api/api-keys/:id/limits` updates them.

The parity gate is `apps/web/tests/usage-surfaces.test.ts`; enforcement edges
(quota 429s, admin exemption, storage/row fences, gauge sweep, env pinning)
are pinned in `apps/web/tests/usage.test.ts`.

## Freshness & precision (deliberate trade-offs)

- Monthly sums used by quota checks are cached per isolate for 60 s.
- Effective limits are cached per isolate for 30 s (a limits save applies
  immediately on the isolate that served it, within ~30 s elsewhere).
- Gauges refresh on a ~30-minute sweep.

All three windows are small relative to what they bound (a monthly budget, a
plan change, a storage footprint). None of this is suitable for **billing** —
for revenue-grade metering, use the ledger export above and reconcile
downstream.
