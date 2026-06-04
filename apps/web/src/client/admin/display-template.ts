// Shared helpers for the per-collection "display template" — the mustache-style
// string (e.g. `{{ title }} — {{ status }}`) that drives row labels in relation
// pickers and references. The runtime renderer lives in `@backlex/core`
// (`renderTemplate`); these helpers cover the editor (tokenize/serialize) and
// the picker (which relation heads to `?expand=`).

/** Matches a single `{{ dotted.path }}` placeholder, capturing the path. The
 *  pattern mirrors `renderTemplate` in @backlex/core so the editor and the
 *  renderer agree on what counts as a field token. */
export const TEMPLATE_TOKEN = /\{\{\s*([\w$.]+)\s*\}\}/g;

export type Segment =
  | { kind: "text"; value: string }
  | { kind: "field"; path: string };

/** Split a template string into ordered text / field segments. Round-trips with
 *  `serializeSegments` (modulo whitespace normalization inside `{{ }}`). */
export function tokenizeTemplate(tpl: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  // Fresh regex per call — TEMPLATE_TOKEN is `g`-flagged and stateful.
  const re = new RegExp(TEMPLATE_TOKEN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl)) !== null) {
    if (m.index > last) {
      segments.push({ kind: "text", value: tpl.slice(last, m.index) });
    }
    segments.push({ kind: "field", path: m[1] as string });
    last = m.index + m[0].length;
  }
  if (last < tpl.length) {
    segments.push({ kind: "text", value: tpl.slice(last) });
  }
  return segments;
}

/** Serialize segments back to a template string. Field segments become
 *  `{{ path }}` with single-space padding (the canonical form). */
export function serializeSegments(segments: Segment[]): string {
  return segments
    .map((s) => (s.kind === "text" ? s.value : `{{ ${s.path} }}`))
    .join("");
}

/** Top-level head of a dotted path (`author.name` → `author`). */
export const headOf = (path: string): string =>
  path.includes(".") ? (path.split(".")[0] as string) : path;

/** Whether a path drills into a relation (`author.name`) rather than naming a
 *  scalar field directly (`title`). */
export const isNestedPath = (path: string): boolean => path.includes(".");

interface RelationFieldLike {
  name: string;
  type?: string;
  to?: string;
}

/** Given a template and the target collection's fields, return the set of
 *  relation-field names that need `?expand=` so nested paths resolve to real
 *  values at render time. Only single-hop expansion is supported by the REST
 *  API, so chained paths (`a.b.c`) still contribute only their head (`a`). */
export function expandHeads(
  tpl: string,
  fields: RelationFieldLike[],
): string[] {
  const relations = new Set(
    fields.filter((f) => f.type === "relation").map((f) => f.name),
  );
  const heads = new Set<string>();
  for (const seg of tokenizeTemplate(tpl)) {
    if (seg.kind !== "field" || !isNestedPath(seg.path)) continue;
    const head = headOf(seg.path);
    if (relations.has(head)) heads.add(head);
  }
  return [...heads];
}

/** `?expand=` query value for a template, or undefined when nothing to expand. */
export function expandParam(
  tpl: string | null | undefined,
  fields: RelationFieldLike[],
): string | undefined {
  if (!tpl) return undefined;
  const heads = expandHeads(tpl, fields);
  return heads.length ? heads.join(",") : undefined;
}
