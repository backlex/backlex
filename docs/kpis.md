---
title: KPIs (the shared definition layer)
---

A **KPI** is a named figure and the formula behind it, written down once. Panels,
Ask AI, reports and the public embed all evaluate it through the same function,
so the number on a chart and the number an agent quotes come from the same
arithmetic.

## The problem it exists for

Before this, every surface that showed a business figure worked it out
independently:

- a dashboard panel stored raw `sql` or an inline items-aggregate config;
- the **Ask AI** planner was handed the collection's column list and asked to
  invent `collections.aggregate` arguments from scratch — per question, per
  session;
- a scheduled report derived it a third way.

Nothing reconciled the three. "Revenue" could mean product totals with tax in
one place, without tax in another, and with cancelled orders still counted in a
third, and every screen presented its own answer with equal confidence. Nobody
gets a warning, because none of them is broken — they just disagree.

A KPI row **is** the definition. They can still be wrong, but now they are wrong
in unison and one edit fixes every surface at once.

## Anatomy

One system table, `kpis` (dual-dialect, in `packages/db/src/{pg,sqlite}/schema.ts`):

| Column | Meaning |
|---|---|
| `slug` | The stable handle panels and AI tool calls reference. Renaming `name` is safe; changing the slug is not. |
| `collection` / `agg` / `field` | What is aggregated. `agg` mirrors `ITEMS_AGG_FUNCS` (`count`/`sum`/`avg`/`min`/`max`); `field` is required unless `agg` is `count`. |
| `filter` | A permission-DSL condition narrowing the rows — the same grammar the list endpoint takes, so a KPI and the filtered list view an operator checks it against count the same rows. |
| `dateField` | The timestamp column the period window applies to. **Null is meaningful** — see below. |
| `groupBy` / `topN` | Turns the KPI into a ranking ("top products", "revenue by country"). |
| `format` / `unit` / `decimals` | How it should be printed: `number`, `money`, `percent` (stored as a ratio — `0.043` is 4.3%), `duration` (ms). |
| `direction` | `up`, `down` or `neutral` — which way is good news. |

`tenant_id` is `NOT NULL DEFAULT ''` rather than nullable like the tables beside
it. A unique index treats NULLs as DISTINCT, and everything downstream resolves
a KPI *by slug*, so a nullable key column would let two rows answer to one slug
and make a chart's number depend on row order. The migration spells this out.

## Evaluating one

```
GET /api/admin/kpis/{slug}/run?rangeDays=30
```

Returns the definition evaluated over the requested window **and the window
immediately before it**:

```json
{
  "data": {
    "slug": "net-revenue",
    "window": { "from": 1783327988139, "to": 1785919988139 },
    "previousWindow": { "from": 1780735988139, "to": 1783327988139 },
    "point": { "value": 4820, "previousValue": 3900, "delta": 920, "deltaPct": 0.2359 },
    "rows": null,
    "computedAt": 1785919988400
  }
}
```

Grouped KPIs return `rows` instead of `point`, each label paired with its own
previous-period value.

### The shape behind the number

Add `series=1` (optionally `buckets=N`, 2–200, default 24) and the result also
carries the window sliced into equal buckets, oldest first:

```json
"series": [{ "t": 1783327988139, "value": 3 }, { "t": 1783435988139, "value": 0 }, …]
```

It is **opt-in** because it costs one extra query per KPI; the KPIs page asks
for it (reading figures is that page's whole job), the collection tab does not.
There is no series for a KPI with no `dateField` (nothing to slice on) or a
grouped one — a series and a ranking are two questions, and a query has one
grouping dimension.

Every bucket in the range is present, including empty ones. A missing slice
would let a chart join its two neighbours and draw a line asserting the quiet
period never happened. Empty `count`/`sum` buckets are `0`; empty `avg`/`min`/
`max` buckets are `null`, and the admin's sparkline **breaks the line** there
rather than drawing zero — "we don't know" is not "it fell to nothing".

The bucket index is the one piece of this engine that branches on dialect, and
the branch is a unit conversion: SQLite stores epoch **milliseconds** in an
INTEGER, Postgres a `timestamptz` whose `EXTRACT(EPOCH …)` returns **seconds**.
Getting it wrong does not error — it produces a series bucketed a thousand
times too coarse, which looks like data — so `kpis-series-pg.test.ts` asserts
the same fixture on both.

### Three nulls that are not zeros

The result shape distinguishes "nothing" from "zero" in three places, and a
client that flattens them will print a confident lie:

- **`window: null`** — the KPI has no `dateField`, so it is a running total with
  no period comparison. Do not draw a delta badge. Windowing on `created_at` by
  default instead would produce a "change" that describes when rows were
  imported.
- **`value: null`** — an `avg`/`min`/`max` over a window with no rows. No orders
  means zero revenue (`sum` and `count` do report `0`), but it does *not* mean
  the average order value was zero.
- **`deltaPct: null`** — the baseline was zero, so there is no proportion to
  report. Dividing by zero prints `Infinity`; calling `0 → 5` "+100%" claims a
  ratio that does not exist. Show the absolute `delta` instead — the admin UI
  and the CLI both do.

## Permissions

The two halves are gated differently on purpose:

- **Authoring** a definition is admin-only. A KPI decides what a number *means*
  across every dashboard, report and AI answer in the workspace.
- **Running** one only needs a session, and the evaluation is clamped to the
  caller's own read permission on the KPI's collection —
  `permWhere`, the readable-field allow-list, soft-delete and draft visibility,
  exactly mirroring `POST /items/{slug}/aggregate`. A tile is never a way around
  a row-level condition.

## What a template brings with it

Applying a schema template seeds that vertical's KPIs alongside its
collections, sample rows and dashboards — so a fresh workspace can answer "how
is it going?" rather than only offering the tools to work it out. `ecommerce`
arrives with net revenue, orders placed, AOV, refunds, cancellations and stock
on hand; `support` with tickets opened/solved, the open backlog and average
CSAT; and so on across every vertical. The definitions live in
`apps/web/src/server/templates/kpis.ts`.

Seeding is **per-slug idempotent**: a re-apply skips definitions that already
exist, so a KPI an admin has tuned keeps their version while newly-added ones
still land.

Two things the template KPIs are careful about, both of which a hand-written
definition gets wrong the first time:

- **A money column denominated per row is only ever totalled per currency.**
  Every `money` field in the catalog carries `money: { currencyField: "currency" }`,
  and the aggregate engine refuses a `sum` over one without `groupBy: "currency"` —
  a total of mixed denominations is not a smaller number, it is not a number.
  So "Net revenue" is one figure per currency, not one figure.
- **`direction` is set wherever rising is bad news** — refunds, cancellations,
  downtime, scrap, backlogs. Without it the delta badge colours by sign alone
  and a worsening figure renders green.

`apps/web/tests/template-kpis.test.ts` walks every bundled definition against
its template's real field list, then applies all 25 templates and evaluates
every KPI each one seeded. A KPI naming a column that does not exist is not a
type error — it is a tile that fails on somebody's dashboard — so it is caught
there instead.

## On a dashboard

A panel of `kind: "kpi"` stores only `config.kpi` (the slug) and an optional
`config.rangeDays`. It carries no formula of its own — that is the point. A
panel that stored its own arithmetic would be a second opinion about what the
figure means, and the two drift the first time either is edited.

```json
{ "name": "Net revenue", "kind": "kpi", "viz": "counter",
  "config": { "kpi": "net-revenue", "rangeDays": 30 } }
```

The tile flattens onto the `{label, value}` shape every panel visualisation
already renders, keeping `previousValue` / `delta` / `deltaPct` alongside for
the ones that show a comparison. A panel pointing at a deleted definition
renders the `NOT_FOUND` as a panel error rather than an empty tile that looks
like a legitimate zero.

Three separate paths execute a panel — `/panels/preview`, `/panels/{id}/run`,
and the dashboard runner — and all three handle the kind. (Wiring only two of
them left every saved tile stuck on "No data yet", which is why the surfaces
test now covers each one.)

## On a collection's page

A collection with KPIs gets a **KPIs tab** beside Items / Schema / Settings,
carrying a count (`KPIs 4`) like the Items and Schema tabs do, and listing
every KPI whose `collection` matches with its own period picker.

A tab rather than a band above the items: the rows are what the page is for,
and metrics wedged in above them cost space on every visit whether or not
anyone wanted the numbers. The tab is the disclosure — nothing is evaluated
until it is opened.

The tab **only appears where there is something to show**. A tab present on
every collection and empty on most of them advertises a dead end; the count on
the trigger carries the "there are numbers here" signal without a click. The
definitions come from one workspace-wide, cached list, so browsing collections
costs one request rather than one per collection.

Figures are scoped to the collection, not to a single row. Per-row insights
("how is *this* product doing?") would need a KPI to declare which collection
it is pinned to and which relation column links back — that is not built.

## Ask AI

The planner is given the workspace's KPI list in its prompt and told to prefer
`kpis.run` over composing its own aggregate whenever a definition already
answers the question. This is the point of the whole feature: without the digest
the whitelist entry is inert, because the model cannot pick a slug it has never
seen and falls straight back to improvising.

A slug the model invents anyway is caught by the planner's dry-run (a
`NOT_FOUND` it can correct) rather than surfacing as an error after the operator
presses **Run**.

## Aggregation is not reimplemented

`runKpi()` delegates to `runItemsAggregate` — the same engine behind the items
aggregate endpoint and dashboard panels. That is deliberate: money columns are
rescaled from minor units there, a `sum` over a column whose currency varies per
row is refused rather than silently adding lira to dollars, and soft-deleted and
draft rows follow the caller's own visibility. A second implementation would
drift from those rules the first time one of them changed.

What the KPI layer adds on top is only the period comparison, and one thing the
aggregate engine cannot do for it: **window bounds are serialized before they
reach the filter.** `normalizeTemporalOperands` only rewrites operands on
columns declared `type: "timestamp"` in `collections.fields`, and the most common
`dateField` of all — `created_at` — is a system column that never appears there.
An ISO string compared against SQLite's `INTEGER` epoch column does not error,
it *inverts* (every number sorts before every string), so the window would
return the rows outside it and say nothing about it.

## Surfaces

| Surface | Entry point |
|---|---|
| REST | `/api/admin/kpis`, `/api/admin/kpis/{ref}/run` |
| SDK | `client.kpis.list/get/create/update/delete/run` |
| GraphQL | `kpis`, `kpi(ref:)`, `runKpi(ref:, rangeDays:, series:)`, `createKpi`, `updateKpi`, `deleteKpi` |
| MCP | `kpis.list`, `kpis.get`, `kpis.run` (with `series`) |
| CLI | `backlex kpis <list\|get\|run\|create\|update\|delete>` |
| Admin | the **KPIs** page under Observability |

`apps/web/tests/kpis-surfaces.test.ts` is the gate that keeps them in step.
