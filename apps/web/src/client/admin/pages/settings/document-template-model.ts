/**
 * The document-templates page's logic, without the chrome — the email-template
 * model's twin, and deliberately built from its parts.
 *
 * A document template is resolved exactly like an email template (a workspace
 * row shadows the instance-wide one under the same key), so the list, the
 * statuses, the unsaved-changes baseline and the variable warnings answer the
 * same questions. What is different is only what a document IS: no subject or
 * sender, a running header and footer, and a page size instead of a device.
 * Everything generic — sample data, placeholder insertion, appearance
 * comparison — is imported from the email model rather than restated.
 */
import { templatePathValue } from "@backlex/core";
import type { Appearance } from "@backlex/core/appearance";
import { templateVariableRefs } from "@backlex/core/email-templates";
import type { ApiDocumentTemplate } from "../../api";
import { isThemePath, sameAppearance, setPath, type VariableWarning } from "./email-template-model";

export interface DocEntry {
  /** List identity — the row id, or a `new:` id while unsaved. */
  id: string;
  key: string;
  row: ApiDocumentTemplate | null;
  isNew?: boolean;
}

export type DocStatus =
  /** The workspace's own copy of an instance-wide default. */
  | "customized"
  /** The instance-wide default, not overridden here. */
  | "shared"
  /** A template this workspace wrote. */
  | "custom"
  | "new";

export const docStatus = (e: DocEntry): DocStatus => {
  if (e.isNew || !e.row) return "new";
  if (e.row.inherited) return "shared";
  if (e.row.overridesDefault) return "customized";
  return "custom";
};

/** One entry per key, by key. The server already returns one row per key. */
export const buildDocEntries = (rows: ApiDocumentTemplate[]): DocEntry[] =>
  [...rows]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((row) => ({ id: row.id, key: row.key, row }));

/** Replace the row holding `row.key`, or add it. */
export const upsertDocRow = (rows: ApiDocumentTemplate[], row: ApiDocumentTemplate): ApiDocumentTemplate[] =>
  rows.some((r) => r.key === row.key) ? rows.map((r) => (r.key === row.key ? row : r)) : [...rows, row];

export const PAGE_FORMATS = ["A4", "Letter", "Legal", "A3", "A5"] as const;
export type PageFormat = (typeof PAGE_FORMATS)[number];
export const isPageFormat = (v: string): v is PageFormat => (PAGE_FORMATS as readonly string[]).includes(v);

export interface DocDraft {
  name: string;
  key: string;
  bodyHtml: string;
  headerHtml: string;
  footerHtml: string;
  filename: string;
  format: PageFormat;
  landscape: boolean;
  appearance: Appearance | null;
}

export const BLANK_DOCUMENT_BODY = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; font-family: {{ theme.font }}; color: {{ theme.text }}; background: {{ theme.bg }}; }
      h1 { color: {{ theme.accent }}; }
    </style>
  </head>
  <body>
    <h1>{{ data.title }}</h1>
  </body>
</html>`;

export const EMPTY_DOC_DRAFT: DocDraft = {
  name: "",
  key: "",
  bodyHtml: BLANK_DOCUMENT_BODY,
  headerHtml: "",
  footerHtml: "",
  filename: "",
  format: "A4",
  landscape: false,
  appearance: null,
};

export const docDraftFor = (e: DocEntry): DocDraft => {
  if (!e.row) return { ...EMPTY_DOC_DRAFT };
  const format = e.row.pageOptions?.format;
  return {
    name: e.row.name ?? "",
    key: e.row.key,
    bodyHtml: e.row.bodyHtml ?? "",
    headerHtml: e.row.headerHtml ?? "",
    footerHtml: e.row.footerHtml ?? "",
    filename: e.row.filename ?? "",
    format: format && isPageFormat(format) ? format : "A4",
    landscape: Boolean(e.row.pageOptions?.landscape),
    appearance: e.row.appearance ?? null,
  };
};

export const sameDocDraft = (a: DocDraft, b: DocDraft): boolean =>
  a.name === b.name &&
  a.key === b.key &&
  a.bodyHtml === b.bodyHtml &&
  a.headerHtml === b.headerHtml &&
  a.footerHtml === b.footerHtml &&
  a.filename === b.filename &&
  a.format === b.format &&
  a.landscape === b.landscape &&
  sameAppearance(a.appearance, b.appearance);

/** Every placeholder the draft uses — body, running header and footer, and the
 *  filename, which are all interpolated. What a save records as `variables`. */
export const docDraftRefs = (d: DocDraft): string[] =>
  templateVariableRefs(d.bodyHtml, d.headerHtml, d.footerHtml, d.filename);

/** The page options a draft saves and renders with. The template's other page
 *  options (margin, printBackground) are kept by the caller — this editor does
 *  not show them, and must not wipe what an API caller set. */
export const docPageOptions = (
  d: DocDraft,
  existing?: ApiDocumentTemplate["pageOptions"] | null,
): ApiDocumentTemplate["pageOptions"] => ({ ...(existing ?? {}), format: d.format, landscape: d.landscape });

// ── keys ─────────────────────────────────────────────────────────────────────

/**
 * The key a NEW template may take. Stricter than the server (which takes any
 * 1–200 characters) on purpose: the key is a path segment on every surface and
 * the name a flow step types, so the editor offers the shape an email-template
 * key has, with room for a longer name. An existing key is never re-checked —
 * the field is read-only once saved.
 */
export const DOCUMENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export type DocKeyProblem = "format" | "taken" | null;

export const docKeyProblem = (key: string, entries: DocEntry[]): DocKeyProblem => {
  if (!DOCUMENT_KEY_PATTERN.test(key)) return "format";
  if (entries.some((e) => e.key === key && e.row && !e.row.inherited)) return "taken";
  return null;
};

/** The shared default a new template saved under `key` would replace. */
export const docEntryReplacedBy = (key: string, entries: DocEntry[]): DocEntry | null =>
  entries.find((e) => e.key === key && e.row?.inherited) ?? null;

export const copyDocKey = (key: string, entries: DocEntry[]): string => {
  const taken = new Set(entries.map((e) => e.key));
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? "_copy" : `_copy_${n}`;
    const candidate = `${key.slice(0, 100 - suffix.length)}${suffix}`;
    if (!taken.has(candidate) && DOCUMENT_KEY_PATTERN.test(candidate)) return candidate;
  }
  return `copy_${Date.now()}`;
};

// ── variables + sample data ──────────────────────────────────────────────────

/** Placeholders the sample data leaves empty. `theme.*` is filled from the
 *  appearance on every render, so it is never reported. */
export const docVariableWarnings = (
  d: DocDraft,
  sample: Record<string, unknown> | null,
): VariableWarning[] => {
  if (!sample) return [];
  return docDraftRefs(d)
    .filter((p) => !isThemePath(p))
    .filter((p) => {
      const { found, value } = templatePathValue(sample, p);
      return !found || value === null || value === undefined || value === "";
    })
    .map((path) => ({ path, reason: "no-sample" }));
};

/** The sample data an editor starts with: the row arrives as `data`, and every
 *  variable the template already uses is named so the author sees what to fill. */
export const seedDocSample = (e: DocEntry, d: DocDraft): Record<string, unknown> => {
  const out: Record<string, unknown> = { data: {} };
  const paths = [...new Set([...(e.row?.variables ?? []), ...docDraftRefs(d)])].filter((p) => !isThemePath(p));
  for (const path of paths) setPath(out, path, "");
  return out;
};

// ── preview ──────────────────────────────────────────────────────────────────

/** Sheet sizes in CSS px at 96 dpi — what Chromium lays a page out at before it
 *  prints, so the preview wraps text where the PDF will. */
const SHEET_PX: Record<PageFormat, { width: number; height: number }> = {
  A4: { width: 794, height: 1123 },
  Letter: { width: 816, height: 1056 },
  Legal: { width: 816, height: 1344 },
  A3: { width: 1123, height: 1587 },
  A5: { width: 559, height: 794 },
};

export const sheetSize = (format: PageFormat, landscape: boolean): { width: number; height: number } => {
  const s = SHEET_PX[format];
  return landscape ? { width: s.height, height: s.width } : s;
};
