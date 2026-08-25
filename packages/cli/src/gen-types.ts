import { writeFileSync } from "node:fs";

// Mirrors `FieldType` in `@backlex/core` (packages/db/src/field-types.ts).
type FieldType =
  | "text"
  | "longtext"
  | "integer"
  | "number"
  | "boolean"
  | "json"
  | "timestamp"
  | "uuid"
  | "relation"
  | "file"
  | "relation_many"
  | "geo"
  | "money"
  | "phone"
  | "email"
  | "url"
  | "hash";

interface FieldChoice {
  value: string;
  label?: string;
}

interface Field {
  name: string;
  type: FieldType;
  required?: boolean;
  /** Stored per-locale in the translations sidecar — the value is the native
   *  type when read with `?locale=xx`, or a `{locale: value}` map otherwise. */
  localized?: boolean;
  /** Target collection slug for `relation` / `relation_many`. */
  to?: string | null;
  /** UI hint — `"dropdown"`/`"select"` narrows the value to a literal union. */
  interface?: string | null;
  options?: {
    values?: string[];
    choices?: FieldChoice[];
  } | null;
}

interface Collection {
  slug: string;
  singular?: string | null;
  fields: Field[];
  ownerScoped?: boolean | number;
  /** draft/publish versioning → `_status` + `_publishedAt` columns. */
  versioned?: boolean | number;
  /** Whether the physical table carries (an alias for) `created_at`. */
  hasCreatedAt?: boolean;
  hasUpdatedAt?: boolean;
}

// Scalar field types → TS. Relation/file/dropdown are handled specially in
// `fieldType()` so they can consult the field's `to` / `options` metadata.
const SCALAR_TYPES: Record<FieldType, string> = {
  text: "string",
  longtext: "string",
  integer: "number",
  number: "number",
  boolean: "boolean",
  json: "unknown",
  timestamp: "string",
  uuid: "string",
  // FK id — the expanded object is described by the `<Slug>Relations` map.
  relation: "string",
  // Storage key for a `system_files` row.
  file: "string",
  // Array of foreign ids.
  relation_many: "string[]",
  // A point on the earth.
  geo: "{ lat: number; lng: number }",
  // Canonical E.164 on read. A write may send any form a human writes — the
  // server canonicalizes it — so this is deliberately not a template-literal
  // type: `\`+${number}\`` would describe what comes back and reject what goes
  // in, and a generated `.d.ts` that refuses valid writes is worse than a plain
  // string.
  phone: "string",
  // Canonical on read, anything a person types on write — so a plain string for
  // the same reason `phone` is one. A `\`${string}@${string}\`` template type
  // would look precise and buy nothing: it accepts `"@"` and rejects nothing an
  // operator would actually mistype.
  email: "string",
  // Canonical on read, anything a person types on write — a plain string for the
  // third time, and the reason is sharpest here: a write may send the bare
  // `acme.com` the server folds into `https://acme.com/`, so any template type
  // describing the READ shape (`\`https://${string}\``) would reject exactly the
  // shorthand the field type exists to accept.
  //
  // This map is a hand-maintained TWIN of the `FieldType` union in
  // `@backlex/db` — a separate package, so the compiler cannot tell them apart
  // and a missing entry is not a type error. It falls through to `unknown`,
  // which is quiet: a generated `.d.ts` where every URL column is `unknown`
  // still compiles and just forces a cast at every use.
  url: "string",
  // An amount in MAJOR units plus the currency it is denominated in. Written
  // structurally rather than as a named import so the generated file stays
  // standalone — it is a `.d.ts` a consumer drops into their own project.
  money: "{ amount: number; currency: string }",
  // A one-way digest: writable as a string, always reads back null.
  hash: "null",
  // Localized map; collapses to a string when read with `?locale=xx`.
};

const pascal = (s: string): string =>
  s.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());

const truthy = (v: boolean | number | undefined): boolean => Boolean(v);

/** A field is a single-string enum when it carries dropdown choices/values. */
const enumValues = (f: Field): string[] | null => {
  if (f.type !== "text" && f.type !== "longtext") return null;
  const choices = f.options?.choices?.map((c) => c.value);
  const values = choices?.length ? choices : f.options?.values;
  return values && values.length ? values : null;
};

/** Quote a string literal for a TS union member. */
const lit = (v: string): string => JSON.stringify(v);

/** The TS type of a field's *stored* value (FK ids, scalars, enum unions). */
const fieldType = (f: Field): string => {
  const vals = enumValues(f);
  const base = vals ? vals.map(lit).join(" | ") : (SCALAR_TYPES[f.type] ?? "unknown");
  // A `localized` field reads back as the native value (with `?locale=xx`) or a
  // `{locale: value}` map (default / `?locale=*`).
  if (f.localized) return `${base} | Record<string, ${base}>`;
  return base;
};

/** Append ` | null` unless the field is required. */
const nullable = (t: string, required: boolean | undefined): string =>
  required ? t : `${t} | null`;

/** Relation fields whose `to` target is a known collection in this schema. */
const relationFields = (
  c: Collection,
  known: Set<string>,
): { name: string; target: string; many: boolean; required: boolean }[] =>
  c.fields
    .filter(
      (f) =>
        (f.type === "relation" || f.type === "relation_many") &&
        typeof f.to === "string" &&
        known.has(f.to),
    )
    .map((f) => ({
      name: f.name,
      target: pascal(f.to as string),
      many: f.type === "relation_many",
      required: Boolean(f.required),
    }));

// Every row/registry shape is emitted as a `type` alias, NOT an `interface`.
// TypeScript gives implicit index signatures to type aliases but not to
// interfaces, and `--sdk` output feeds `Collections` to
// `typedCollections<R extends CollectionsMap>` where
// `CollectionsMap = Record<string, Record<string, unknown>>`. Emitting
// interfaces makes the generated file fail its own consumer with
// `TS2344: … Index signature for type 'string' is missing`, on the row types
// as well as on the registry. Pinned by tests/gen-types-index-signature.test.ts.
const renderCollection = (c: Collection): string => {
  const lines: string[] = [];
  lines.push(`export type ${pascal(c.slug)} = {`);
  lines.push(`  id: string;`);
  if (truthy(c.versioned)) {
    lines.push(`  _status: string;`);
    lines.push(`  _publishedAt: string | null;`);
  }
  if (truthy(c.ownerScoped)) {
    lines.push(`  ownerId: string | null;`);
  }
  if (c.hasCreatedAt !== false) lines.push(`  createdAt: string;`);
  if (c.hasUpdatedAt !== false) lines.push(`  updatedAt: string;`);
  for (const f of c.fields) {
    // User-defined fields keep their snake_case name — that's exactly what the
    // REST API returns (system columns above are the only camelCased ones).
    lines.push(`  ${f.name}: ${nullable(fieldType(f), f.required)};`);
  }
  lines.push(`};`);
  return lines.join("\n");
};

/** `<Slug>Relations` — the expanded shape of each relation field, plus a
 *  `<Slug>Expanded` convenience with every relation inlined. */
const renderRelations = (c: Collection, known: Set<string>): string | null => {
  const rels = relationFields(c, known);
  if (!rels.length) return null;
  const name = pascal(c.slug);
  const lines: string[] = [`export type ${name}Relations = {`];
  for (const r of rels) {
    const t = r.many ? `${r.target}[]` : r.target;
    lines.push(`  ${r.name}: ${nullable(t, r.required)};`);
  }
  lines.push(`};`);
  lines.push(
    `export type ${name}Expanded = Expand<${name}, ${name}Relations>;`,
  );
  return lines.join("\n");
};

const renderRegistry = (collections: Collection[]): string => {
  const entries = collections
    .map((c) => `  ${c.slug}: ${pascal(c.slug)};`)
    .join("\n");
  return `export type Collections = {\n${entries}\n};`;
};

// Inlined so plain (non-`--sdk`) output stays dependency-free. Swaps the
// relation keys `K` of a base row for their expanded target type(s).
const EXPAND_HELPER = `/**
 * Replace the relation keys \`K\` of a base row \`Row\` with their expanded
 * target type(s) from \`Rel\`. With no \`K\`, every relation is expanded:
 *
 *   type PostExpanded = Expand<Post, PostRelations>;             // all relations
 *   type PostWithAuthor = Expand<Post, PostRelations, "author">; // just one
 */
export type Expand<
  Row,
  Rel,
  K extends keyof Rel & keyof Row = keyof Rel & keyof Row,
> = Omit<Row, K> & Pick<Rel, K>;`;

const SDK_IMPORT = `import {\n  createClient,\n  typedCollections,\n  type ClientOptions,\n  type TypedClient,\n} from "backlex";\n`;

const SDK_FACTORY = `/**
 * A strongly-typed backlex client. Access collections by slug — every method
 * is typed against the generated row interfaces:
 *
 *   const db = createTypedClient({ url: "https://api.your.app", apiKey });
 *   const { data } = await db.collections.posts.list(); // data: Posts[]
 *
 * For expanded reads, parameterize \`from\` with an \`Expand<…>\` row:
 *
 *   const { data } = await db.from<PostsExpanded>("posts")
 *     .query().expand("author").list();                 // data: PostsExpanded[]
 *
 * The underlying client (auth, storage, \`from<T>\`, …) is still available.
 */
export const createTypedClient = (opts: ClientOptions): TypedClient<Collections> =>
  typedCollections<Collections>(createClient(opts));`;

/** Render the full TypeScript module. Pure — no I/O — so it's unit-testable. */
export const renderModule = (
  collections: Collection[],
  opts: { apiUrl: string; sdk?: boolean },
): string => {
  const known = new Set(collections.map((c) => c.slug));
  const relationBlocks = collections
    .map((c) => renderRelations(c, known))
    .filter((b): b is string => b !== null);
  const hasRelations = relationBlocks.length > 0;

  const banner = `// Auto-generated by \`backlex gen-types${
    opts.sdk ? " --sdk" : ""
  }\` from ${opts.apiUrl}\n// Do not edit by hand. Regenerate after schema changes.\n\n`;
  const body = [
    ...collections.map(renderCollection),
    ...(hasRelations ? [EXPAND_HELPER, ...relationBlocks] : []),
    renderRegistry(collections),
    ...(opts.sdk ? [SDK_FACTORY] : []),
  ].join("\n\n");
  return banner + (opts.sdk ? `${SDK_IMPORT}\n` : "") + body + "\n";
};

export const runGenTypes = async (
  apiUrl: string,
  outPath?: string,
  apiKey?: string,
  sdk?: boolean,
): Promise<void> => {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${apiUrl}/api/collections`, { headers });
  if (!res.ok) {
    throw new Error(`fetch ${apiUrl}/api/collections → ${res.status}`);
  }
  const body = (await res.json()) as { data: Collection[] };
  const out = renderModule(body.data, { apiUrl, sdk });

  if (outPath) {
    writeFileSync(outPath, out, "utf8");
    const what = sdk ? "typed SDK" : "types";
    console.log(`✓ wrote ${what} for ${body.data.length} collection(s) → ${outPath}`);
  } else {
    process.stdout.write(out);
  }
};
