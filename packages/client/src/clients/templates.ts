import type { ClientCore } from "../core";

/** One collection inside a schema template (preview shape). */
export interface TemplateCollectionSummary {
  slug: string;
  label: string;
  fieldCount: number;
  /** Admin group this collection lands under on apply (null = ungrouped). */
  group: string | null;
}

/** A schema-template catalog entry — a ready-made vertical collection set. */
export interface TemplateSummary {
  id: string;
  label: string;
  description: string;
  category: string;
  recommended: boolean;
  /** Total example rows seeded on apply across the template's collections. */
  sampleRows: number;
  /** Admin group headers seeded by this template, in order. */
  groups: string[];
  /** Bundled role names seeded on apply. */
  roles: string[];
  /** Bundled insights-dashboard names seeded on apply. */
  dashboards: string[];
  /** How much of a working application arrives with the collections. */
  bundles: TemplateBundleCounts;
  collections: TemplateCollectionSummary[];
}

/** Counts of the non-collection artifacts a template seeds. Counts rather than
 *  names — the names live on the pages the things land on. */
export interface TemplateBundleCounts {
  kpis: number;
  flows: number;
  documents: number;
  forms: number;
  agents: number;
  flags: number;
  channels: number;
}

/** Catalog response from `GET /api/admin/templates`. */
export interface TemplateCatalog {
  data: TemplateSummary[];
  /** Cloud-preselected default (`SEED_TEMPLATE`), or `"blank"`. */
  defaultTemplateId: string;
  /** Whether the workspace already has managed collections. */
  hasCollections: boolean;
  /** Sample rows still recorded in the seed manifest — drives the
   *  "Remove sample data" affordance. */
  sampleSeeds: number;
}

/** Result of applying a template. Idempotent — `skipped` are collections that
 *  already existed; `seeded` counts sample rows inserted; `roles`/`dashboards`/
 *  `kpis` are bundled artifacts created by this apply. */
export interface ApplyTemplateResult {
  templateId: string;
  created: string[];
  skipped: string[];
  seeded: number;
  roles: string[];
  dashboards: string[];
  /** Slugs of bundled KPI definitions installed by this apply. Skipped per
   *  slug, so a re-apply keeps a definition an admin has tuned. */
  kpis: string[];
  /** Names of bundled automation flows created by this apply. */
  flows: string[];
  /** Keys of bundled PDF document templates created by this apply. */
  documents: string[];
  /** NAMES of bundled public forms created by this apply. The one-time token
   *  is deliberately never returned — rotate the form to obtain a link. */
  forms: string[];
  /** Names of bundled AI agents created by this apply. */
  agents: string[];
  /** Keys of bundled feature flags created by this apply. */
  flags: string[];
  /** Patterns of bundled broadcast channels created by this apply. */
  channels: string[];
}

/** Result of `templates.clearSamples()`. */
export interface ClearTemplateSamplesResult {
  /** Sample rows actually deleted. */
  removed: number;
  /** Collections that had seeded rows removed. */
  collections: string[];
}

/** A collection definition inside a custom/extracted template. */
export interface TemplateCollectionDef {
  slug: string;
  singular?: string;
  plural?: string;
  note?: string;
  /** Row-title format hint for the admin UI. */
  displayTemplate?: string;
  /** Admin icon key. */
  icon?: string;
  /** Admin accent color — preset token or `#rrggbb`. */
  color?: string;
  /** Hidden from the admin sidebar/index (presentational only). */
  hidden?: boolean;
  /** Preview-URL template with `{{field}}` placeholders. */
  previewUrl?: string;
  ownerScoped?: boolean;
  versioned?: boolean;
  vectorize?: boolean;
  /** Embedding model override. */
  vectorizeModel?: string;
  fts?: boolean;
  defaultSort?: string;
  /** Admin group header this collection lands under. */
  group?: string;
  /** Explicit position within the group (extract emits it; the array itself
   *  is dependency-ordered, not display-ordered). */
  sortOrder?: number;
  fields: Record<string, unknown>[];
  samples?: Record<string, unknown>[];
}

/** A workspace schema in template format — returned by `templates.extract()`
 *  and accepted by `templates.applyCustom()`. */
export interface ExtractedTemplate {
  label: string;
  description: string;
  /** Ordered admin group headers. */
  groups: string[];
  /** Collections in dependency order (relation targets first). */
  collections: TemplateCollectionDef[];
}

/** Schema templates (admin-scoped). Mirrors `/api/admin/templates`. */
export interface TemplatesClient {
  /** List the template catalog for the active workspace. */
  list(): Promise<TemplateCatalog>;
  /** Seed a template's collections (grouped, with sample data and any bundled
   *  roles/dashboards) into the active workspace. Idempotent — existing
   *  collections are skipped. */
  apply(templateId: string): Promise<{ data: ApplyTemplateResult }>;
  /** Apply a custom template (the `extract()` shape) — same idempotent
   *  semantics as `apply`. */
  applyCustom(template: ExtractedTemplate): Promise<{ data: ApplyTemplateResult }>;
  /** Delete every sample row a template apply seeded; user-created rows are
   *  never touched. */
  clearSamples(): Promise<{ data: ClearTemplateSamplesResult }>;
  /** Export the workspace's managed collections as a reusable template
   *  (schema + admin groups; no sample data). */
  extract(opts?: {
    collections?: string[];
    /** Also export the first N rows per collection (1–50) as template samples. */
    samples?: number;
  }): Promise<{ data: ExtractedTemplate }>;
}

export const makeTemplates = (core: ClientCore): TemplatesClient => {
  // Schema templates. Admin-scoped catalog + apply/extract over
  // `/api/admin/templates`; `apply`/`applyCustom` are idempotent and seed
  // groups, sample data and bundled roles/dashboards for new collections.
  const templates: TemplatesClient = {
    /** List the template catalog for the active workspace. */
    list: () => core.request<TemplateCatalog>("GET", "/api/admin/templates"),
    /** Seed a template's collections (and sample data) into the workspace. */
    apply: (templateId: string) =>
      core.request<{ data: ApplyTemplateResult }>("POST", "/api/admin/templates/apply", {
        templateId,
      }),
    /** Apply a custom template (the `extract()` shape). */
    applyCustom: (template: ExtractedTemplate) =>
      core.request<{ data: ApplyTemplateResult }>("POST", "/api/admin/templates/apply", {
        template,
      }),
    /** Remove every template-seeded sample row (seed-manifest scoped). */
    clearSamples: () =>
      core.request<{ data: ClearTemplateSamplesResult }>(
        "POST",
        "/api/admin/templates/clear-samples",
        {},
      ),
    /** Export the workspace schema as a reusable template. */
    extract: (opts?: { collections?: string[]; samples?: number }) =>
      core.request<{ data: ExtractedTemplate }>(
        "GET",
        (() => {
          const params = new URLSearchParams();
          if (opts?.collections?.length)
            params.set("collections", opts.collections.join(","));
          if (opts?.samples != null) params.set("samples", String(opts.samples));
          const qs = params.size ? `?${params.toString()}` : "";
          return `/api/admin/templates/extract${qs}`;
        })(),
      ),
  };

  return templates;
};
