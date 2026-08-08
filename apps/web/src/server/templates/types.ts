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
}

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
