/**
 * The email-templates page's logic, without the chrome.
 *
 * Kept apart from the component because each of these is a question with a
 * right answer that a render test is a clumsy way to ask: which entry a key
 * belongs to, what an entry's editor opens with, which placeholders a template
 * uses that nothing will fill. Every variable question is answered through
 * `@backlex/core` — the same lookup `renderTemplate` does and the same catalog
 * the send sites are type-checked against — so the page cannot hold its own
 * opinion about what a variable is.
 */
import { EMAIL_TEMPLATE_KEY_PATTERN, templatePathValue } from "@backlex/core";
import {
  BUILT_IN_EMAIL_KEYS,
  BUILT_IN_EMAIL_TEMPLATES,
  EMAIL_RENDER_CONTEXT_SAMPLES,
  isBuiltInEmailKey,
  templateVariableRefs,
  type BuiltInEmailKey,
  type EmailRenderContexts,
} from "@backlex/core/email-templates";
import type { ApiEmailTemplate } from "../../api";

/** One row of the list: a stored template, a built-in email with no stored
 *  template yet, or an unsaved new one. */
export interface TemplateEntry {
  /** List identity — the row id, or `builtin:<key>` while nothing is stored. */
  id: string;
  key: string;
  /** What the editor opens and saves. Null for a built-in email the workspace
   *  has not customized, and for a new template. */
  row: ApiEmailTemplate | null;
  /** Set when a backlex feature sends under this key. */
  builtIn: BuiltInEmailKey | null;
  isNew?: boolean;
}

export type EntryStatus =
  /** A built-in email with no stored template: backlex sends its own wording. */
  | "builtin"
  /** The workspace's own version of a built-in email or of a shared default. */
  | "customized"
  /** The instance-wide default, not overridden here. */
  | "shared"
  /** A template the workspace wrote for its flows and reports. */
  | "custom"
  | "new";

export const entryStatus = (e: TemplateEntry): EntryStatus => {
  if (e.isNew) return "new";
  if (!e.row) return "builtin";
  if (e.row.inherited) return "shared";
  if (e.builtIn || e.row.overridesDefault) return "customized";
  return "custom";
};

/** Built-in emails first, in catalog order (grouped by feature), then every
 *  other key. The server already returns one row per key. */
export const buildEntries = (rows: ApiEmailTemplate[]): TemplateEntry[] => {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const builtIns = BUILT_IN_EMAIL_KEYS.map((key): TemplateEntry => {
    const row = byKey.get(key) ?? null;
    return { id: row?.id ?? `builtin:${key}`, key, row, builtIn: key };
  });
  const others = rows
    .filter((r) => !isBuiltInEmailKey(r.key))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((row): TemplateEntry => ({ id: row.id, key: row.key, row, builtIn: null }));
  return [...builtIns, ...others];
};

/** Replace the row holding `row.key`, or add it. Keys are unique in the list. */
export const upsertRow = (rows: ApiEmailTemplate[], row: ApiEmailTemplate): ApiEmailTemplate[] =>
  rows.some((r) => r.key === row.key) ? rows.map((r) => (r.key === row.key ? row : r)) : [...rows, row];

export interface Draft {
  name: string;
  key: string;
  subject: string;
  fromAddress: string;
  bodyHtml: string;
  bodyText: string;
}

export const EMPTY_DRAFT: Draft = { name: "", key: "", subject: "", fromAddress: "", bodyHtml: "", bodyText: "" };

/** What the editor opens with. A built-in email nobody customized opens on its
 *  starter, named after the email it replaces. */
export const draftFor = (e: TemplateEntry, builtInName: string): Draft => {
  if (e.row) {
    return {
      name: e.row.name,
      key: e.row.key,
      subject: e.row.subject,
      fromAddress: e.row.fromAddress ?? "",
      bodyHtml: e.row.bodyHtml,
      bodyText: e.row.bodyText ?? "",
    };
  }
  if (e.builtIn) {
    const { starter } = BUILT_IN_EMAIL_TEMPLATES[e.builtIn];
    return { ...EMPTY_DRAFT, name: builtInName, key: e.key, subject: starter.subject, bodyHtml: starter.bodyHtml };
  }
  return { ...EMPTY_DRAFT };
};

export const sameDraft = (a: Draft, b: Draft): boolean =>
  a.name === b.name &&
  a.key === b.key &&
  a.subject === b.subject &&
  a.fromAddress === b.fromAddress &&
  a.bodyHtml === b.bodyHtml &&
  a.bodyText === b.bodyText;

/** Every placeholder the draft uses — what a save records as `variables`. */
export const draftRefs = (d: Draft): string[] => templateVariableRefs(d.subject, d.bodyHtml, d.bodyText);

// ── keys ─────────────────────────────────────────────────────────────────────

export type KeyProblem = "format" | "taken" | null;

/** The server's two rules, in the order it applies them: the shared key pattern
 *  (422), then the (workspace, key) unique index (409). A key that only a
 *  built-in email or a shared default holds is not taken — saving under it is
 *  how that email gets customized. */
export const keyProblem = (key: string, entries: TemplateEntry[]): KeyProblem => {
  if (!EMAIL_TEMPLATE_KEY_PATTERN.test(key)) return "format";
  if (entries.some((e) => e.key === key && e.row && !e.row.inherited)) return "taken";
  return null;
};

/** The entry a new template saved under `key` would replace, if any. */
export const entryReplacedBy = (key: string, entries: TemplateEntry[]): TemplateEntry | null =>
  entries.find((e) => e.key === key && (!e.row || e.row.inherited)) ?? null;

/** A key for a copy that collides with nothing in the list and still fits. */
export const copyKey = (key: string, entries: TemplateEntry[]): string => {
  const taken = new Set(entries.map((e) => e.key));
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? "_copy" : `_copy_${n}`;
    const candidate = `${key.slice(0, 40 - suffix.length)}${suffix}`;
    if (!taken.has(candidate) && EMAIL_TEMPLATE_KEY_PATTERN.test(candidate)) return candidate;
  }
  return `copy_${Date.now()}`;
};

// ── variables ────────────────────────────────────────────────────────────────

export type RenderContext = keyof EmailRenderContexts;

/** Where a custom template's caller-provided variables come from. */
export const contextOf = (path: string): RenderContext | null => {
  const root = path.split(".")[0]!;
  for (const ctx of Object.keys(EMAIL_RENDER_CONTEXT_SAMPLES) as RenderContext[]) {
    if (Object.hasOwn(EMAIL_RENDER_CONTEXT_SAMPLES[ctx], root)) return ctx;
  }
  return null;
};

/** Whether a built-in sender passes `path`. A walk that reaches an array before
 *  the path ends counts as passed: `signers.1.email` exists whenever the request
 *  had two signers, which is not something a sample can know. */
export const senderPasses = (key: BuiltInEmailKey, path: string): boolean => {
  let cur: unknown = BUILT_IN_EMAIL_TEMPLATES[key].sample;
  for (const part of path.split(".")) {
    if (Array.isArray(cur)) return true;
    if (cur && typeof cur === "object" && part in (cur as object)) cur = (cur as Record<string, unknown>)[part];
    else return false;
  }
  return true;
};

export interface VariableWarning {
  path: string;
  /** `not-sent`: a built-in sender never passes it, so it always renders empty.
   *  `no-sample`: nothing in the sample data fills it, so the preview and the
   *  test email show it empty. */
  reason: "not-sent" | "no-sample";
}

export const variableWarnings = (
  e: TemplateEntry,
  d: Draft,
  sample: Record<string, unknown> | null,
): VariableWarning[] => {
  const refs = draftRefs(d);
  if (e.builtIn && !e.isNew) {
    const key = e.builtIn;
    return refs.filter((p) => !senderPasses(key, p)).map((path) => ({ path, reason: "not-sent" }));
  }
  // Unparseable sample data is reported by its own editor; warning about every
  // variable at once on top of that would only bury the real message.
  if (!sample) return [];
  return refs
    .filter((p) => {
      const { found, value } = templatePathValue(sample, p);
      return !found || value === null || value === undefined || value === "";
    })
    .map((path) => ({ path, reason: "no-sample" }));
};

// ── sample data ──────────────────────────────────────────────────────────────

export const parseSample = (text: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Set `path` in a nested object, creating the objects on the way. A leaf never
 *  overwrites an object already there — `user` and `user.email` both used in one
 *  template means `user` is an object. */
export const setPath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = path.split(".");
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1]!;
  const existing = cur[leaf];
  if (existing && typeof existing === "object") return;
  cur[leaf] = value;
};

/** The value a caller's context would supply for `path`, if one of the known
 *  callers supplies it. `data.*` is the triggering row's own and never guessed. */
export const contextSampleValue = (path: string): { found: boolean; value: unknown } => {
  const ctx = contextOf(path);
  if (!ctx || path === "data" || path.startsWith("data.")) return { found: false, value: undefined };
  return templatePathValue(EMAIL_RENDER_CONTEXT_SAMPLES[ctx] as Record<string, unknown>, path);
};

/** The sample data an entry's editor starts with. A built-in email's is what its
 *  sender passes; a custom template's names every variable it uses, filled
 *  where a known caller supplies the value and left empty — and so warned
 *  about — where only the author knows it. */
export const seedSample = (e: TemplateEntry, d: Draft): Record<string, unknown> => {
  if (e.builtIn && !e.isNew) {
    return JSON.parse(JSON.stringify(BUILT_IN_EMAIL_TEMPLATES[e.builtIn].sample)) as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  const paths = [...new Set([...(e.row?.variables ?? []), ...draftRefs(d)])];
  for (const path of paths) {
    const known = contextSampleValue(path);
    setPath(out, path, known.found ? known.value : "");
  }
  return out;
};

export const formatSample = (sample: Record<string, unknown>): string => JSON.stringify(sample, null, 2);

// ── preview ──────────────────────────────────────────────────────────────────

/** A body that brings its own `<html>` is shown as it is; a fragment (every
 *  built-in starter is one) is wrapped the way a mail client wraps it. */
export const isCompleteDocument = (html: string): boolean => /^\s*(<!doctype\b|<html[\s>])/i.test(html);

export type PreviewDevice = "desktop" | "mobile";

/** Layout widths, in CSS px. Mobile is a common phone's viewport; desktop is a
 *  mail client's reading pane — wider than the 600px most email layouts are
 *  built to, so a fixed-width design shows with the margins it gets there. */
export const PREVIEW_SIZE: Record<PreviewDevice, { width: number; height: number }> = {
  desktop: { width: 720, height: 560 },
  mobile: { width: 375, height: 667 },
};

/** Insert `text` over the selection `[start, end)` of `value`. */
export const insertText = (
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } => {
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  return { value: value.slice(0, s) + text + value.slice(e), caret: s + text.length };
};
