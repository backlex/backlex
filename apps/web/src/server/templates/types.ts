import type { ChannelAccess, Operation } from "@backlex/core";
import type { FieldDef } from "@backlex/db";

/**
 * The shape of a schema template — what `defs/` authors and what
 * `services/templates.ts` applies.
 *
 * Split out of `catalog.ts` so the definitions, the DSL that builds them and
 * the KPI table can all name these types without importing each other in a
 * circle (`kpis.ts` used to reach back into `catalog.ts` for `TemplateKpi`
 * while `catalog.ts` imported `TEMPLATE_KPIS` from it).
 */
export interface TemplateCollection {
  slug: string;
  singular?: string;
  plural?: string;
  note?: string;
  /** Row-title format hint for the admin UI (extract/apply-custom fidelity —
   *  catalog templates leave it to the engine's defaults). */
  displayTemplate?: string;
  /** Admin icon key (extract/apply-custom fidelity). */
  icon?: string;
  /** Admin accent color — preset token or `#rrggbb` (extract/apply-custom fidelity). */
  color?: string;
  /** Hidden from the admin sidebar/index (extract/apply-custom fidelity). */
  hidden?: boolean;
  /**
   * The field the admin's Kanban board groups this collection's rows by — a
   * dropdown field's name, or `_status` on a versioned collection.
   *
   * The column and the admin view both shipped; what was missing is any
   * template saying which field a board is *about*. Left null the admin
   * auto-detects (a field literally named `status`, else the first dropdown),
   * which is right often enough to look deliberate and wrong exactly where it
   * matters: a deal is grouped by `stage`, an issue by `state`, and an order
   * has both a payment `status` and a `fulfillment_status`, only one of which
   * anybody arranges a board around.
   */
  kanbanGroupBy?: string;
  /** Maps a Kanban column VALUE to a draft/publish action (`publish` |
   *  `unpublish` | `archive`) — a `done` column that also publishes. Only
   *  meaningful on a `versioned` collection grouped by a user dropdown. */
  kanbanActionMap?: Record<string, string>;
  /** Edits to a published row are staged until re-published (versioned only). */
  stagedEdits?: boolean;
  /** Preview-URL template with `{{field}}` placeholders (extract/apply-custom fidelity). */
  previewUrl?: string;
  ownerScoped?: boolean;
  versioned?: boolean;
  vectorize?: boolean;
  /** Embedding model override (extract/apply-custom fidelity). */
  vectorizeModel?: string;
  /** Enable keyword full-text search — pairs with `searchable` fields. */
  fts?: boolean;
  defaultSort?: string;
  /** Collection-level admin group: the section header this collection lands
   *  under on the Collections page + sidebar tree. NOT the same thing as the
   *  per-field `group` (which sections the item FORM) — this one organizes the
   *  collection LIST. Header order lives in `SchemaTemplate.groups`. */
  group?: string;
  /** Explicit position within the group. Catalog templates omit it (derived
   *  from listing order); extract emits it so the round-trip preserves the
   *  admin's arrangement even though the array is dependency-ordered. */
  sortOrder?: number;
  /** Single-row collection (extract/apply-custom fidelity). */
  singleton?: boolean;
  /** Soft delete — rows get a `deleted_at` column instead of hard deletes. */
  softDelete?: boolean;
  /** Audit reads of this collection (extract/apply-custom fidelity). */
  auditReads?: boolean;
  fields: FieldDef[];
  /** Realistic example rows seeded on apply (only when the collection is newly
   *  created). Relation values use `{ ref: "slug:index" }`. */
  samples?: SampleRow[];
  /** Portal auto-link rule seeded into the workspace's `portalLinks` setting
   *  on apply (idempotent per collection): an app-plane signup whose email
   *  matches `emailField` on an unlinked row of this collection gets its
   *  `app_user_id` stamped and `role` (a bundled self-service role, by name)
   *  auto-assigned. Only meaningful on collections with a `userLink()` field. */
  portalLink?: { emailField: string; role: string };
}

/** A role (+ its permission grants) seeded alongside the collections. Skipped
 *  wholesale when a role with the same name already exists in the workspace. */
export interface TemplateRole {
  name: string;
  description?: string;
  permissions: TemplatePermission[];
}

export interface TemplatePermission {
  collection: string;
  action: "read" | "create" | "update" | "delete" | "publish";
  /** Field allow-list (omit = all fields). */
  fields?: string[];
  /** Permission-DSL condition (same shape the permissions API accepts). */
  condition?: unknown;
}

/** An insights dashboard (+ its panels) seeded alongside the collections.
 *  Skipped wholesale when a dashboard with the same name already exists.
 *  Panels stick to `items-aggregate`/`static` — never raw SQL — so seeding is
 *  safe on every runtime. */
export interface TemplateDashboard {
  name: string;
  description?: string;
  panels: TemplatePanel[];
}

export interface TemplatePanel {
  name: string;
  description?: string;
  kind: "items-aggregate" | "static";
  viz:
    | "sparkline"
    | "line"
    | "area"
    | "bars"
    | "stacked-bars"
    | "donut"
    | "pie"
    | "radar"
    | "radial"
    | "counter"
    | "table";
  config: Record<string, unknown>;
  layout?: { x: number; y: number; w: number; h: number };
}

/**
 * A named KPI seeded alongside the collections — the workspace's agreed
 * formula for one figure. Skipped when a KPI with the same slug already
 * exists, so a re-apply never overwrites a definition an admin has tuned.
 *
 * These are why a freshly-applied template can answer "how is it going?"
 * instead of only offering the tools to find out. Every surface — the KPIs
 * page, a dashboard tile, Ask AI, a report — reads the seeded definition, so
 * the vertical's vocabulary ("net revenue", "refund rate") means one thing
 * from the moment the template lands.
 */
export interface TemplateKpi {
  slug: string;
  name: string;
  description?: string;
  collection: string;
  agg: "count" | "sum" | "avg" | "min" | "max";
  field?: string;
  /** Permission-DSL condition narrowing the rows (e.g. only paid orders). */
  filter?: Record<string, unknown>;
  /** Timestamp column the period window applies to. Omit for a running total
   *  — and omit it deliberately: a KPI windowed on the wrong column reports a
   *  change that describes when rows were imported. */
  dateField?: string;
  groupBy?: string;
  topN?: number;
  format?: "number" | "money" | "percent" | "duration";
  unit?: string;
  decimals?: number;
  /** Which way is good news. `down` for refunds and cancellations. */
  direction?: "up" | "down" | "neutral";
  /**
   * Watch this figure and notify the workspace's admins when it goes outside
   * the threshold. `above` / `below` compare the value; `change_above` /
   * `change_below` compare the period-over-period delta, and their
   * {@link alertValue} is a FRACTION (0.2 = 20%).
   *
   * Both halves or neither — a threshold with no operator watches nothing, and
   * an operator with no threshold has nothing to compare against.
   */
  alertOperator?: "above" | "below" | "change_above" | "change_below";
  alertValue?: number;
  /** The collection whose ITEM PAGE this figure belongs on — not the one it
   *  aggregates. "Revenue per customer" sums invoices and belongs on a
   *  customer. Needs {@link pinField} with it. */
  pinTo?: string;
  /** The relation column on the KPI's OWN collection pointing back at the
   *  pinned row, so the server never guesses which relation the pin meant. */
  pinField?: string;
}

/**
 * A bundled automation flow.
 *
 * This is the piece that turns a seeded schema into something that *runs*: a
 * template used to hand over the tables an order lives in and leave "when it is
 * paid, take the stock down and tell somebody" to be written from scratch, in
 * every workspace, by whoever got there first.
 *
 * Two rules the catalog test enforces, both learned from what a demo workspace
 * can actually do:
 *
 * - **Only self-contained operations.** `webhook` / `request` / `integration*`
 *   / `payment.*` all address something outside the workspace, so a bundled
 *   flow using one fails on every run until an admin edits it — a broken flow
 *   that arrived broken teaches people the feature is broken.
 * - **`active: false` when the flow needs configuration.** `email`, `sms`,
 *   `document.render` and `report.deliver` depend on a transport or a PDF
 *   renderer this deployment may not have. Those ship switched off, with a
 *   name that says what to turn on, rather than filling the runs list with
 *   failures nobody asked for.
 *
 * `report.deliver`'s `dashboardId` may be written as `@dashboard:<name>`
 * naming a dashboard THIS template bundles; the seeder resolves it to the real
 * id after the dashboards are created. A dashboard id cannot be known when the
 * catalog is written, and the field is otherwise a run-time template over the
 * triggering row — which resolves against `data`, not against the catalog.
 */
export interface TemplateFlow {
  name: string;
  /** `event:items:<slug>:<created|updated|deleted>` · `cron:<5-field>` ·
   *  `schedule:<json spec>` · `manual:` — see docs/flows.md. */
  trigger: string;
  operations: Operation[];
  /** Default `true`. See the note above for when to ship one switched off. */
  active?: boolean;
}

/** A bundled PDF document template — a COMPLETE html document (backlex does
 *  not wrap it), interpolated with the same `{{ data.* }}` engine as email. */
export interface TemplateDocument {
  /** Stable key a `document.render` op names. Unique within the template. */
  key: string;
  name: string;
  description?: string;
  bodyHtml: string;
  /** Running header / footer, drawn on every page. Chromium's `pageNumber` /
   *  `totalPages` spans work. */
  headerHtml?: string;
  footerHtml?: string;
  pageOptions?: Record<string, unknown>;
  /** Suggested output name, templated (`invoice-{{ data.number }}`). */
  filename?: string;
  /** Names the render refuses to run without. */
  variables?: string[];
}

/**
 * A bundled public form — a link an outsider fills in that lands as a row.
 *
 * The seeded form gets a fresh token whose PLAINTEXT IS DISCARDED: only the
 * hash is stored, and there is no reveal path (by design — a form link that
 * could be read back out of the API is a form link that leaks). The admin
 * presses "Rotate token" to get a shareable URL. Said out loud in docs, because
 * a seeded form whose link nobody can find reads as a bug.
 */
export interface TemplateForm {
  name: string;
  /** Target collection slug — must be one this template creates. */
  collection: string;
  /** Ordered exposed fields. Every one must be form-eligible on that
   *  collection (scalar, not computed/private/localized/server-issued). */
  fields: Array<{ name: string; label?: string; help?: string }>;
  /** Submit label, success message/redirect, turnstile, schedule, caps. */
  settings?: Record<string, unknown>;
  active?: boolean;
}

/** A bundled AI agent — an operator-authored assistant over this vertical's
 *  own data. The definition seeds with no credential; running a turn needs the
 *  deployment's model access, so an agent without one simply sits there. */
export interface TemplateAgent {
  name: string;
  /** `@`-mention token. Derived from the name when omitted. */
  handle?: string;
  description?: string;
  systemPrompt: string;
  /** MCP tool names — every one validated against the real registry by the
   *  catalog test, because a tool name that does not exist is refused at write
   *  time and would fail the whole apply. */
  tools: string[];
  model?: string;
  maxSteps?: number;
  memory?: boolean;
  active?: boolean;
}

/** A bundled feature flag / remote-config entry. */
export interface TemplateFlag {
  key: string;
  enabled?: boolean;
  /** Remote-config payload returned while the flag is on. */
  value?: unknown;
  /** `{ condition?, rollout? }` — who gets it. */
  rules?: Record<string, unknown>;
  description?: string;
}

/** A bundled broadcast channel — an application-owned pub/sub topic with its
 *  own subscribe/publish gates. Pure permission config; nothing external. */
export interface TemplateChannel {
  name: string;
  /** Colon-segmented, `{capture}` / `*` / `**`. Unique within the workspace. */
  pattern: string;
  subscribe: ChannelAccess;
  publish: ChannelAccess;
  presence?: boolean;
  replay?: boolean;
  retentionHours?: number;
}

/*
 * Deliberately NOT here: a bundled booking resource.
 *
 * Seeding one provisions the `booking_records` collection automatically
 * (`services/booking-collection.ts`), and the three verticals a booking page
 * would suit — appointments, clinic, fitness — already ship their own
 * `bookings` / `appointments` collection modelling the same thing. A workspace
 * would open to two records of one appointment, which is confusion rather than
 * capability. A workspace that wants the public booking page creates a
 * resource; the template does not decide that for them.
 *
 * Same reasoning, different cause, for outbound webhooks, integrations,
 * payment providers, sync hooks and approval requests — see docs/templates.md.
 */

export interface SchemaTemplate {
  id: string;
  label: string;
  description: string;
  /** Ordered group-header names, merged into the workspace's `collectionGroups`
   *  setting on apply (missing headers appended after the existing ones).
   *  Falls back to first-appearance order of `collections[].group`. */
  groups?: string[];
  collections: TemplateCollection[];
  /** Optional bundled roles — see {@link TemplateRole}. */
  roles?: TemplateRole[];
  /** Optional bundled insights dashboards — see {@link TemplateDashboard}. */
  dashboards?: TemplateDashboard[];
  /** Optional bundled KPI definitions — see {@link TemplateKpi}. */
  kpis?: TemplateKpi[];
  /** Optional bundled automation flows — see {@link TemplateFlow}. */
  flows?: TemplateFlow[];
  /** Optional bundled PDF document templates — see {@link TemplateDocument}. */
  documents?: TemplateDocument[];
  /** Optional bundled public forms — see {@link TemplateForm}. */
  forms?: TemplateForm[];
  /** Optional bundled AI agents — see {@link TemplateAgent}. */
  agents?: TemplateAgent[];
  /** Optional bundled feature flags — see {@link TemplateFlag}. */
  flags?: TemplateFlag[];
  /** Optional bundled broadcast channels — see {@link TemplateChannel}. */
  channels?: TemplateChannel[];
}

/**
 * A reference to another seeded sample row, resolved at apply time to the real
 * inserted id. `ref` is `"<collectionSlug>:<sampleIndex>"` (0-based, in the
 * order the samples are listed). Used for relation / relation_many sample
 * values so demo data is relationally consistent. An unresolved ref (e.g. the
 * target collection already existed and was skipped) degrades to `null`.
 */
export interface SampleRef {
  ref: string;
}

export type SampleValue = unknown | SampleRef | SampleRef[];
export type SampleRow = Record<string, SampleValue>;
