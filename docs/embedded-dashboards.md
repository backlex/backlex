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

Viz types: `counter`, `sparkline`, `line`, `area`, `bars`, `stacked-bars`,
`donut`, `pie`, `radar`, `radial`, `table`. The renderer
(`apps/web/src/client/admin/pages/observability/panel-render.tsx`) is shared by the admin grid and
the public embed page so both agree on how each viz maps its rows. Chart
vizzes draw through the shadcn chart primitives (`@backlex/ui/components/chart`,
recharts) with hover tooltips, axes and legends; the recharts bundle is
lazy-loaded (`panel-charts.tsx`) so chart-less pages never download it.
Series charts (`sparkline`/`line`/`area`/`bars`/`stacked-bars`/`radar`) draw
one series per numeric column (up to 5, colored `--chart-1..5`); segment
charts (`donut`/`pie`/`radial`) read the first non-numeric column as the
slice label and the first numeric column as the value (up to 6 slices, side
legend). A panel PATCH only touches the fields it sends — `viz`/`kind` keep
their saved values when omitted.

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

Because the embed has no session, every panel runs under a permission the same
way a signed-in read does — **sharing a dashboard is not a grant.**

- **Default (no `roleId`)** — panels resolve the workspace's `public` role. An
  `items-aggregate` or `kpi` panel over a collection the `public` role holds no
  `read` on comes back as `{"data": [], "error": "Not permitted for this
  embed."}`. Grant `public` a `read` permission on that collection (optionally
  with a condition and a field allow-list) to publish it.
- **Role-scoped** — pass `roleId` on `share` to name the role explicitly.

Either way the panel's query is clamped by that role's `whereSql` and field
allow-list, and soft-deleted rows and unpublished drafts are excluded, so an
embed can never expose rows or columns the role could not read through
`/api/items`. `sql` panels do not run on an embed at all — they carry no clamp
(the stored statement names its own tables and reaches `sql.raw`), so they are
restricted to the instance operator on every surface.

> **Changed in the 2026-09 hardening.** The default used to be *unscoped*: a
> dashboard shared with no `roleId` ran `items-aggregate` panels with full read
> access, so a panel with `groupBy` over any column returned one label per
> distinct value — a full column read, to anyone holding the link. If an
> existing embed goes blank after upgrading, that is this change; grant the
> `public` role `read` on the collection to restore it deliberately.

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
