import type { Condition, DurationParts, RelativeNow } from "@backlex/core";

type Dialect = "pg" | "sqlite";

export type FieldType =
  | "text"
  | "longtext"
  | "integer"
  | "number"
  | "boolean"
  | "json"
  | "timestamp"
  | "uuid"
  | "relation"
  /** Single foreign storage key (relation to system_files). UI: file picker. */
  | "file"
  /** Many-to-many — JSON array of foreign ids. Stored as TEXT/JSONB. */
  | "relation_many"
  /**
   * One-way hashed secret (password / PIN / API secret). The API hashes the
   * incoming plaintext (scrypt) on write and stores only the digest; reads
   * always return `null` (the digest never leaves the DB except in a raw
   * backup). Filtering/sorting/FTS/vector are rejected — the only way to test
   * a value is the `POST /:slug/:id/verify` endpoint. Stored as TEXT.
   */
  | "hash"
  /**
   * Presentational-only field types — they render in the item form (a labeled
   * rule / an info callout) but own NO physical column and carry NO value. The
   * items runtime never sees them: {@link loadCollection} strips them before
   * serialize/write/validate, and the schema applier skips them for DDL. See
   * {@link isPresentational}.
   */
  | "divider"
  | "notice";

/**
 * Every valid {@link FieldType} token, in declaration order — the single source
 * of truth for the surfaces that must validate a type string coming off the
 * wire (the collections create/patch zod enum, the custom-template apply). Each
 * of those used to hand-maintain its own copy, and each has drifted at least
 * once: `file` and `hash` went missing from the collections enum, and
 * `divider`/`notice` from the template one — so a workspace using a layout
 * block could not re-apply its own extract. The exhaustiveness guard below
 * turns that drift into a compile error instead of a 422 nobody hits until a
 * customer does.
 */
export const FIELD_TYPES = [
  "text",
  "longtext",
  "integer",
  "number",
  "boolean",
  "json",
  "timestamp",
  "uuid",
  "relation",
  // Single foreign storage key (relation to system_files), stored as TEXT.
  "file",
  "relation_many",
  // One-way hashed secret — the write path scrypt-hashes the plaintext and
  // stores only the digest; reads return null; verification goes through
  // `POST /:slug/:id/verify`.
  "hash",
  // Presentational-only blocks — no column, no value. `loadCollection` strips
  // them from every items path; the schema applier skips them for DDL.
  "divider",
  "notice",
] as const satisfies readonly FieldType[];

// Compile-time exhaustiveness: adding a member to `FieldType` without listing
// it above makes this assignment fail to typecheck.
type UncoveredFieldType = Exclude<FieldType, (typeof FIELD_TYPES)[number]>;
const _fieldTypesAreExhaustive: UncoveredFieldType extends never ? true : never = true;
void _fieldTypesAreExhaustive;

/**
 * True for field types that are pure layout/presentation — they have no
 * physical column, take no value, and must be filtered out of every storage,
 * serialization, and query path. The item-form + schema editor keep them for
 * rendering. Kept in sync with `PRESENTATIONAL_TYPES` in the admin item-form.
 */
export const isPresentational = (field: { type: FieldType }): boolean =>
  field.type === "divider" || field.type === "notice";

/**
 * Runtime check that a type string read back from stored metadata is one this
 * build actually knows.
 *
 * `collections.fields` is a JSON blob the code *asserts* is `FieldDef[]`, but
 * nothing re-validates it on read — so a workspace written by an older build
 * can carry a type since dropped (`i18n_text`, removed in 6bd2f601 with no data
 * migration). TypeScript's exhaustiveness checking proves a switch covers every
 * `FieldType`; it cannot prove the value on the wire IS one. Anything consuming
 * `field.type` where a miss is worse than a fallback should guard with this
 * first — see `fieldGqlType`, where an unrecognised type used to produce an
 * `undefined` scalar and take the whole GraphQL endpoint down at schema-build
 * time.
 */
export const isKnownFieldType = (type: string): type is FieldType =>
  (FIELD_TYPES as readonly string[]).includes(type);

/** Soft validation rules — enforced at the API layer, not at the DB. */
export interface FieldValidation {
  /** Regex pattern (string-form, ECMA syntax). Applied to text/longtext/hash. */
  regex?: string;
  /** Inclusive bounds for integer/number. */
  min?: number;
  max?: number;
  /** Length bounds for text/longtext/hash. */
  minLength?: number;
  maxLength?: number;
  /**
   * Built-in format check for text/longtext/hash — applies a canonical regex.
   * `email` and `url` save admins from hand-writing (and getting wrong) the
   * pattern. Combined with `regex`, both must pass.
   */
  format?: "email" | "url";
  /** Require a whole number (no fractional part). Only for `integer`/`number`. */
  integer?: boolean;
  /**
   * Inclusive datetime bounds for `timestamp` fields. Each accepts an epoch-ms
   * number, an ISO-8601 string, the literal `"$now"`, or a relative-now object
   * (`{ $now: { sub: { days: 1 } } }`) — the same dynamic-date vocabulary the
   * permission/filter DSL uses. The incoming value is parsed to epoch-ms before
   * comparison.
   */
  minDate?: string | number | RelativeNow;
  maxDate?: string | number | RelativeNow;
  /** Cardinality bounds for `relation_many` (JSON array length). */
  minSelect?: number;
  maxSelect?: number;
  /**
   * Cross-field escape hatch — a filter over the WHOLE row (same DSL as
   * permission conditions) that must match for the row to be valid. Sibling
   * field values are referenced with `"$field.<name>"` on the comparison side,
   * e.g. `{ end_date: { _gte: "$field.start_date" } }`. Evaluated server-side
   * in JS on every create/update; the SQL path is untouched.
   */
  rule?: Condition;
  /**
   * Custom message shown on ANY validation failure for this field (a per-value
   * check OR the cross-field `rule`). Falls back to a generated message.
   */
  message?: string;
  /**
   * How a failure is treated. `error` (default) rejects the write (422).
   * `warning` / `info` are advisory: the write is NOT blocked — the message is
   * surfaced in the write response's `warnings` array instead, so a client can
   * show a soft hint. Applies to both the per-value checks and the cross-field
   * `rule`. Dropdown choice-membership is always enforced regardless.
   */
  severity?: "error" | "warning" | "info";
}

/**
 * Optional UI hint that picks the editor for a field — purely cosmetic, the
 * storage type is what actually matters. The admin ships a conventional
 * catalog of these in `apps/web/src/client/admin/interfaces.ts` (`input`,
 * `markdown`, `richtext`, `dropdown`, `toggle`, `datetime`, `color`,
 * `relation`, …); the server treats the value as an opaque string and only
 * special-cases `dropdown` (choice membership is enforced) and `user` (a
 * `text` field whose value must reference an `app_users` row in the active
 * workspace — checked on item write). New interfaces can be added to the
 * catalog without touching this package.
 */
export type FieldInterface = string;

/**
 * One option in a dropdown. `value` is what the column
 * stores and what filters compare against. `label` is the human label
 * (defaults to value). `color` is a CSS color string applied to the badge
 * in lists. `icon` is a lucide icon name (UI-only).
 */
export interface FieldChoice {
  value: string;
  label?: string;
  color?: string;
  icon?: string;
}

export interface FieldOptions {
  /**
   * @deprecated Use `choices` instead. Kept for back-compat with collections
   * created before the choices model existed; the helper `getChoiceValues`
   * coerces either shape to a string list.
   */
  values?: string[];
  /** Per-choice metadata for `interface: dropdown`. */
  choices?: FieldChoice[];
}

/** Returns the allowed values list, regardless of legacy `values` vs `choices`. */
export const getChoiceValues = (field: FieldDef): string[] => {
  if (field.options?.choices?.length) {
    return field.options.choices.map((c) => c.value);
  }
  if (field.options?.values?.length) {
    return field.options.values;
  }
  return [];
};

/** Whether a field's value is stored per-locale in the `<table>__i18n` sidecar. */
export const isLocalized = (field: FieldDef): boolean => Boolean(field.localized);

/** Fields whose values live in the sidecar (`localized:true`). */
export const localizedFields = (fields: FieldDef[]): FieldDef[] =>
  fields.filter(isLocalized);

/** Alias of {@link localizedFields} — the columns of the `<table>__i18n` sidecar. */
export const sidecarFields = (fields: FieldDef[]): FieldDef[] => localizedFields(fields);

/** Returns choices in normalized shape — synthesizes from legacy `values` if needed. */
export const getChoices = (field: FieldDef): FieldChoice[] => {
  if (field.options?.choices?.length) {
    return field.options.choices;
  }
  if (field.options?.values?.length) {
    return field.options.values.map((v) => ({ value: v }));
  }
  return [];
};

/** Show this field in the editor only when another field matches a value. */
export interface FieldVisibility {
  field: string;
  /** Reuses the permission DSL operators. Most common: `_eq`. */
  op: "_eq" | "_neq" | "_in";
  value?: unknown;
}

/** Aggregate functions a {@link RollupSpec} can apply. Mirrors the item
 *  aggregate engine's `ITEMS_AGG_FUNCS` — same five, same semantics. */
export const ROLLUP_FNS = ["count", "sum", "avg", "min", "max"] as const;
export type RollupFn = (typeof ROLLUP_FNS)[number];

/**
 * A number on THIS row that is an aggregate over rows in another collection —
 * an invoice's `subtotal` over its lines, a campaign's `raised_amount` over its
 * donations, a budget's `amount_spent` over its expenses.
 *
 * Unlike {@link FieldDef.computed} (a SQL generated column, and therefore
 * strictly same-row) a rollup reads OTHER rows, which no generated column in
 * either dialect can do. It is a plain stored column the server refreshes with
 * one self-contained `UPDATE … SET col = (SELECT <fn> …)` statement whenever a
 * child row is created / updated / deleted. Stored rather than computed-on-read
 * for a concrete reason: templates already put generated columns *on top of*
 * these numbers (`balance_due = total - amount_paid`), and a generated column
 * can only reference a real column.
 *
 * Client writes to a rollup column are rejected the same way `computed` ones
 * are — the value is the server's to maintain.
 */
export interface RollupSpec {
  /** Slug of the collection holding the rows being aggregated (the children). */
  from: string;
  /** Name of the `relation` field ON that collection which points back here. */
  via: string;
  /** Aggregate to apply. */
  fn: RollupFn;
  /** Child field to aggregate. Required for every fn except `count`, which
   *  counts rows and takes no field. */
  field?: string;
  /**
   * Optional filter narrowing which child rows count, in the same condition
   * DSL as permissions (`{"status":{"_eq":"paid"}}`). Field references resolve
   * against the CHILD row. Soft-deleted children are always excluded; anything
   * else — draft status, a per-row flag — belongs here.
   */
  filter?: Condition;
}

/** True when a field's value is maintained by a rollup rather than written. */
export const isRollup = (field: { rollup?: RollupSpec }): boolean =>
  Boolean(field.rollup);

/**
 * The value a rollup column should read when the parent has no matching
 * children. `count` / `sum` over an empty set is 0 — a total of "nothing" is
 * zero, not unknown — while `avg` / `min` / `max` are genuinely undefined and
 * stay NULL. Used both as the column DEFAULT (so a parent created before any
 * child already reads right, with no recompute) and by the refresh statement.
 */
export const rollupNeutralValue = (fn: RollupFn): number | null =>
  fn === "count" || fn === "sum" ? 0 : null;

/**
 * Shape validation for a {@link RollupSpec} — everything checkable without
 * reading another collection's metadata. The cross-collection half (does
 * `from` exist, does `via` point back here, is `field` numeric) needs the DB
 * and lives in the server's rollup-validation service, which every collection
 * save funnels through.
 */
export const validateRollupSpec = (name: string, field: FieldDef): void => {
  const spec = field.rollup as RollupSpec | undefined;
  if (!spec) return;
  if (typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`Field "${name}": rollup must be an object`);
  }
  if (typeof spec.from !== "string" || !spec.from) {
    throw new Error(`Field "${name}": rollup.from (source collection slug) is required`);
  }
  assertIdent(spec.from);
  if (typeof spec.via !== "string" || !spec.via) {
    throw new Error(
      `Field "${name}": rollup.via (the relation field on "${spec.from}" pointing back) is required`,
    );
  }
  assertIdent(spec.via);
  if (!(ROLLUP_FNS as readonly string[]).includes(spec.fn)) {
    throw new Error(
      `Field "${name}": rollup.fn must be one of ${ROLLUP_FNS.join(", ")}`,
    );
  }
  if (spec.fn === "count") {
    if (spec.field !== undefined) {
      throw new Error(`Field "${name}": rollup.fn "count" counts rows — drop rollup.field`);
    }
  } else {
    if (typeof spec.field !== "string" || !spec.field) {
      throw new Error(`Field "${name}": rollup.fn "${spec.fn}" requires rollup.field`);
    }
    assertIdent(spec.field);
  }
  // The column has to be able to hold the result. `count` is whole by
  // definition; `avg` is not, and an integer column would silently truncate
  // "3.5 sessions per member" to 3.
  if (field.type !== "integer" && field.type !== "number") {
    throw new Error(
      `Field "${name}": a rollup field must be type integer or number (got "${field.type}")`,
    );
  }
  if (spec.fn === "avg" && field.type !== "number") {
    throw new Error(
      `Field "${name}": rollup.fn "avg" needs a number field — an integer column would truncate the average`,
    );
  }
  if (spec.filter !== undefined) {
    if (typeof spec.filter !== "object" || spec.filter === null || Array.isArray(spec.filter)) {
      throw new Error(`Field "${name}": rollup.filter must be a condition object`);
    }
    // A rollup is one number stored on the row, shared by every reader — so it
    // must not depend on WHO caused the refresh. `$user.*` / `$org.*` would
    // make the stored total whatever the last writer could see, and the next
    // writer would silently overwrite it with a different one. `$now` is out
    // for the same reason in slower motion: the column would be correct only
    // until the clock moved past the boundary, with no write to trigger a
    // refresh. Filter on the child's own columns.
    const subject = firstSubjectVar(spec.filter);
    if (subject) {
      throw new Error(
        `Field "${name}": rollup.filter cannot reference "${subject}" — a rollup is one stored number for every reader, so it must depend only on the child rows' own values`,
      );
    }
  }
};

/** First `$user.` / `$tenant.` / `$org.` / `$now` reference anywhere in a
 *  condition (as a value or as a key), or null. */
const firstSubjectVar = (node: unknown): string | null => {
  if (typeof node === "string") {
    return /^\$(user|tenant|org|now)\b/.test(node) ? node : null;
  }
  if (Array.isArray(node)) {
    for (const x of node) {
      const hit = firstSubjectVar(x);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (/^\$(user|tenant|org|now)\b/.test(k)) return k;
      const hit = firstSubjectVar(v);
      if (hit) return hit;
    }
  }
  return null;
};

/**
 * Per-field condition. When `rule` (a filter over the whole row,
 * same DSL as permission conditions) matches, the effects below apply to the
 * field. `required` is enforced server-side on create/update (a matching rule
 * with an empty value ⇒ 422); `readonly` / `hidden` are UI-only, honoured by
 * the item form (`hidden` subsumes the older `visibleWhen`). A field may carry
 * several conditions; the first matching `required` that fails wins.
 */
export interface FieldCondition {
  /** Optional label — shown in the editor and the 422 message. */
  name?: string;
  /** Filter over the row. Empty object = always matches. */
  rule: Condition;
  /** Server-enforced: value must be non-empty when the rule matches. */
  required?: boolean;
  /** UI-only: disable the input when the rule matches. */
  readonly?: boolean;
  /** UI-only: hide the field when the rule matches. */
  hidden?: boolean;
}

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  /**
   * Create a plain B-tree index on this column (speeds up filter / sort by it).
   * Applied additively by `applyCollection` as `CREATE INDEX IF NOT EXISTS`.
   * Skipped when `unique` is set (the UNIQUE constraint already indexes it) and
   * for adopted tables (no DDL). Indexing aids write cost — opt-in per field.
   */
  indexed?: boolean;
  /** Target collection slug. Required when `type === "relation"`. The
   *  column stores the foreign id as TEXT; integrity enforced at the app
   *  layer (no DB-level FK in v1 to keep ALTER paths simple on SQLite). */
  to?: string;
  /** Display interface override — see FieldInterface. */
  interface?: FieldInterface;
  /** Interface-specific options (e.g. dropdown values). */
  options?: FieldOptions;
  /** Soft validation rules applied on item POST/PATCH. */
  validation?: FieldValidation;
  /** Conditional visibility in the form. Pure UI — no DB or API effect.
   *  Superseded by `conditions` with a `hidden` effect; kept for back-compat. */
  visibleWhen?: FieldVisibility;
  /** Conditional rules — `required` is enforced server-side,
   *  `readonly` / `hidden` are honoured by the item form. See {@link FieldCondition}. */
  conditions?: FieldCondition[];
  /** Group label for form section rendering. UI only. */
  group?: string;
  /**
   * Field width in the item form — `"half"` lets two consecutive half fields
   * share a row (a constrained 2-column grid); anything else is full width.
   * Pure layout metadata: never affects storage, the API, or validation. UI only.
   */
  width?: "full" | "half";
  /**
   * Mark this field's form section (see {@link group}) collapsible. Aggregated
   * across the section — if ANY field in the group sets it, the whole section
   * folds. `sectionCollapsed` additionally starts it collapsed. UI only.
   */
  sectionCollapsible?: boolean;
  sectionCollapsed?: boolean;
  /**
   * Render the form's sections (see {@link group}) as TABS across the top
   * instead of stacked headings — for records too large for one scroll.
   * Form-wide + aggregated: if ANY field sets it, the whole grouped form
   * switches to tabs (one tab per group). UI only.
   */
  sectionsAsTabs?: boolean;
  /**
   * SQL expression for a generated column. When present, the column is
   * created with `GENERATED ALWAYS AS (formula) STORED` and the items
   * routes reject writes to this field. Read-only end-to-end.
   */
  computed?: { formula: string };
  /**
   * Maintain this column as an aggregate over rows in ANOTHER collection —
   * see {@link RollupSpec}. Mutually exclusive with `computed` (which is
   * same-row by construction) and read-only to clients, like `computed`.
   */
  rollup?: RollupSpec;
  /**
   * When true (and the collection has `vectorize: true`), this field's
   * value is concatenated into the embed text on item write. Only
   * meaningful for `text` / `longtext` types — ignored otherwise.
   */
  vectorize?: boolean;
  /**
   * When true (and the collection has `fts: true`), this field's value is
   * folded into the collection's full-text-search index on item write.
   * Only meaningful for `text` / `longtext` types — ignored otherwise.
   */
  searchable?: boolean;
  /**
   * Column-level default applied at the DB layer (`DEFAULT` in the DDL), so an
   * insert that omits the field falls back to it. Only honoured for scalar
   * types (`text` / `longtext` / `integer` / `number` / `boolean`); ignored for
   * `computed` columns (a generated column can't also carry a default) and for
   * relation/file/json/timestamp types (kept to literal scalars to avoid
   * dialect-specific expression syntax).
   */
  default?: string | number | boolean;
  /**
   * Human display name for the field in the admin editor. UI only — the storage
   * column is still keyed by `name`; falls back to `name` when unset.
   */
  label?: string;
  /** Inline help text shown beneath the field in the admin editor. UI only. */
  description?: string;
  /**
   * Private / internal column. When true, the field is stored + writable as
   * normal but NEVER returned through the API read surfaces (REST list/get/CSV/
   * changefeed + GraphQL) — `deserializeRow` and the GraphQL row builder omit
   * it, and it's dropped from the GraphQL output type. Use for internal
   * bookkeeping columns that clients should never see. Unlike `hash` (write +
   * verify only) the value is plain, so a raw backup still round-trips it.
   */
  private?: boolean;
  /**
   * Auto-fill this column on INSERT, server-side. The value is computed and
   * written directly (like `tenant_id` / `created_at`) — any client-supplied
   * value is ignored, so it can't be spoofed. Options:
   *  - `uuid`   → a fresh UUID (uuid / text columns)
   *  - `now`    → the insert timestamp (timestamp columns)
   *  - `user`   → the authenticated user's id (text / uuid columns)
   *  - `tenant` → the active tenant's id (text / uuid columns)
   * The field is treated as read-only for writes (see validateBody).
   */
  onCreate?: "uuid" | "now" | "user" | "tenant";
  /**
   * Auto-fill this column on every UPDATE, server-side (same rules as
   * {@link onCreate} minus `uuid`, which only makes sense on insert). Use for
   * `date_updated` / `user_updated` style bookkeeping columns.
   */
  onUpdate?: "now" | "user" | "tenant";
  /**
   * App-layer ON DELETE referential action for a `relation` / `relation_many`
   * field. When a row in the target collection (`to`) is deleted, referencing
   * rows are fixed up:
   *  - `set_null`  → the FK is set NULL (`relation`) or the id is removed from
   *    the JSON array (`relation_many`)
   *  - `cascade`   → the referencing rows are deleted, chaining through their
   *    own `onDelete` triggers (cycle-guarded)
   *  - `no_action` → nothing (default)
   * Emulated in `enforceOnDeleteTriggers` since backlex keeps no DB-level FKs.
   */
  onDelete?: "set_null" | "cascade" | "no_action";
  /**
   * Display formatting hint — purely how the admin RENDERS the value in lists /
   * detail views. Never touches storage, the API, sorting or filtering (those
   * always use the raw value). Number options apply to `integer` / `number`;
   * `dateStyle` to `timestamp`; `prefix` / `suffix` to any.
   */
  format?: {
    /** integer/number: plain (raw), decimal (grouped), currency, percent. */
    style?: "plain" | "decimal" | "currency" | "percent";
    /** Fixed number of fraction digits. */
    precision?: number;
    /** ISO 4217 code (e.g. "USD", "TRY") — only for style: "currency". */
    currency?: string;
    /** Group thousands (1,234) for decimal style. */
    thousandSeparator?: boolean;
    /** timestamp: relative ("3d ago"), or a fixed date/time rendering. */
    dateStyle?: "relative" | "date" | "datetime" | "time";
    /** Wrap the rendered value (e.g. prefix "≈", suffix " kg"). */
    prefix?: string;
    suffix?: string;
  };
  /**
   * Per-locale display label overrides, keyed by locale code (e.g.
   * `{ tr: "Fiyat", de: "Preis" }`). The admin resolves the label as
   * `translations[activeLocale] ?? label ?? name`. UI-only.
   */
  translations?: Record<string, string>;
  /**
   * When true, this field's *value* is stored per-locale in the collection's
   * `<physical_table>__i18n` sidecar table (one native-typed column, one row per
   * locale) instead of on the base table. Orthogonal to `type` — any type may be
   * localized except `computed` and `hash`. Reads collapse to `?locale=xx` with a
   * fallback to the workspace default; `?locale=*` returns the full `{locale:
   * value}` map. Mutually exclusive with `unique` and `computed`. See
   * {@link isLocalized}, `sidecarColumnDefSql`, and `docs/locale-timezone.md`.
   */
  localized?: boolean;
}

/** Resolve an auto-fill token to a concrete value for the write path. `now`
 *  should be the caller's canonical insert/update timestamp so a `now` column
 *  matches `created_at`/`updated_at`; a Date instance serializes cleanly on
 *  both dialects. Returns `undefined` when the needed context is absent (e.g.
 *  `user` with no authenticated user) so the column falls back to its default. */
export const resolveAutoFill = (
  kind: "uuid" | "now" | "user" | "tenant",
  ctx: { now: unknown; userId?: string | null; tenantId?: string | null },
): unknown => {
  switch (kind) {
    case "uuid":
      return crypto.randomUUID();
    case "now":
      return ctx.now;
    case "user":
      return ctx.userId ?? undefined;
    case "tenant":
      return ctx.tenantId ?? undefined;
  }
};

/** Field types that accept a literal column `DEFAULT`. */
const DEFAULTABLE: Set<FieldType> = new Set([
  "text",
  "longtext",
  "integer",
  "number",
  "boolean",
]);

/** Render a scalar default as a SQL literal for the given dialect. Booleans are
 *  `true`/`false` on PG and `1`/`0` on SQLite; numbers inline; strings quoted
 *  with `'` doubled. */
const defaultLiteral = (value: string | number | boolean, dialect: Dialect): string => {
  if (typeof value === "boolean") {
    return dialect === "pg" ? String(value) : value ? "1" : "0";
  }
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

const PG_TYPES: Record<FieldType, string> = {
  text: "varchar(255)",
  longtext: "text",
  integer: "bigint",
  number: "double precision",
  boolean: "boolean",
  json: "jsonb",
  timestamp: "timestamptz",
  uuid: "uuid",
  relation: "text",
  file: "text",
  relation_many: "jsonb",
  hash: "text",
  // Presentational — never reach the DDL (the applier filters them out); these
  // placeholders only satisfy the exhaustive Record<FieldType> mapping.
  divider: "text",
  notice: "text",
};

const SQLITE_TYPES: Record<FieldType, string> = {
  text: "TEXT",
  longtext: "TEXT",
  integer: "INTEGER",
  number: "REAL",
  boolean: "INTEGER",
  json: "TEXT",
  timestamp: "INTEGER",
  uuid: "TEXT",
  relation: "TEXT",
  file: "TEXT",
  relation_many: "TEXT",
  hash: "TEXT",
  // Presentational — see PG_TYPES note; never emitted as DDL.
  divider: "TEXT",
  notice: "TEXT",
};

export const sqlTypeFor = (type: FieldType, dialect: Dialect): string =>
  dialect === "pg" ? PG_TYPES[type] : SQLITE_TYPES[type];

// Identifiers must be lowercase snake_case. A leading underscore is allowed
// for the system columns we emit internally (`_status`, `_published_at`);
// user-supplied field names go through `validateFieldName` separately and
// keep the stricter "must start with a letter" rule there.
const IDENT = /^[a-z_][a-z0-9_]*$/;

export const assertIdent = (name: string): string => {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
};

export const quote = (name: string): string => `"${assertIdent(name)}"`;

/**
 * Compute the physical table name for a collection in a given tenant.
 * Format: `c_<tenantPrefix12>_<slug>` so two workspaces can independently
 * own a collection with the same slug. The tenant prefix is the first 12
 * hex chars of the tenant id (dashes stripped) — 48 bits is plenty given
 * realistic workspace counts, and keeps the table name well under PG's
 * 63-char identifier cap.
 *
 * Legacy rows created before per-workspace collections (when the table
 * was `c_<slug>` globally) keep their original name in `collections.
 * physical_table`. Always read that column rather than recomputing.
 */
export const derivePhysicalTable = (tenantId: string, slug: string): string => {
  const prefix = tenantId.replace(/-/g, "").slice(0, 12).toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(prefix)) {
    throw new Error(`Invalid tenant id for physical table: ${tenantId}`);
  }
  return `c_${prefix}_${assertIdent(slug)}`;
};

/** @deprecated Pre-tenant naming. Used only by the migration backfill. */
export const legacyPhysicalTableFor = (slug: string): string => `c_${assertIdent(slug)}`;

/**
 * Name of the SQLite FTS5 shadow table that mirrors a collection's
 * `searchable` text for keyword search. One per physical table; holds
 * `(item_id, content)`. (Postgres keeps the index inline as a `_fts`
 * tsvector column instead — no shadow table.) Always derive it from the
 * physical table name so the items + search paths agree.
 */
export const ftsTableName = (physicalTable: string): string =>
  `${assertIdent(physicalTable)}__fts`;

/**
 * Name of the per-locale *translations sidecar* table for a collection with
 * `localized` fields. One row per `(base row, locale)`; one native-typed column
 * per localized field. Always derive it from the base physical table name so the
 * items read/write paths and the schema applier agree. Mirrors the FTS shadow
 * table (`ftsTableName`) but exists on both dialects.
 */
export const i18nTableName = (physicalTable: string): string =>
  `${assertIdent(physicalTable)}__i18n`;

const RESERVED = new Set([
  "id",
  "owner_id",
  "created_at",
  "updated_at",
]);

export const isReservedField = (name: string): boolean => RESERVED.has(name);

// User-supplied field names must start with a letter — `_*` is reserved
// for our own system columns (`_status`, `_published_at`).
const USER_FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Generated-column expressions are spliced RAW into DDL by `columnDefSql`
 * (`GENERATED ALWAYS AS (<formula>) STORED`), so a hostile formula could close
 * the parenthesis early and append arbitrary statements. The public create/
 * patch routes strip `computed` (it isn't in their zod schema), so the only
 * reachable path today is admin-gated backup-restore — but validate defensively
 * in the central field validator so no future surface (MCP / CLI / import) can
 * turn a formula into a DDL-injection sink. These checks only block break-out;
 * the expression's semantics stay the admin's responsibility.
 */
const validateComputedFormula = (name: string, raw: unknown): void => {
  if (typeof raw !== "string") {
    throw new Error(`Field "${name}": computed.formula must be a string`);
  }
  const f = raw.trim();
  if (!f) throw new Error(`Field "${name}": computed.formula cannot be empty`);
  if (f.length > 500) {
    throw new Error(`Field "${name}": computed.formula is too long (max 500 chars)`);
  }
  if (f.includes(";")) {
    throw new Error(`Field "${name}": computed.formula may not contain ";"`);
  }
  if (/--|\/\*|\*\/|#/.test(f)) {
    throw new Error(`Field "${name}": computed.formula may not contain SQL comments`);
  }
  // Balanced parentheses, never closing more than opened — the canonical
  // break-out (`0) STORED); DROP …`) closes the GENERATED-AS paren early.
  let depth = 0;
  for (const ch of f) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`Field "${name}": unbalanced ")" in computed.formula`);
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`Field "${name}": unbalanced parentheses in computed.formula`);
  }
  // Conservative character allow-list: identifiers, numbers, string literals,
  // arithmetic / concat / comparison operators, and grouping. Nothing that
  // could start a new statement or a comment survives the checks above anyway.
  if (!/^[A-Za-z0-9_\s+\-*/%(),.'"|<>=!:]+$/.test(f)) {
    throw new Error(
      `Field "${name}": computed.formula contains disallowed characters`,
    );
  }
  // A generated expression never needs DDL/DML keywords.
  if (
    /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|GRANT|REVOKE|ATTACH|DETACH|PRAGMA|UNION|SELECT|VACUUM)\b/i.test(
      f,
    )
  ) {
    throw new Error(
      `Field "${name}": computed.formula may not contain SQL statement keywords`,
    );
  }
};

/** Walk a Condition and collect the field keys it references (relation
 *  dot-paths contribute their head segment). Used to validate that a field
 *  condition's rule only names real columns. */
export const collectConditionFields = (cond: unknown, out: Set<string>): void => {
  if (!cond || typeof cond !== "object") return;
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.$and)) {
    for (const s of c.$and) collectConditionFields(s, out);
    return;
  }
  if (Array.isArray(c.$or)) {
    for (const s of c.$or) collectConditionFields(s, out);
    return;
  }
  if (c.$not !== undefined) {
    collectConditionFields(c.$not, out);
    return;
  }
  for (const k of Object.keys(c)) {
    if (k.startsWith("$")) continue;
    out.add(k.split(".")[0]!);
  }
};

/** Collect `$field.<name>` references appearing as comparison *values* in a
 *  rule (head segment for dotted paths). Complements `collectConditionFields`,
 *  which only sees the left-hand field keys. */
const collectFieldVarRefs = (node: unknown, out: Set<string>): void => {
  if (typeof node === "string") {
    if (node.startsWith("$field.")) {
      out.add(node.slice("$field.".length).split(".")[0]!);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) collectFieldVarRefs(x, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const x of Object.values(node)) collectFieldVarRefs(x, out);
  }
};

export const validateFields = (fields: FieldDef[]): void => {
  const seen = new Set<string>();
  const names = new Set(fields.map((f) => f.name));
  for (const f of fields) {
    if (!USER_FIELD_NAME.test(f.name)) {
      throw new Error(
        `Invalid field name "${f.name}" — must be snake_case and start with a letter`,
      );
    }
    if (RESERVED.has(f.name)) {
      throw new Error(`Field name "${f.name}" is reserved (system column)`);
    }
    if (seen.has(f.name)) {
      throw new Error(`Duplicate field name: ${f.name}`);
    }
    seen.add(f.name);
    // Presentational blocks (divider / notice) own no column, so every
    // storage-oriented flag is meaningless — reject them so the stored schema
    // stays honest, then skip the column-shaped checks below.
    if (isPresentational(f)) {
      for (const [flag, on] of [
        ["required", f.required],
        ["unique", f.unique],
        ["indexed", f.indexed],
        ["localized", f.localized],
        ["searchable", f.searchable],
        ["vectorize", f.vectorize],
        ["default", f.default !== undefined],
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["to", !!f.to],
        ["onCreate", !!f.onCreate],
        ["onUpdate", !!f.onUpdate],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a ${f.type} field`);
        }
      }
      continue;
    }
    if (f.type === "relation" || f.type === "relation_many") {
      if (!f.to) {
        throw new Error(
          `Relation field "${f.name}" must specify "to" (target collection slug)`,
        );
      }
      assertIdent(f.to);
    }
    if (f.type === "hash") {
      // A hashed secret is one-way and salted, so most column flags are
      // meaningless or actively unsafe on it:
      //  - unique/indexed: a salted digest differs every write, so a UNIQUE
      //    constraint never collides and a plain index only helps a query
      //    path we deliberately reject (see below) — it's a probing surface.
      //  - searchable/vectorize: would fold the digest into an FTS/embedding
      //    index that leaks it back out.
      //  - default: a literal default hash is nonsensical.
      //  - computed: a generated digest can't take a plaintext write.
      for (const [flag, on] of [
        ["unique", f.unique],
        ["indexed", f.indexed],
        ["searchable", f.searchable],
        ["vectorize", f.vectorize],
        ["default", f.default !== undefined],
        ["computed", !!f.computed],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a hash field`);
        }
      }
    }
    if (f.localized) {
      // A localized field's value lives in the `<table>__i18n` sidecar as one
      // nullable native-typed column per locale. Several flags are incompatible
      // with that model:
      //  - computed: a generated column references base-table columns, can't
      //    live per-locale in the sidecar.
      //  - hash: write-only salted digests are meaningless per-locale.
      //  - unique: uniqueness is on `(row_id, locale)`; a per-column UNIQUE
      //    collides with multi-locale rows.
      //  - onCreate/onUpdate: server auto-fill has no locale context.
      if (f.computed) {
        throw new Error(`Field "${f.name}": a computed field cannot be localized`);
      }
      if (f.type === "hash") {
        throw new Error(`Field "${f.name}": a hash field cannot be localized`);
      }
      if (f.unique) {
        throw new Error(`Field "${f.name}": a localized field cannot be "unique"`);
      }
      if (f.onCreate || f.onUpdate) {
        throw new Error(
          `Field "${f.name}": "onCreate"/"onUpdate" cannot combine with "localized"`,
        );
      }
    }
    if (f.computed) {
      validateComputedFormula(f.name, (f.computed as { formula?: unknown }).formula);
    }
    if (f.rollup) {
      // A rollup column is the server's to write, so every flag that either
      // implies a client write or a second writer of the same column is out:
      //  - computed: a generated column takes no UPDATE at all, and the two
      //    mean opposite things (same-row expression vs other-row aggregate).
      //  - localized: the aggregate is one number for the row, not per-locale.
      //  - required/unique: NOT NULL would reject the parent INSERT that
      //    precedes its first child, and two parents may well share a total.
      //  - default: the neutral value is derived from `fn`, not chosen.
      //  - onCreate/onUpdate/searchable/vectorize: auto-fill and text indexing
      //    have no meaning on a number nobody types.
      for (const [flag, on] of [
        ["computed", !!f.computed],
        ["localized", !!f.localized],
        ["required", !!f.required],
        ["unique", !!f.unique],
        ["default", f.default !== undefined],
        ["onCreate", !!f.onCreate],
        ["onUpdate", !!f.onUpdate],
        ["searchable", !!f.searchable],
        ["vectorize", !!f.vectorize],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a rollup field`);
        }
      }
      validateRollupSpec(f.name, f);
    }
    // Auto-fill tokens (onCreate/onUpdate) must suit the column's storage type,
    // and can't sit on a generated column (a computed column takes no writes).
    for (const [prop, kind] of [
      ["onCreate", f.onCreate],
      ["onUpdate", f.onUpdate],
    ] as const) {
      if (!kind) continue;
      if (f.computed) {
        throw new Error(`Field "${f.name}": "${prop}" is not allowed on a computed column`);
      }
      if (f.type === "hash") {
        throw new Error(`Field "${f.name}": "${prop}" is not allowed on a hash field`);
      }
      if (kind === "now" && f.type !== "timestamp") {
        throw new Error(`Field "${f.name}": "${prop}: now" requires a timestamp field`);
      }
      if (kind === "uuid" && f.type !== "uuid" && f.type !== "text") {
        throw new Error(`Field "${f.name}": "${prop}: uuid" requires a uuid or text field`);
      }
      if ((kind === "user" || kind === "tenant") && f.type !== "text" && f.type !== "uuid") {
        throw new Error(`Field "${f.name}": "${prop}: ${kind}" requires a text or uuid field`);
      }
    }
    // ON DELETE actions apply to relation / relation_many FKs.
    if (
      f.onDelete &&
      f.onDelete !== "no_action" &&
      f.type !== "relation" &&
      f.type !== "relation_many"
    ) {
      throw new Error(`Field "${f.name}": "onDelete" only applies to a relation field`);
    }
    if (f.interface === "dropdown" && getChoiceValues(f).length === 0) {
      throw new Error(
        `Field "${f.name}": dropdown interface requires options.choices (or legacy options.values)`,
      );
    }
    // The "user" interface stores a workspace end-user id (`app_users.id`) in
    // a plain text column — no new storage type. Referential integrity is
    // enforced on item write (see validateAppUserLinks in the items service).
    if (f.interface === "user" && f.type !== "text") {
      throw new Error(`Field "${f.name}": the "user" interface requires a text field`);
    }
    if (f.visibleWhen) {
      if (!names.has(f.visibleWhen.field)) {
        throw new Error(
          `Field "${f.name}": visibleWhen.field "${f.visibleWhen.field}" not found`,
        );
      }
      if (f.visibleWhen.field === f.name) {
        throw new Error(
          `Field "${f.name}": visibleWhen cannot reference itself`,
        );
      }
    }
    if (f.conditions !== undefined) {
      if (!Array.isArray(f.conditions)) {
        throw new Error(`Field "${f.name}": conditions must be an array`);
      }
      for (const cond of f.conditions) {
        if (!cond || typeof cond !== "object" || typeof cond.rule !== "object" || cond.rule === null) {
          throw new Error(`Field "${f.name}": each condition needs a "rule" object`);
        }
        const refs = new Set<string>();
        collectConditionFields(cond.rule, refs);
        for (const r of refs) {
          if (!names.has(r) && !isReservedField(r)) {
            throw new Error(
              `Field "${f.name}": condition rule references unknown field "${r}"`,
            );
          }
        }
      }
    }
    if (f.validation) {
      const val = f.validation;
      const textish =
        f.type === "text" || f.type === "longtext" || f.type === "hash";
      if (val.format && !textish) {
        throw new Error(
          `Field "${f.name}": validation.format only applies to text fields`,
        );
      }
      if (val.integer && f.type !== "integer" && f.type !== "number") {
        throw new Error(
          `Field "${f.name}": validation.integer only applies to number fields`,
        );
      }
      if (
        (val.minDate !== undefined || val.maxDate !== undefined) &&
        f.type !== "timestamp"
      ) {
        throw new Error(
          `Field "${f.name}": validation.minDate/maxDate only apply to timestamp fields`,
        );
      }
      if (
        (val.minSelect !== undefined || val.maxSelect !== undefined) &&
        f.type !== "relation_many"
      ) {
        throw new Error(
          `Field "${f.name}": validation.minSelect/maxSelect only apply to relation_many fields`,
        );
      }
      if (val.min !== undefined && val.max !== undefined && val.min > val.max) {
        throw new Error(`Field "${f.name}": validation.min must be ≤ max`);
      }
      if (
        val.minLength !== undefined &&
        val.maxLength !== undefined &&
        val.minLength > val.maxLength
      ) {
        throw new Error(`Field "${f.name}": validation.minLength must be ≤ maxLength`);
      }
      if (
        val.minSelect !== undefined &&
        val.maxSelect !== undefined &&
        val.minSelect > val.maxSelect
      ) {
        throw new Error(`Field "${f.name}": validation.minSelect must be ≤ maxSelect`);
      }
      if (val.regex !== undefined) {
        try {
          new RegExp(val.regex);
        } catch {
          throw new Error(
            `Field "${f.name}": validation.regex is not a valid regular expression`,
          );
        }
      }
      if (val.rule !== undefined) {
        if (
          typeof val.rule !== "object" ||
          val.rule === null ||
          Array.isArray(val.rule)
        ) {
          throw new Error(
            `Field "${f.name}": validation.rule must be a condition object`,
          );
        }
        const refs = new Set<string>();
        collectConditionFields(val.rule, refs);
        collectFieldVarRefs(val.rule, refs);
        for (const r of refs) {
          if (!names.has(r) && !isReservedField(r)) {
            throw new Error(
              `Field "${f.name}": validation.rule references unknown field "${r}"`,
            );
          }
        }
      }
    }
  }
};

/** Canonical built-in format patterns for `validation.format`. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#][^\s]*$/i;

/** Shift `base` (epoch-ms) by a duration. Calendar-aware for years/months so
 *  `$now - 1 month` lands on the right day-of-month. */
const shiftByDuration = (base: number, parts: DurationParts, sign: 1 | -1): number => {
  const d = new Date(base);
  if (parts.years) d.setUTCFullYear(d.getUTCFullYear() + sign * parts.years);
  if (parts.months) d.setUTCMonth(d.getUTCMonth() + sign * parts.months);
  if (parts.weeks) d.setUTCDate(d.getUTCDate() + sign * parts.weeks * 7);
  if (parts.days) d.setUTCDate(d.getUTCDate() + sign * parts.days);
  if (parts.hours) d.setUTCHours(d.getUTCHours() + sign * parts.hours);
  if (parts.minutes) d.setUTCMinutes(d.getUTCMinutes() + sign * parts.minutes);
  if (parts.seconds) d.setUTCSeconds(d.getUTCSeconds() + sign * parts.seconds);
  return d.getTime();
};

/** Coerce a date-ish value (epoch-ms number, ISO string, `"$now"`, or a
 *  relative-now object) to epoch-ms. Returns null when it can't be parsed. */
const toEpochMs = (v: unknown, now: number): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (v === "$now") return now;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "object") {
    const rn = (v as RelativeNow).$now;
    if (rn) {
      let t = now;
      if (rn.add) t = shiftByDuration(t, rn.add, 1);
      if (rn.sub) t = shiftByDuration(t, rn.sub, -1);
      return t;
    }
  }
  return null;
};

/**
 * Validates an incoming item value against the field's soft rules. Throws
 * a string-message Error on the first violation; route handlers map to 422.
 * Skips null/undefined/"" unless `required` (caller checks separately). A
 * `validation.message` overrides the generated text for every failure on the
 * field. Cross-field rules are NOT checked here (they need the whole row) —
 * see `enforceValidationRules` in the items service. `now` is injectable for
 * deterministic date-bound tests.
 */
export const validateValue = (
  field: FieldDef,
  value: unknown,
  now: number = Date.now(),
): void => {
  if (value === null || value === undefined || value === "") return;

  const v = field.validation;
  const fail = (msg: string): never => {
    throw new Error(v?.message ?? msg);
  };

  // Dropdown choice membership is enforced for any field with the interface
  // set, even when no `validation` block is configured.
  if (field.interface === "dropdown") {
    const allowed = getChoiceValues(field);
    if (allowed.length && !allowed.includes(String(value))) {
      fail(`${field.name}: must be one of ${allowed.join(", ")}`);
    }
  }

  if (!v) return;
  // Advisory validation is not enforced here — the write path collects it into
  // the response `warnings` instead (see collectFieldWarnings).
  if (v.severity && v.severity !== "error") return;

  if (
    // `hash` validates the *plaintext* here — this runs in `validateBody`
    // before the API replaces the value with its digest, so length/pattern
    // rules (password policy) apply to what the user actually typed.
    (field.type === "text" || field.type === "longtext" || field.type === "hash") &&
    typeof value === "string"
  ) {
    if (v.minLength !== undefined && value.length < v.minLength) {
      fail(`${field.name}: must be at least ${v.minLength} characters`);
    }
    if (v.maxLength !== undefined && value.length > v.maxLength) {
      fail(`${field.name}: must be at most ${v.maxLength} characters`);
    }
    if (v.format === "email" && !EMAIL_RE.test(value)) {
      fail(`${field.name}: must be a valid email address`);
    }
    if (v.format === "url" && !URL_RE.test(value)) {
      fail(`${field.name}: must be a valid URL`);
    }
    if (v.regex) {
      let re: RegExp;
      try {
        re = new RegExp(v.regex);
      } catch {
        // Admin-config error, not a user-value error — never masked by `message`.
        throw new Error(`${field.name}: invalid validation regex`);
      }
      if (!re.test(value)) {
        fail(`${field.name}: doesn't match the required pattern`);
      }
    }
  }

  if (
    (field.type === "integer" || field.type === "number") &&
    typeof value === "number"
  ) {
    if (v.min !== undefined && value < v.min) fail(`${field.name}: must be ≥ ${v.min}`);
    if (v.max !== undefined && value > v.max) fail(`${field.name}: must be ≤ ${v.max}`);
    if (v.integer && !Number.isInteger(value)) {
      fail(`${field.name}: must be a whole number`);
    }
  }

  if (field.type === "timestamp" && (v.minDate !== undefined || v.maxDate !== undefined)) {
    const t = toEpochMs(value, now);
    if (t === null) {
      fail(`${field.name}: is not a valid date`);
    } else {
      const lo = toEpochMs(v.minDate, now);
      const hi = toEpochMs(v.maxDate, now);
      if (lo !== null && t < lo) fail(`${field.name}: is before the earliest allowed date`);
      if (hi !== null && t > hi) fail(`${field.name}: is after the latest allowed date`);
    }
  }

  if (field.type === "relation_many" && Array.isArray(value)) {
    if (v.minSelect !== undefined && value.length < v.minSelect) {
      fail(`${field.name}: select at least ${v.minSelect}`);
    }
    if (v.maxSelect !== undefined && value.length > v.maxSelect) {
      fail(`${field.name}: select at most ${v.maxSelect}`);
    }
  }
};

export const columnDefSql = (field: FieldDef, dialect: Dialect): string => {
  const type = sqlTypeFor(field.type, dialect);
  const parts = [quote(field.name), type];
  if (field.computed) {
    // Both PG and SQLite (3.31+) accept this exact syntax. The expression
    // is opaque to the validator — admins should test it before saving.
    parts.push(`GENERATED ALWAYS AS (${field.computed.formula}) STORED`);
    return parts.join(" ");
  }
  if (field.rollup) {
    // A plain column the refresh statement writes — NOT generated (no dialect
    // lets a generated expression read another table). The DEFAULT is derived
    // from the aggregate, not from `field.default` (rejected on rollups), so a
    // parent with no children yet already reads 0 for count/sum without any
    // refresh having run. avg/min/max stay NULL, which is what "no rows" means.
    const neutral = rollupNeutralValue(field.rollup.fn);
    if (neutral !== null) parts.push(`DEFAULT ${neutral}`);
    return parts.join(" ");
  }
  if (
    field.default !== undefined &&
    field.default !== null &&
    DEFAULTABLE.has(field.type)
  ) {
    parts.push(`DEFAULT ${defaultLiteral(field.default, dialect)}`);
  }
  if (field.required) parts.push("NOT NULL");
  if (field.unique) parts.push("UNIQUE");
  return parts.join(" ");
};

/**
 * Column DDL for a localized field *inside the sidecar* (`<table>__i18n`).
 * Emits the native storage type only — `required`/`unique`/`default`/`computed`
 * are all stripped: a locale row may set only some fields, so every sidecar
 * column must be nullable, and constraints/defaults/generated expressions make
 * no sense in the per-locale table (uniqueness lives on `(row_id, locale)`).
 * This is what lets any field type be localized with its native typing intact
 * (pg `bigint`/`timestamptz`/`jsonb`, sqlite `INTEGER`/`REAL`/`TEXT`).
 */
export const sidecarColumnDefSql = (field: FieldDef, dialect: Dialect): string =>
  `${quote(field.name)} ${sqlTypeFor(field.type, dialect)}`;
