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

export function pickRelationLabel(row: Record<string, unknown>): string | null {
  for (const k of LABEL_FIELDS) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export type LabelFn = (row: Record<string, unknown>) => string | null;

/** Build a row-labeller: prefer the collection's display template (rendered
 *  against the — optionally expanded — row), falling back to the heuristic
 *  field scan when there's no template or it renders empty. */
export function makeLabelFor(displayTemplate: string | null): LabelFn {
  if (!displayTemplate) return pickRelationLabel;
  return (row) => {
    const rendered = renderTemplate(displayTemplate, row).trim();
    return rendered || pickRelationLabel(row);
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
  opts: { displayTemplate?: string | null; fields?: LabelSchemaField[] } = {},
): string {
  if (opts.displayTemplate) {
    const rendered = renderTemplate(opts.displayTemplate, row).trim();
    if (rendered) return rendered;
  }
  const scanned = pickRelationLabel(row);
  if (scanned) return scanned;
  // Compose from the first two filled text fields ("Jordan · Reed",
  // "1 Market St · San Francisco") before surrendering to the id.
  const texts: string[] = [];
  for (const f of opts.fields ?? []) {
    if (f.system || (f.type !== "text" && f.type !== "longtext")) continue;
    const v = row[f.name];
    if (typeof v === "string" && v.trim()) {
      texts.push(v.trim());
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
