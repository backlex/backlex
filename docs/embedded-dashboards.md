---
title: Embedded BI dashboards
description: Group saved panels into named dashboards and publish a dashboard to a public, unauthenticated embed URL you can drop into an iframe on your own site — the BaaS equivalent of Metabase/Superset embedding. Admin-authored; reachable over REST, the SDK, GraphQL, MCP, and the CLI.
---

# Embedded BI dashboards

Group saved **panels** into named **dashboards** and publish a dashboard to a
public, unauthenticated **embed URL** you can drop into an `<iframe>` on your own
site — the BaaS equivalent of Metabase/Superset embedding.

Dashboards build on the existing Insights panels (`saved_panels`): a panel is a
single chart (a collection aggregate, a read-only SQL `SELECT`, or a static
config); a dashboard is a named grouping of panels.

## Anatomy

Two system tables (dual-dialect, in `packages/db/src/{pg,sqlite}/schema.ts`):

- **`dashboards`** — `id`, `tenantId`, `name`, `description`, `layout` (JSON,
  dashboard-level display config), `embedEnabled` (bool), `embedTokenHash`
  (SHA-256 of the one-time embed token), `embedRoleId` (role the public embed
  scopes data to), `createdBy`, timestamps.
- **`saved_panels.dashboard_id`** — nullable FK-ish column. `NULL` = a loose
  ("Ungrouped") panel rendered on the default Insights grid; otherwise the panel
  belongs to that dashboard.

### Panel kinds & viz

Panels are unchanged from Insights:

| Kind | Data source |
|---|---|
| `items-aggregate` | `count` / `sum` / `avg` / `min` / `max` over a collection, optional `groupBy` + filter DSL — permission-aware |
| `sql` | a single read-only `SELECT` against the workspace DB |
| `static` | renders its `config` verbatim |

Viz types: `counter`, `sparkline`, `bars`, `donut`, `table`. The renderer
(`apps/web/src/client/admin/panel-render.tsx`) is shared by the admin grid and
the public embed page so both agree on how each viz maps its rows.

## The public embed

`POST /api/admin/dashboards/:id/share` mints a one-time token (`dsh_<hex>`),
sets `embedEnabled = true`, and returns `{ token, url }` where `url` is
`/embed/d/<token>`. Only the **SHA-256 hash** is stored — the plaintext token is
shown once (rotate to invalidate the old one; `DELETE …/share` revokes).

The token resolves at:

- `GET /api/public/dashboards/:token` — **no auth**. Returns the dashboard plus
  every panel's rendered data.
- `/embed/d/:token` — a chrome-less SPA page that renders that payload. It's
  served with `frame-ancestors *` and no `X-Frame-Options`, so it loads inside a
  third-party `<iframe>`. (All other routes keep the strict same-origin policy.)

```html
<iframe src="https://your-workspace.example.com/embed/d/dsh_…"
        width="100%" height="640" frameborder="0"></iframe>
```

### Data scope (`embedRoleId`)

Because the embed has no session, panel data is run under a chosen scope:

- **Public (unscoped, default)** — `items-aggregate` panels run with full read
  access. Use only for genuinely public stats.
- **Role-scoped** — pass `roleId` on `share`. Each `items-aggregate` panel then
  resolves that role's `read` permission for its target collection and clamps
  the query (`whereSql` + field allow-list), so the embed can never expose rows
  or columns the role can't read. `sql` panels always run as read-only `SELECT`s
  (admin-authored).

## Surfaces

Mirrors the multi-surface parity rule (REST + SDK + GraphQL + MCP + CLI). The
parity gate is `apps/web/tests/dashboards-surfaces.test.ts`.

### REST (`/api/admin/dashboards`, admin-only)

`GET /`, `POST /`, `GET /{id}`, `PATCH /{id}`, `DELETE /{id}`,
`POST /{id}/run`, `POST /{id}/share`, `DELETE /{id}/share`. Panels accept a
`dashboardId` on `/api/admin/panels`; list them per dashboard with
`?dashboardId=<id>` (or `?dashboardId=none` for ungrouped).

### SDK

```ts
const { data } = await client.dashboards.create({ name: "Revenue" });
await client.dashboards.run(data.id);            // -> per-panel results
const { token, url } = await client.dashboards.share(data.id, { roleId });
await client.dashboards.revoke(data.id);
```

`client.dashboards.{list,get,create,update,delete,run,share,revoke}`.

### GraphQL

Queries `dashboards`, `dashboard(id)`. Mutations `createDashboard`,
`updateDashboard`, `deleteDashboard`, `runDashboard`, `shareDashboard`,
`revokeDashboardEmbed`.

### MCP

`dashboards.list`, `dashboards.get`, `dashboards.run` (wrap the REST endpoints).

### CLI

```bash
backlex dashboards list
backlex dashboards run <id>
backlex dashboards create --data '{"name":"Revenue"}'
backlex dashboards share <id> [--role <roleId>]
backlex dashboards revoke <id>
```

## Admin UI

`/insights` gains a dashboard picker strip (All · each dashboard · Ungrouped ·
New dashboard). Selecting a dashboard filters the grid, lets new panels attach
to it, and exposes a **Share** dialog (enable/disable embed, pick data scope,
copy/open/rotate the public link).
