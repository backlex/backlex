---
title: Schema templates
description: Ready-made vertical collection sets — grouped collections, realistic sample data, and bundled roles/dashboards — applied into a workspace in one click, plus extract/apply-custom for turning any workspace into a reusable template. Reachable over REST, the SDK, GraphQL, MCP, and the CLI.
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
stable. Definitions live in `apps/web/src/server/templates/catalog.ts`.

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

The result reports what actually happened:

```json
{ "data": { "templateId": "ecommerce", "created": ["products", "…"],
            "skipped": [], "seeded": 24, "roles": ["Store staff"],
            "dashboards": ["Store overview"] } }
```

**Safety rails:** apply never drops or alters existing columns (the schema
applier is additive-only), never touches rows it didn't create, and there is
no rollback — a mid-apply failure leaves already-created collections in place
and a re-apply converges the rest.

## Removing sample data

`POST /api/admin/templates/clear-samples` deletes every row recorded in the
seed manifest (an `app_settings` key mapping collection slug → seeded row
ids), then clears the manifest. Rows the admin created — or seeded rows they
already deleted — are untouched, and a collection slug rename moves its
manifest entry along. The admin UI surfaces this as a callout on the
Collections page while `sampleSeeds > 0`.

Clearing is a **bulk admin operation**: it deletes rows directly (plus their
FTS index entries) and does not fire per-item delete side effects — no
webhooks, flows or realtime events.

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

Add `?samples=N` (1–50, matching the apply-side per-collection cap) to also
export the first N rows of each collection as template `samples`: relation
values are rewritten to `{ "ref": "slug:index" }` links when the target row
made the same extract (dropped otherwise — a concrete id would dangle in the
destination workspace), `hash`/`file`/computed fields are skipped, and
soft-deleted rows are excluded. Adopted collections are never exported.

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

Templates live in `apps/web/src/server/templates/catalog.ts`, built from a
small helper DSL (`text`, `rel`, `money`, `select`, …). Hard constraints:

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

### Data model

Each vertical mirrors the entity model of the strongest platform in its space,
taken from that platform's published API surface or its open-source schema
rather than invented — ecommerce from Shopify / Vendure / Medusa, saas from
Stripe, crm from Salesforce / HubSpot / SuiteCRM, support from Zendesk /
Chatwoot, hr from Workday / BambooHR / ERPNext HRMS, projects from Jira /
Linear / OpenProject, ats from Greenhouse, lms from Canvas, inventory and
manufacturing from NetSuite / ERPNext, invoicing from Invoice Ninja,
appointments from Cal.com, blog from WordPress / Ghost, nonprofit from CiviCRM,
clinic from FHIR / OpenEMR. When you extend a vertical, check the reference
first: the point is that an operator who knows the category recognizes the
model, including the status enums.

### Form layout

Collections are laid out with the field-organization primitives, not left as a
flat column of inputs. The helpers at the top of `catalog.ts` — `sec`, `half`,
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
