// Shared "how does this row show up as a human label" logic. One resolution
// chain for every surface (table identity column, Kanban/Gallery/Calendar
// cards, relation pickers, relation list-columns):
//
//   display template → title-ish field scan → first two filled text fields →
//   shortened id.
//
// A full UUID is never a label — collections without any readable field get a
// composed value ("Jordan · Reed") or the 8-char id at worst.
import { renderTemplate } from "@backlex/core";

const LABEL_FIELDS = ["title", "name", "label", "slug", "subject", "email", "username"];

/** Coerce a value to a display string. Handles a `localized` field's
 *  `{locale: value}` map — prefers the workspace default language (`prefer`),
 *  then English, then the first filled locale — so a localized title never
 *  surfaces as "[object Object]" or falls through to the short id. Returns null
 *  when there's nothing renderable. */
const asLabel = (v: unknown, prefer?: string): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const m = v as Record<string, unknown>;
    const pick =
      (prefer ? m[prefer] : undefined) ??
      m.en ??
      Object.values(m).find((x) => typeof x === "string" && x.trim());
    return typeof pick === "string" && pick.trim() ? pick.trim() : null;
  }
  return null;
};

export function pickRelationLabel(row: Record<string, unknown>, prefer?: string): string | null {
  for (const k of LABEL_FIELDS) {
    const s = asLabel(row[k], prefer);
    if (s) return s;
  }
  return null;
}

export type LabelFn = (row: Record<string, unknown>) => string | null;

/** Build a row-labeller: prefer the collection's display template (rendered
 *  against the — optionally expanded — row), falling back to the heuristic
 *  field scan when there's no template or it renders empty. */
export function makeLabelFor(displayTemplate: string | null, defaultLocale?: string): LabelFn {
  if (!displayTemplate) return (row) => pickRelationLabel(row, defaultLocale);
  return (row) => {
    const rendered = renderTemplate(displayTemplate, row).trim();
    return rendered || pickRelationLabel(row, defaultLocale);
  };
}

export function shortId(v: unknown): string {
  const s = String(v ?? "");
  return s.length > 10 ? s.slice(0, 8) + "…" : s;
}

export interface LabelSchemaField {
  name: string;
  type?: string;
  system?: boolean;
}

/** Full resolution chain — see the module docstring. `fields` powers the
 *  composed-text fallback; omit it to stop at the title-ish scan. */
export function rowLabel(
  row: Record<string, unknown>,
  opts: {
    displayTemplate?: string | null;
    fields?: LabelSchemaField[];
    /** Workspace content default language — localized maps collapse to it. */
    defaultLocale?: string;
  } = {},
): string {
  if (opts.displayTemplate) {
    const rendered = renderTemplate(opts.displayTemplate, row).trim();
    if (rendered) return rendered;
  }
  const scanned = pickRelationLabel(row, opts.defaultLocale);
  if (scanned) return scanned;
  // Compose from the first two filled text fields ("Jordan · Reed",
  // "1 Market St · San Francisco") before surrendering to the id.
  const texts: string[] = [];
  for (const f of opts.fields ?? []) {
    if (f.system || (f.type !== "text" && f.type !== "longtext")) continue;
    const s = asLabel(row[f.name], opts.defaultLocale);
    if (s) {
      texts.push(s);
      if (texts.length === 2) break;
    }
  }
  if (texts.length) return texts.join(" · ");
  return shortId(row.id);
}

/** True when the collection has neither a display template nor a title-ish
 *  field — i.e. row labels are running on the composed/short-id fallback and
 *  the admin should really define a display template. */
export function needsDisplayTemplate(schema?: {
  displayTemplate?: string | null;
  fields?: LabelSchemaField[];
} | null): boolean {
  if (!schema) return false;
  if (schema.displayTemplate?.trim()) return false;
  return !(schema.fields ?? []).some(
    (f) => !f.system && (f.name === "title" || f.name === "name"),
  );
}
