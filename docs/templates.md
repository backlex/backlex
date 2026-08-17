---
title: Schema templates
description: Ready-made verticals applied into a workspace in one click — grouped collections and realistic sample data, plus the roles, dashboards, KPIs, automation flows, PDF templates, public forms and agents that make it a working application rather than a schema. Includes extract/apply-custom for turning any workspace into a reusable template. Reachable over REST, the SDK, GraphQL, MCP, and the CLI.
---

**Schema templates** seed a complete vertical data model into a workspace in
one action: a blog/CMS, a Shopify-grade store, a CRM, a helpdesk, and a dozen
more. A template is not just tables — it is a **bundle**:

- **Collections** with relations, indexes, colored dropdown choices, soft
  validation, computed fields, full-text search and embedding flags.
- **Laid-out item forms** — fields arrive already organized into sections (or
  tabs on the largest records), with paired scalars side by side and callouts
  on the fields that would otherwise mislead. See *Form layout* below.
- **Admin groups** — collections land pre-organized under section headers
  ("Catalog", "Orders", "Customers", …) on the Collections page and the
  sidebar tree, in the template's order.
- **Sample data** — a few realistic, relationally-consistent rows per
  collection so the workspace is demo-ready, removable in one click later.
- **Optional roles** with permission grants (e.g. the blog's *Editor*).
- **Optional insights dashboards** with pre-built panels (e.g. the store's
  *Store overview*). Panels stick to `items-aggregate`/`static` — never raw
  SQL — so seeding is safe on every runtime.
- **Optional KPI definitions** — the vertical's named figures (`net-revenue`,
  `open-backlog`, `average-csat`), so the workspace can answer "how is it
  going?" the moment the template lands rather than only offering the tools to
  work it out. A KPI may arrive already **watched**, notifying admins when it
  crosses a threshold. See [KPIs](/docs/kpis/).
- **Optional automation flows** — the vertical's own rules, already running:
  "when an order is paid, take the stock down and tell somebody", "three days
  before an invoice falls due, remind". See [Flows](/docs/flows/).
- **Optional PDF document templates** — an invoice, a quote, a work order,
  ready to render against a row. See [Documents](/docs/documents/).
- **Optional public forms** — a link an outsider fills in that lands as a row.
  See [Forms](/docs/forms/).
- **Optional AI agents** — an operator-authored assistant over the vertical's
  own data, with a fixed prompt and a named tool list. See [Agents](/docs/agents/).
- **Optional feature flags and broadcast channels** — the config a working
  application tends to need on day one.

Templates are **admin-authored DDL**: every surface below requires the `admin`
role (the same gate as `POST /api/collections`).

## The catalog

`GET /api/admin/templates` lists the built-in catalog. Each summary carries
`id`, `label`, `category`, `recommended`, `sampleRows`, the seeded `groups`,
bundled `roles`/`dashboards` names, and its collections (with their admin
`group`). The response also includes:

- `defaultTemplateId` — the cloud-preselected template (`SEED_TEMPLATE` worker
  var) so pickers can preselect it; `"blank"` otherwise.
- `hasCollections` — whether the workspace already has managed collections
  (gates the onboarding card).
- `sampleSeeds` — sample rows still recorded in the seed manifest (drives the
  "Remove sample data" affordance).

Template **ids are the contract with the cloud control plane** — keep them
stable. Definitions live one per vertical in
`apps/web/src/server/templates/defs/<id>.ts`.

## Applying

`POST /api/admin/templates/apply` with `{ "templateId": "ecommerce" }`.

Apply is **idempotent and additive**:

- Collections that already exist (by slug) are **skipped** — never altered,
  never re-seeded. A re-apply over a partially-seeded workspace converges.
- New collections are created in dependency order (relation targets first)
  with the template's `group` + a stable position (`sortOrder`).
- The template's group headers are **merged** into the workspace's
  `collectionGroups` setting: existing headers keep their saved positions,
  new ones are appended. Headers whose collections were all skipped are NOT
  merged, so re-applying never resurrects a group the admin deleted — and a
  collection the admin moved to another group **stays where they put it**.
- Sample rows are seeded only into freshly-created collections, recorded in
  the seed manifest, and their full-text index is backfilled inline. Vector
  embeddings are backfilled too when the apply comes through REST/GraphQL and
  the collection is vectorizable (best-effort, never aborts the apply); the
  `SEED_TEMPLATE` auto-apply during boot skips vectors — run
  `POST /api/collections/:slug/vectorize` later if needed.
- Bundled roles/dashboards are skipped wholesale when one with the same name
  already exists.
- Bundled KPIs are skipped **per slug**, so a re-apply keeps a definition an
  admin has tuned while still installing ones added to the template since.
- Every other bundle is skipped on its own natural key — flows and forms and
  agents by **name**, documents and flags by **key**, channels by **pattern**.
  Same rule, same reason: a re-apply must never overwrite something an admin
  has since edited.
- **Server-maintained columns are filled by the server, not by the sample.**
  A `sequence` document number is *allocated* for the seeded block (so the
  counter stands after the last demo row and the first real one does not
  collide), and every `rollup` total is restated from the children once the
  whole template is on disk. A sample naming either column is ignored.

The result reports what actually happened:

```json
{ "data": { "templateId": "ecommerce", "created": ["products", "…"],
            "skipped": [], "seeded": 24, "roles": ["Store staff"],
            "dashboards": ["Store overview"],
            "kpis": ["net-revenue", "orders-placed", "…"],
            "flows": ["Low stock alert"], "documents": ["packing-slip"],
            "forms": ["Wholesale enquiry"], "agents": ["Store assistant"],
            "flags": [], "channels": [] } }
```

**A seeded form's link is not in that result, and cannot be.** Only the token's
hash is stored and there is no reveal path anywhere in the API — which is the
point, since this result is written verbatim into the activity log. Open the
form in the admin and press **Rotate token** to get a shareable URL.

That also means a seeded form is **unreachable until you mint that link**: it
exists, it is listed, and nobody on the internet can post to it. Deciding a
public form is open is a thing an operator does on purpose, not something a
template does for them.

One thing to know before you open one, because a bundle can join two features
that are each fine alone: a public form writes ordinary rows, and a
[document template](/docs/documents/) prints those rows into HTML **without
escaping them** — that is the same `{{ … }}` engine email templates use, and it
is deliberate there. So a value typed by a stranger can reach a PDF as markup.
The renderer runs with JavaScript off, but a `<img src="…">` is still fetched by
whichever browser renders the page, which is why `docs/documents.md` says to
give a self-hosted Gotenberg no route to anything internal. Nothing new — worth
saying out loud now that a template can ship both halves.

**Flows that need something configured ship switched off.** A bundled flow uses
only self-contained operations; the ones that depend on a mail transport or a
PDF renderer (`email`, `sms`, `document.render`, `report.deliver`) arrive
`active: false` with a name that says so, rather than filling the runs list
with failures on day one. Operations that address an external endpoint —
`webhook`, `request`, `integration*`, `payment.*` — are **refused in the
catalog** by `templates-bundles.test.ts`.

**A flow notification with no `userId` is a broadcast to the whole
workspace.** There is no role targeting — one tenant-scoped row is written and
everybody in the workspace can read its title and body. That matters most in
templates whose roles are the point: `clinic` builds a Reception role that
deliberately cannot see visit notes, vitals, labs or prescriptions, so a
notification body carrying a test name or a medication would route clinical
data straight past that boundary, in a place nobody thinks to audit. Its
bundled lab and prescription rules therefore say only that something needs
attention and where to look — no patient, no clinical detail — while its
scheduling and billing rules do name patients, because Reception holds the
appointment book and the ledger. **A document is the opposite case and may
carry the detail**: a render is requested by somebody who already holds
permission on the record. When you write a bundled flow, check what the
template's most restricted role is allowed to see, and keep the body inside it.

**An ordered comparison against `$field.` must guard that the operand
exists.** The matcher coerces both sides with `Number()`, and `Number(null)` is
**0** — not `NaN`. So `{used: {_gte: "$field.cap"}}` on a row whose `cap` is
empty reads as `used >= 0` and is true for every row the flow ever sees; it
does not error, it just fires constantly, and the filter that was meant to
narrow it looks correct. Write the guard beside it — `{cap: {_gt: 0}}` is
usually best, since it also excludes a cap of zero and doubles as the opt-in
for rows that never set a threshold; `{_null: false}` or `{_nempty: true}` work
too, and `{_gte: 0}` does **not**. `templates-bundles.test.ts` enforces this
across the catalog. Cross-field *validation* rules are already immune —
`checkableRule` drops a comparison whose operand is absent before judging the
row — but flow conditions run the raw matcher.

**Safety rails:** apply never drops or alters existing columns (the schema
applier is additive-only), never touches rows it didn't create, and there is
no rollback — a mid-apply failure leaves already-created collections in place
and a re-apply converges the rest.

## What a template never seeds, and why

These are omissions with reasons, not gaps waiting to be filled:

| Not seeded | Why |
| --- | --- |
| Outbound **webhooks** | `url` is required and points somewhere outside. A seeded webhook with a placeholder URL fails on every delivery until the breaker disables it — a broken integration that arrived broken. |
| **Integrations** / **payment providers** | Their config holds encrypted API keys by design. There is nothing to seed without someone's credentials. |
| **Sync hooks** | Same as webhooks: a required external `url`. |
| **Approval requests** | There is no reusable approval *policy* to seed — only a live pending request, carrying real approver email addresses and a one-time link. A template must not email anybody. |
| **Booking resources** | Seeding one provisions the `booking_records` collection automatically, and the three verticals a booking page would suit already ship their own `bookings` / `appointments` collection. The workspace would open to two records of the same appointment. |
| **Notifications** / **jobs** | Neither is a definition — one is a feed row, the other a unit of queued work. Pre-loading them is stale noise, not a head start. |

Recurring schedules need no table of their own: a flow with a `cron:` trigger
**is** the schedule, and a scheduled report is that flow with a
`report.deliver` step.

## Removing sample data

`POST /api/admin/templates/clear-samples` deletes every row recorded in the
seed manifest (an `app_settings` key mapping collection slug → seeded row
ids), then clears the manifest. Rows the admin created — or seeded rows they
already deleted — are untouched, and a collection slug rename moves its
manifest entry along. The admin UI surfaces this as a callout on the
Collections page while `sampleSeeds > 0`.

Clearing is a **bulk admin operation**: it deletes rows directly (plus their
FTS index entries) and does not fire per-item delete side effects — no
webhooks, flows or realtime events. It does restate any **rollup** total the
deleted rows fed, so a cleared workspace does not keep showing the totals of
children that are gone.

## Extract & custom templates

`GET /api/admin/templates/extract` exports the workspace's managed
collections **in template format**: collection defs (fields, `ownerScoped`/
`versioned`/`vectorize`/`fts`/`singleton`/`softDelete`/`auditReads` flags,
`vectorizeModel`, `displayTemplate`, `defaultSort`, admin `group` + explicit
`sortOrder`) plus the saved group-header order. The array is emitted in
dependency order (relation targets first) — the admin's in-group arrangement
travels via `sortOrder`, not array position. Narrow with `?collections=a,b` —
relation fields pointing at collections outside the exported set stay as
plain (unlinked) columns until their target exists, since relations carry no
hard FK constraint.

**Extract carries the bundles too.** Alongside the collections and the group
order it emits the roles (with their grants), dashboards, KPIs, flows, document
templates, forms, agents, flags and channels the workspace has — the same nine
kinds an apply seeds — so an extract is a **workspace** transport, not just a
schema one. Add `?bundles=0` for the old collections-only document.

Each resource separates four things, and that split is what decides what
travels:

| | |
|---|---|
| **Natural key** | What identifies the row somewhere else, and the same key the seeder skips on: role/flow/form/agent/dashboard by `name`, KPI by `slug`, document/flag by `key`, channel by `pattern`. |
| **Portable config** | What is emitted. |
| **Secrets** | Never emitted, in any form. A form's token and a dashboard's embed token are one-way hashes: there is nothing to export, and promoting one would make two workspaces answer to a single URL token. |
| **Runtime state** | Never promoted. A KPI's `alertFiring` would import another workspace's alarm as already ringing; a form's submission count would import somebody else's traffic. |

**What could not travel is named, not dropped.** Anything the four-way split
excludes, plus every reference that cannot survive the trip, is listed under
`omissions`:

```json
{
  "collections": [ … ],
  "forms": [{ "name": "Report a problem", "collection": "tickets", "fields": [ … ] }],
  "omissions": [
    {
      "resource": "form:Report a problem",
      "what": "the public link token",
      "reason": "stored as a one-way hash — press Rotate token in the target to mint a shareable URL"
    }
  ]
}
```

The cases you will actually meet: a form's public link (always — rotate the
token in the target), a dashboard's public embed, a raw-SQL panel (only
`items-aggregate` and `static` panels are portable — a `sql` panel is bound to
the database it was written against), an agent that was open to end users
(exposure is re-decided per workspace), and — when you narrow with
`?collections=` — any role grant, KPI or form that pointed at a collection left
behind. Re-applying the document extract emitted is safe: `omissions` is
accepted and ignored on the way back in.

**Still not carried, and not planned here:** webhooks, integrations, payment
providers, sync hooks, SSO providers and booking resources. Each holds a live
credential or an external registration, so promoting one moves a secret or
points a second workspace at another's remote webhook.

Add `?samples=N` (1–50, matching the apply-side per-collection cap) to also
export the first N rows of each collection as template `samples`: relation
values are rewritten to `{ "ref": "slug:index" }` links when the target row
made the same extract (dropped otherwise — a concrete id would dangle in the
destination workspace), `hash`/`file`/computed fields are skipped, and
soft-deleted rows are excluded. `sequence` and `rollup` columns are skipped
too — a document number carried into another workspace would go around its
counter, and a total would arrive contradicting children the extract may not
have taken. Both are re-derived on apply. Adopted collections are never
exported.

The same shape applies elsewhere via `POST /api/admin/templates/apply` with
`{ "template": { … } }` — fields are deep-validated with the same rules as
the collections API. That's the round-trip: model a workspace by hand, extract
it, apply it to the next project (or check the JSON into your repo).

```bash
backlex templates extract > my-template.json
backlex templates apply --file my-template.json   # on another workspace
```

## Cloud auto-seed

On a managed instance the control plane sets the `SEED_TEMPLATE` worker var;
the first user's sign-up auto-applies it (best-effort — a failure never blocks
sign-up). The onboarding card preselects the same template so the user can
confirm or switch.

## Surfaces

Like flows, templates are mirrored across every surface:

| Surface | List | Apply | Apply custom | Clear samples | Extract |
| --- | --- | --- | --- | --- | --- |
| REST | `GET /api/admin/templates` | `POST …/apply {templateId}` | `POST …/apply {template}` | `POST …/clear-samples` | `GET …/extract` |
| SDK | `client.templates.list()` | `.apply(id)` | `.applyCustom(tpl)` | `.clearSamples()` | `.extract()` |
| GraphQL | `templates` (+ `templateSeedStatus` for the catalog meta) | `applyTemplate` | `applyCustomTemplate` | `clearTemplateSamples` | `extractTemplate` |
| MCP | `templates.list` | `templates.apply` | `templates.apply` (`template` arg) | `templates.clearSamples` | `templates.extract` |
| CLI | `backlex templates list` | `apply <id>` | `apply --file <path>` | `clear-samples` | `extract` |

`templates-surfaces.test.ts` is the parity gate.

## Authoring templates

Templates live under `apps/web/src/server/templates/`, one file per vertical:

| File | Holds |
|---|---|
| `defs/<id>.ts` | one vertical's definition — the file name IS the template id |
| `defs/index.ts` | the authoring standard, and the order the picker lists them in |
| `dsl.ts` | the helper DSL (`text`, `rel`, `money`, `select`, …) every def is written in |
| `types.ts` | `SchemaTemplate` and friends — including every bundle shape |
| `kpis.ts` | bundled KPI definitions, keyed by template id |
| `catalog.ts` | the entry point — `TEMPLATES`, `getTemplate`, `templateSummaries` |

Adding a vertical is a new `defs/<id>.ts` plus one line in `defs/index.ts`;
`tests/templates-catalog.test.ts` fails if a definition is inlined into the
index instead, or if a def file outlives the template it named.
Hard constraints:

- **Samples are scalar / single-relation only.** Never seed a JSON array into
  a `json`/`relation_many` field — it trips the Postgres driver. Define the
  column, leave the sample value unset.
- **Computed formulas must be valid on BOTH dialects** (SQLite + Postgres).
- List collections in **dependency order** — relation targets before the
  collections that point at them.
- Give every collection a `group` and declare the header order in the
  template's `groups` — that's what the Collections page and sidebar render
  after apply.
- Keep `id`s stable once shipped (cloud contract), and add the id to the
  `CATEGORY` map so the picker files it under the right section.

### Authoring a bundle

The shapes live in `templates/types.ts` (`TemplateFlow`, `TemplateDocument`,
`TemplateForm`, `TemplateAgent`, `TemplateFlag`, `TemplateChannel`); the rules
`tests/templates-bundles.test.ts` enforces:

- **Flows** may use only self-contained ops (see *Applying* above). Anything
  needing a transport or a renderer must be `active: false`. Every collection
  a step or an `event:` trigger names has to be one the template creates, and a
  `schedule:` trigger's field has to be a real `timestamp` column.
- A flow that delivers a **bundled dashboard** writes
  `dashboardId: "@dashboard:<name>"`. The seeder swaps in the real id after the
  dashboards exist — a dashboard id cannot be known when the catalog is
  written, and that field is otherwise a run-time template over the triggering
  row, which knows nothing about the catalog.
- **Documents** are a complete HTML document (backlex does not wrap them), keys
  unique within the template, and every declared `variables` entry has to be a
  real column somewhere in the template.
- **Forms** must expose form-eligible fields of a collection the template
  creates, and must expose every schema-`required` eligible field — the create
  path refuses a form that omits one, so a drifted template fails loudly.
- **Agents** name real MCP tools. A tool name that does not exist is refused at
  write time and would take the whole apply with it. Agents are never seeded
  open to end users (`appAccess` stays false) — exposure is an operator's
  decision, not a template's.
- Keep the four **WAF signatures** out of any bundled HTML or flow body
  (`/etc/passwd`-style paths, `union select`, `<?php`, `/bin/sh -c`). The cloud
  publish step 403s an object containing one, even inside a comment;
  `scripts/build-worker-template.ts` holds the list.

### Data model

Each vertical mirrors the entity model of the strongest platform in its space
rather than being invented — ecommerce from Shopify / Vendure / Medusa /
BigCommerce, saas from Stripe, crm from Salesforce / HubSpot / SuiteCRM,
support from Zendesk / Chatwoot, hr from Workday / BambooHR / ERPNext HRMS,
projects from Jira / Linear / OpenProject, ats from Greenhouse, lms from Canvas,
inventory and manufacturing from NetSuite / ERPNext, invoicing from Invoice
Ninja, appointments from Cal.com, blog from WordPress / Ghost, nonprofit from
CiviCRM, clinic from FHIR / OpenEMR. The point is that an operator who knows
the category recognizes the model, including the status enums.

Not every reference above was read from a published schema. The ones that were —
and so the ones to trust and re-check first — are Vendure and Medusa entity /
module listings, Shopify's Storefront `QueryRoot`, BigCommerce's GraphQL `site`,
SuiteCRM modules, Zendesk's resource list, Chatwoot models, ERPNext stock +
manufacturing doctypes, frappe/hrms doctypes, OpenProject and Canvas models,
Greenhouse Harvest, Invoice Ninja models, Cal.com's Prisma schema, Ghost models
and CiviCRM core DAOs. The rest are modelled from domain knowledge.

When you extend a vertical, go to the **open-source schema**, not the vendor
doc portal: those are SPA-rendered and mostly return 404s or boilerplate to a
fetcher. `gh api repos/<owner>/<repo>/contents/<models dir>` against the
project's entity/model/doctype directory is the highest-signal source. Note
also that Shopify's and BigCommerce's *Storefront* APIs are buyer-facing read
models — they validate the merchandising shape (products, variants, options,
collections, cart, menus, redirects) but say nothing about the back-office
model, which is where Vendure/Medusa earn their place.

### Form layout

Collections are laid out with the field-organization primitives, not left as a
flat column of inputs. The helpers in `templates/dsl.ts` — `sec`, `half`,
`stacked`, `tabbed`, `divider`, `hint` — wrap `group`, `width`,
`sectionCollapsible` / `sectionCollapsed`, `sectionsAsTabs` and the
presentational `divider` / `notice` field types. The house rules:

| Record size (storage fields) | Container |
|---|---|
| < 10 | flat — one conceptual unit; still pair scalars with `half()` |
| 10–13 | `stacked(...)` section headings |
| ≥ 14 | `tabbed(...)`, one tab per section |

Plus: pair naturally-adjacent scalars (first/last name, price/currency,
start/end date) at `half` width so they share a row and stack on mobile; fold
optional trailing sections (SEO, internal notes, churn) with `{ folded: true }`;
and spend a `hint()` callout only where the form would otherwise mislead — a
generated total, a stock number maintained elsewhere, a record whose reads are
audited.

Two renderer behaviours the rules exist to respect: in tabs mode **every field
must carry a group** (an ungrouped one lands in an implicit "General" tab), and
the tabs branch returns before the collapsible one, so **fold flags are ignored
when `sectionsAsTabs` is set**. `tests/templates-layout.test.ts` enforces all of
this, so a layout that would silently render wrong fails in CI.
