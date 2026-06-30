import {
  columnDefSql,
  type FieldDef,
  type FieldType,
  quote,
  sqlTypeFor,
} from "./field-types";

type Dialect = "pg" | "sqlite";

/**
 * The schema-relevant, persistable subset of a `collections` metadata row.
 * A {@link SchemaSnapshot} is an array of these — the unit captured, diffed,
 * branched, and applied. It deliberately excludes runtime/lifecycle columns
 * (`id`, `status`, `archivedAt`, `createdAt`, `updatedAt`, vectorize model)
 * that don't define the *shape* of a workspace's schema.
 */
export interface SchemaCollection {
  slug: string;
  /** Physical table name. Snapshot-only — apply re-derives for managed
   *  collections and trusts the stored value for adopted ones. */
  physicalTable?: string;
  adopted?: boolean;
  ownerScoped?: boolean;
  tenantScoped?: boolean;
  versioned?: boolean;
  softDelete?: boolean;
  fts?: boolean;
  singleton?: boolean;
  fields: FieldDef[];
  // Display metadata — snapshotted so a restore is faithful, but changes to
  // these are classified `metadata` (no DDL, no data risk).
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  displayTemplate?: string | null;
  defaultSort?: string | null;
}

export type SchemaSnapshot = SchemaCollection[];

/**
 * Severity of a single change, mapping directly to how it can be applied:
 * - `additive` — safe to auto-apply (CREATE TABLE, nullable ADD COLUMN, CREATE
 *   INDEX, enabling a versioned/softDelete/fts flag). The applier is additive
 *   and idempotent, so these never lose data.
 * - `destructive` — loses data or rows; gated behind an explicit confirm
 *   (DROP COLUMN, DROP TABLE, a column type/constraint change that can only be
 *   realised by drop+re-add, or a NOT-NULL add to a possibly-populated table).
 * - `metadata` — neither DDL nor data risk (display labels, turning a flag
 *   *off* — the applier never removes those columns — interface/validation
 *   tweaks). Recorded for a faithful restore but free to apply.
 */
export type ChangeSeverity = "additive" | "destructive" | "metadata";

export type SchemaChangeKind =
  | "collection.add"
  | "collection.drop"
  | "collection.flag"
  | "collection.metadata"
  | "field.add"
  | "field.drop"
  | "field.type"
  | "field.constraint"
  | "field.index"
  | "field.metadata";

export interface SchemaChange {
  kind: SchemaChangeKind;
  severity: ChangeSeverity;
  collection: string;
  /** Field name for `field.*` changes; undefined for collection-level ones. */
  field?: string;
  /** Human-readable one-liner for the diff viewer. */
  summary: string;
  /** Previous value (string/flag), when meaningful. */
  before?: unknown;
  /** Target value, when meaningful. */
  after?: unknown;
  /** The DDL this change would emit per dialect. Empty for `metadata` changes
   *  and for adopted-table changes (the applier never DDLs adopted tables). */
  ddl?: { pg: string[]; sqlite: string[] };
}

export interface SchemaDiff {
  changes: SchemaChange[];
  counts: {
    additive: number;
    destructive: number;
    metadata: number;
    total: number;
  };
  /** True when any change is `destructive` — apply requires `confirmDestructive`. */
  hasDestructive: boolean;
}

const bySlug = (snap: SchemaSnapshot): Map<string, SchemaCollection> => {
  const m = new Map<string, SchemaCollection>();
  for (const c of snap) m.set(c.slug, c);
  return m;
};

const fieldsByName = (fields: FieldDef[]): Map<string, FieldDef> => {
  const m = new Map<string, FieldDef>();
  for (const f of fields) m.set(f.name, f);
  return m;
};

/** Per-dialect DDL bundle attached to a change. */
type Ddl = { pg: string[]; sqlite: string[] };

/** Both dialects' ADD COLUMN DDL for a field on a table. */
const addColumnDdl = (table: string, f: FieldDef): Ddl => ({
  pg: [`ALTER TABLE ${quote(table)} ADD COLUMN ${columnDefSql(f, "pg")}`],
  sqlite: [`ALTER TABLE ${quote(table)} ADD COLUMN ${columnDefSql(f, "sqlite")}`],
});

const dropColumnDdl = (table: string, name: string): Ddl => {
  const d = `ALTER TABLE ${quote(table)} DROP COLUMN ${quote(name)}`;
  return { pg: [d], sqlite: [d] };
};

const dropTableDdl = (table: string): Ddl => {
  const d = `DROP TABLE IF EXISTS ${quote(table)}`;
  return { pg: [d], sqlite: [d] };
};

const tableOf = (c: SchemaCollection): string => c.physicalTable ?? `c_${c.slug}`;

/** True when adding a column with this field would write data on existing rows
 *  in a way that fails on a populated table — i.e. NOT NULL without a default
 *  and without a generated formula. Those rows have no value to backfill. */
const isUnsafeAdd = (f: FieldDef): boolean =>
  Boolean(f.required) && f.default === undefined && !f.computed;

const FLAG_KEYS = ["ownerScoped", "tenantScoped", "versioned", "softDelete", "fts", "singleton"] as const;
type FlagKey = (typeof FLAG_KEYS)[number];

/** Flags whose physical effect is an additive column backfill when turned ON.
 *  Turning any of them OFF is `metadata` — the applier never drops the column. */
const ADDITIVE_WHEN_ON: Set<FlagKey> = new Set(["tenantScoped", "versioned", "softDelete", "fts"]);

const flagSummary = (slug: string, key: FlagKey, on: boolean): string =>
  `${slug}: ${on ? "enable" : "disable"} ${key}`;

const constraintLabel = (f: FieldDef): string =>
  [f.required ? "required" : null, f.unique ? "unique" : null].filter(Boolean).join("+") || "none";

/**
 * Diff two schema snapshots into a categorized, DDL-annotated change list.
 *
 * Pure and dialect-agnostic: it never touches a database. `from` is the
 * baseline (usually the live schema), `to` is the target (a snapshot/branch
 * head being previewed or applied). The result drives both the admin diff
 * viewer and the apply engine's safe/destructive gating.
 */
export const diffSchema = (from: SchemaSnapshot, to: SchemaSnapshot): SchemaDiff => {
  const changes: SchemaChange[] = [];
  const fromMap = bySlug(from);
  const toMap = bySlug(to);

  // Added + dropped collections.
  for (const [slug, target] of toMap) {
    if (fromMap.has(slug)) continue;
    changes.push({
      kind: "collection.add",
      severity: "additive",
      collection: slug,
      summary: `Create collection "${slug}" (${target.fields.length} field${target.fields.length === 1 ? "" : "s"})`,
      after: target.adopted ? "adopted" : "managed",
      // Adopted tables already exist — apply only writes metadata, no DDL.
      ddl: target.adopted ? { pg: [], sqlite: [] } : undefined,
    });
  }
  for (const [slug, prev] of fromMap) {
    if (toMap.has(slug)) continue;
    changes.push({
      kind: "collection.drop",
      // Dropping an adopted collection only removes our metadata — the user's
      // table is never touched, so it carries no data risk for them.
      severity: prev.adopted ? "metadata" : "destructive",
      collection: slug,
      summary: prev.adopted
        ? `Remove adopted collection "${slug}" (table left intact)`
        : `Drop collection "${slug}" and its table`,
      before: prev.adopted ? "adopted" : "managed",
      ddl: prev.adopted ? { pg: [], sqlite: [] } : dropTableDdl(tableOf(prev)),
    });
  }

  // Per-collection field + flag diffs for collections present in both.
  for (const [slug, target] of toMap) {
    const prev = fromMap.get(slug);
    if (!prev) continue;
    const table = tableOf(target);
    const adopted = Boolean(target.adopted);

    diffFields(changes, slug, table, adopted, prev, target);
    diffFlags(changes, slug, prev, target);
    diffCollectionMetadata(changes, slug, prev, target);
  }

  return summarize(changes);
};

const diffFields = (
  changes: SchemaChange[],
  slug: string,
  table: string,
  adopted: boolean,
  prev: SchemaCollection,
  target: SchemaCollection,
): void => {
  const prevFields = fieldsByName(prev.fields);
  const targetFields = fieldsByName(target.fields);
  const noDdl = adopted ? { pg: [], sqlite: [] } : undefined;

  for (const [name, tf] of targetFields) {
    const pf = prevFields.get(name);
    if (!pf) {
      const unsafe = isUnsafeAdd(tf);
      changes.push({
        kind: "field.add",
        severity: unsafe ? "destructive" : "additive",
        collection: slug,
        field: name,
        summary: unsafe
          ? `${slug}.${name}: add required ${tf.type} column with no default (fails on existing rows)`
          : `${slug}.${name}: add ${tf.type} column`,
        after: tf.type,
        ddl: adopted ? noDdl : addColumnDdl(table, tf),
      });
      continue;
    }
    // Type change — the applier can't ALTER TYPE, so this is a drop + re-add.
    if (pf.type !== tf.type || pf.to !== tf.to) {
      changes.push({
        kind: "field.type",
        severity: "destructive",
        collection: slug,
        field: name,
        summary: `${slug}.${name}: change type ${describeType(pf)} → ${describeType(tf)} (drop + re-add, data lost)`,
        before: describeType(pf),
        after: describeType(tf),
        ddl: adopted
          ? noDdl
          : {
              pg: [...dropColumnDdl(table, name).pg, ...addColumnDdl(table, tf).pg],
              sqlite: [...dropColumnDdl(table, name).sqlite, ...addColumnDdl(table, tf).sqlite],
            },
      });
      continue;
    }
    // Constraint tightening (required/unique gained) vs loosening.
    const tightened =
      (tf.required && !pf.required) || (tf.unique && !pf.unique) || pf.computed?.formula !== tf.computed?.formula;
    if (tightened) {
      changes.push({
        kind: "field.constraint",
        severity: "destructive",
        collection: slug,
        field: name,
        summary: `${slug}.${name}: tighten constraints (${constraintLabel(pf)} → ${constraintLabel(tf)})`,
        before: constraintLabel(pf),
        after: constraintLabel(tf),
        // Constraint changes on an existing column need a manual migration —
        // the additive applier can't realise them. Recorded, no auto-DDL.
        ddl: { pg: [], sqlite: [] },
      });
    } else if ((pf.required && !tf.required) || (pf.unique && !tf.unique)) {
      changes.push({
        kind: "field.constraint",
        severity: "metadata",
        collection: slug,
        field: name,
        summary: `${slug}.${name}: loosen constraints (${constraintLabel(pf)} → ${constraintLabel(tf)})`,
        before: constraintLabel(pf),
        after: constraintLabel(tf),
      });
    }
    // Index toggle — additive (CREATE INDEX) when gained; metadata when dropped.
    if (!pf.indexed && tf.indexed) {
      changes.push({
        kind: "field.index",
        severity: "additive",
        collection: slug,
        field: name,
        summary: `${slug}.${name}: add index`,
        ddl: adopted
          ? noDdl
          : {
              pg: [`CREATE INDEX IF NOT EXISTS ${quote(`${table}_${name}_idx`)} ON ${quote(table)} (${quote(name)})`],
              sqlite: [
                `CREATE INDEX IF NOT EXISTS ${quote(`${table}_${name}_idx`)} ON ${quote(table)} (${quote(name)})`,
              ],
            },
      });
    } else if (pf.indexed && !tf.indexed) {
      changes.push({
        kind: "field.index",
        severity: "metadata",
        collection: slug,
        field: name,
        summary: `${slug}.${name}: remove index (left in place; drop manually)`,
      });
    }
    // Pure display metadata (label/description/interface/options/validation).
    if (fieldMetadataChanged(pf, tf)) {
      changes.push({
        kind: "field.metadata",
        severity: "metadata",
        collection: slug,
        field: name,
        summary: `${slug}.${name}: update field metadata`,
      });
    }
  }

  for (const [name, pf] of prevFields) {
    if (targetFields.has(name)) continue;
    changes.push({
      kind: "field.drop",
      severity: "destructive",
      collection: slug,
      field: name,
      summary: `${slug}.${name}: drop ${pf.type} column`,
      before: pf.type,
      ddl: adopted ? noDdl : dropColumnDdl(table, name),
    });
  }
};

const diffFlags = (
  changes: SchemaChange[],
  slug: string,
  prev: SchemaCollection,
  target: SchemaCollection,
): void => {
  for (const key of FLAG_KEYS) {
    const before = Boolean(prev[key]);
    const after = Boolean(target[key]);
    if (before === after) continue;
    // Turning an additive flag ON backfills a column; everything else (turning
    // off, or toggling a UI-only flag like singleton/ownerScoped) is metadata.
    const additive = after && ADDITIVE_WHEN_ON.has(key);
    changes.push({
      kind: "collection.flag",
      severity: additive ? "additive" : "metadata",
      collection: slug,
      field: key,
      summary: flagSummary(slug, key, after),
      before,
      after,
    });
  }
};

const META_KEYS = ["singular", "plural", "note", "displayTemplate", "defaultSort"] as const;

const diffCollectionMetadata = (
  changes: SchemaChange[],
  slug: string,
  prev: SchemaCollection,
  target: SchemaCollection,
): void => {
  const fieldsChanged = META_KEYS.filter((k) => (prev[k] ?? null) !== (target[k] ?? null));
  if (fieldsChanged.length === 0) return;
  changes.push({
    kind: "collection.metadata",
    severity: "metadata",
    collection: slug,
    summary: `${slug}: update ${fieldsChanged.join(", ")}`,
  });
};

const describeType = (f: FieldDef): string =>
  f.to ? `${f.type}→${f.to}` : f.type;

const fieldMetadataChanged = (a: FieldDef, b: FieldDef): boolean =>
  a.label !== b.label ||
  a.description !== b.description ||
  a.interface !== b.interface ||
  a.group !== b.group ||
  JSON.stringify(a.options ?? null) !== JSON.stringify(b.options ?? null) ||
  JSON.stringify(a.validation ?? null) !== JSON.stringify(b.validation ?? null) ||
  JSON.stringify(a.visibleWhen ?? null) !== JSON.stringify(b.visibleWhen ?? null) ||
  (a.default ?? null) !== (b.default ?? null);

const summarize = (changes: SchemaChange[]): SchemaDiff => {
  let additive = 0;
  let destructive = 0;
  let metadata = 0;
  for (const c of changes) {
    if (c.severity === "additive") additive += 1;
    else if (c.severity === "destructive") destructive += 1;
    else metadata += 1;
  }
  return {
    changes,
    counts: { additive, destructive, metadata, total: changes.length },
    hasDestructive: destructive > 0,
  };
};

/** Recursively sort object keys so equivalent objects serialize identically
 *  regardless of insertion order. Arrays keep their (already-normalized) order. */
const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
};

/** Stable, key-sorted JSON of a snapshot for content hashing / equality. The
 *  hash itself is computed by the caller (the server has crypto.subtle); this
 *  only guarantees a deterministic byte stream regardless of key/field order. */
export const canonicalizeSnapshot = (snap: SchemaSnapshot): string => {
  const norm = [...snap]
    .map((c) => ({
      ...c,
      fields: [...c.fields].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return JSON.stringify(sortKeysDeep(norm));
};

/** Convenience: the SQL column type a field maps to, re-exported so apply
 *  callers don't reach into field-types directly. */
export const fieldSqlType = (type: FieldType, dialect: Dialect): string => sqlTypeFor(type, dialect);
