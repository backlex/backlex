import { BASE_TEMPLATES } from "./defs";
import { TEMPLATE_KPIS } from "./kpis";
import type { SchemaTemplate } from "./types";

/**
 * The schema-template catalog as the rest of the server sees it.
 *
 * This file is the entry point only. The definitions live one per vertical in
 * `defs/`, the authoring DSL they are written in lives in `dsl.ts`, and the
 * shapes both share live in `types.ts` — see `defs/index.ts` for the standard
 * each template is authored to.
 */
export type {
  SampleRef,
  SampleRow,
  SampleValue,
  SchemaTemplate,
  TemplateAgent,
  TemplateChannel,
  TemplateCollection,
  TemplateDashboard,
  TemplateDocument,
  TemplateFlag,
  TemplateFlow,
  TemplateForm,
  TemplateKpi,
  TemplatePanel,
  TemplatePermission,
  TemplateRole,
} from "./types";

/**
 * The catalog, with each vertical's bundled KPI definitions attached.
 *
 * Attached here rather than inlined per template so `TEMPLATE_KPIS` can be
 * read (and tested) as one table — a KPI naming a column that does not exist
 * is not a type error, so the catalog test walks every definition against its
 * template's own field list.
 */
export const TEMPLATES: SchemaTemplate[] = BASE_TEMPLATES.map((t) => {
  const kpis = TEMPLATE_KPIS[t.id];
  return kpis && kpis.length > 0 ? { ...t, kpis } : t;
});

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

export const getTemplate = (id: string): SchemaTemplate | undefined =>
  TEMPLATES.find((t) => t.id === id);

/** Picker grouping. Keep ids stable; new templates just need a row here (they
 *  fall back to "Other" if missing). */
const CATEGORY: Record<string, string> = {
  blank: "General",
  blog: "Content & Marketing",
  forms: "Content & Marketing",
  ecommerce: "Commerce",
  marketplace: "Commerce",
  restaurant: "Commerce",
  crm: "Sales & CRM",
  saas: "Sales & CRM",
  hr: "People & HR",
  ats: "People & HR",
  inventory: "Operations",
  support: "Operations",
  projects: "Operations",
  invoicing: "Finance",
  appointments: "Operations",
  "field-service": "Operations",
  rental: "Commerce",
  fleet: "Operations",
  maintenance: "Operations",
  manufacturing: "Operations",
  "real-estate": "Industry",
  lms: "Industry",
  nonprofit: "Industry",
  events: "Industry",
  fitness: "Industry",
  legal: "Industry",
  clinic: "Industry",
};

/** Popular starters surfaced with a "Recommended" badge in the picker. */
const RECOMMENDED = new Set(["blog", "ecommerce", "crm"]);

/** Lightweight catalog for pickers/previews (no full field defs). */
export const templateSummaries = () =>
  TEMPLATES.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    category: CATEGORY[t.id] ?? "Other",
    recommended: RECOMMENDED.has(t.id),
    sampleRows: t.collections.reduce((n, c) => n + (c.samples?.length ?? 0), 0),
    /** Admin group headers seeded by this template, in order. */
    groups: t.groups ?? [],
    /** Bundled role names seeded on apply. */
    roles: (t.roles ?? []).map((r) => r.name),
    /** Bundled dashboard names seeded on apply. */
    dashboards: (t.dashboards ?? []).map((d) => d.name),
    /**
     * What else arrives with the collections, as counts.
     *
     * Counts rather than names: the picker's job is to say how much of a
     * working application this is, and six more comma-separated lists in a
     * preview pane is a wall nobody reads. The names are on the pages the
     * things land on.
     */
    bundles: {
      kpis: (t.kpis ?? []).length,
      flows: (t.flows ?? []).length,
      documents: (t.documents ?? []).length,
      forms: (t.forms ?? []).length,
      agents: (t.agents ?? []).length,
      flags: (t.flags ?? []).length,
      channels: (t.channels ?? []).length,
    },
    collections: t.collections.map((c) => ({
      slug: c.slug,
      label: c.plural ?? c.slug,
      fieldCount: c.fields.length,
      /** Admin group this collection lands under (null = ungrouped). */
      group: c.group ?? null,
    })),
  }));
