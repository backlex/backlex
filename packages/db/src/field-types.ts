import type { Condition, DurationParts, RelativeNow } from "@backlex/core";
import { type EmailSpec, parseEmailForField, validateEmailSpec } from "./email";
import { type GeoSpec, parseGeoPoint, validateGeoSpec } from "./geo";
import {
  currencyExponent,
  isDecimalStorage,
  type MoneySpec,
  parseMoneyInput,
  toMinorUnits,
  validateMoneySpec,
} from "./money";
import { type OrderSpec, validateOrderSpec } from "./order";
import { type SlugSpec, validateSlugSpec } from "./slug";
import { type RangeSpec, validateRangeSpec } from "./range";
import {
  assertPhoneShaped,
  type PhoneSpec,
  parsePhoneForField,
  validatePhoneSpec,
} from "./phone";
import { type SequenceSpec, validateSequenceSpec } from "./sequence";
import { type TransitionSpec, validateTransitionSpec } from "./transitions";
import { isUrlWithScheme, type UrlSpec, parseUrlForField, validateUrlSpec } from "./url";

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
   * A point on the earth — `{ lat, lng }`, stored as TEXT/JSONB like `json`.
   * The `_near` filter operator asks which rows are within a radius of an
   * origin, and sorting by the field orders by distance from that same origin.
   * See {@link GeoSpec} and `packages/db/src/geo.ts`.
   */
  | "geo"
  /**
   * An amount of money — an integer count of the currency's minor units in a
   * `bigint`/`INTEGER` column, read and written as major units paired with the
   * currency they are denominated in (`{ amount: 19.99, currency: "USD" }`).
   *
   * The currency is fixed on the field or read from a sibling text column; the
   * exponent follows ISO-4217, so `1000 JPY` stores `1000` and `1.234 KWD`
   * stores `1234`. Aggregating amounts in different currencies is refused
   * rather than answered. See {@link MoneySpec} and `packages/db/src/money.ts`.
   */
  | "money"
  /**
   * A phone number, stored as canonical E.164 (`+905321112233`) in the same
   * `TEXT`/`varchar` column a plain `text` field uses — so an existing phone
   * column becomes one of these without a migration.
   *
   * Whatever an operator types (`0532 111 22 33`, `(532) 111-2233`,
   * `+90 532 111 2233`) is parsed against the field's region and canonicalized
   * on the way in, which is what makes `unique` mean something, makes a lookup
   * by the number a caller reads out loud actually match, and makes the value
   * safe to hand an SMS provider. See {@link PhoneSpec} and
   * `packages/db/src/phone.ts`.
   */
  | "phone"
  /**
   * An email address, stored canonical (trimmed, folded, and with an
   * internationalized domain in its A-label form) in the same `TEXT`/`varchar`
   * column a plain `text` field uses — so an existing email column becomes one
   * of these without a migration.
   *
   * Whatever an operator types or pastes (`  Ada@Example.COM `,
   * `<ada@example.com>`, `ada@örnek.com`) is folded on the way in, which is what
   * makes `unique` mean one mailbox, makes a lookup by the address a customer
   * types actually match, and makes the value safe to hand a mail server. It is
   * also the one validator the send paths share, so an address that passes here
   * cannot be refused later by the thing that was supposed to mail it. See
   * {@link EmailSpec} and `packages/db/src/email.ts`.
   */
  | "email"
  /**
   * A web address, stored in a canonical serialization in the same
   * `TEXT`/`varchar` column a plain `text` field uses — so an existing URL
   * column becomes one of these without a migration.
   *
   * Whatever an operator types (`acme.com`, `HTTPS://Acme.COM`,
   * `https://acme.com:443`) is folded on the way in: the scheme is supplied when
   * it is missing and lowercased, the host is lowercased and encoded to its
   * A-labels, a default port is dropped, and dot segments are resolved. That is
   * what makes `unique` mean one endpoint, makes a lookup by the address someone
   * reads off a page actually match, and makes the value safe to hand a fetch.
   *
   * With `form: "host"` the column holds a bare registrable host (`acme.com`)
   * instead — for the columns a CRM matches a company by, which are a domain and
   * not an address. See {@link UrlSpec} and `packages/db/src/url.ts`.
   */
  | "url"
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
  // A `{ lat, lng }` point, stored like `json`. Filterable with `_near`,
  // sortable by distance from that same origin.
  "geo",
  // An amount in minor units, read and written as major units plus the
  // currency they are denominated in.
  "money",
  // Canonical E.164 in an ordinary text column — parsed from whatever the
  // operator typed, against the field's region.
  "phone",
  // A canonical address in an ordinary text column — trimmed, folded, and with
  // an internationalized domain encoded to the A-labels a mail server resolves.
  "email",
  // A canonical web address in an ordinary text column — scheme supplied and
  // lowercased, host lowercased and encoded to A-labels, default port dropped.
  "url",
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
  if (field.type !== "integer" && field.type !== "number" && field.type !== "money") {
    throw new Error(
      `Field "${name}": a rollup field must be type integer, number or money (got "${field.type}")`,
    );
  }
  if (spec.fn === "count" && field.type === "money") {
    // A count of rows is not an amount of money, and storing it in a money
    // column would print it with a currency symbol.
    throw new Error(
      `Field "${name}": rollup.fn "count" counts rows — use an integer field, not money`,
    );
  }
  if (spec.fn === "avg" && field.type === "money") {
    // An average lands between two minor units far more often than not, and a
    // money column is an integer count of them — storing the average would
    // truncate a fraction of a cent per parent, silently and forever.
    throw new Error(
      `Field "${name}": rollup.fn "avg" cannot write a money field — an average falls between minor units. Use a number field, or roll up the sum and the count.`,
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
   * Issue this column's value from a server-side counter on INSERT — a document
   * number like `INV-2026-0001`. See {@link SequenceSpec}.
   *
   * Read-only to clients on create AND update: the server owns the value, and a
   * document number that can be edited afterwards is not one. Unlike
   * {@link onCreate}, which resolves a fixed token, a sequence carries the
   * pattern, the padding and the reset period the series is numbered by.
   */
  sequence?: SequenceSpec;
  /**
   * Configuration for a `geo` field — which text columns a missing point can be
   * geocoded from, and where the admin's map opens. See {@link GeoSpec}.
   *
   * Optional even on a `geo` field: a bare one is a pair of coordinates the
   * operator supplies, and that is the common case.
   */
  geo?: GeoSpec;
  /**
   * Configuration for a `money` field — where its currency comes from, and how
   * the amount sits in the column. See {@link MoneySpec}.
   *
   * REQUIRED on a money field, unlike `geo`: an integer with no currency is the
   * situation this type exists to end, and there is no sensible default (an
   * assumed USD would silently misprice every non-dollar workspace).
   */
  money?: MoneySpec;
  /**
   * Declare that this `integer` field is the manual order of a list — the
   * position an operator arranged rows into. See {@link OrderSpec}.
   *
   * Nothing about the storage changes; the column stays an ordinary sortable
   * integer. What the declaration buys is that the server maintains it: a create
   * that omits the field APPENDS to the end of its list rather than landing on
   * the same 0 as everything else, a row whose scope changes re-appends to the
   * list it moved into, and `POST /:slug/reorder` moves one row without the
   * caller having to renumber the rows around it.
   */
  order?: OrderSpec;
  /**
   * Declare that this `text` field is a URL slug — the handle a row is
   * addressed by. See {@link SlugSpec}.
   *
   * Nothing about the storage changes; the column stays ordinary text. What the
   * declaration buys is that the server maintains it: a write that omits the
   * field folds one out of the row's own title, a value that IS supplied is
   * folded to the one canonical form rather than refused by a regex, and a
   * collision takes the next free suffix instead of failing at the database.
   *
   * Unlike {@link sequence}, the value stays writable: a slug is a decision an
   * operator is entitled to make, and the server only fills in the blank.
   */
  slug?: SlugSpec;
  /**
   * Declare that this `timestamp` field is the START of a period, and name the
   * column holding its end. See {@link RangeSpec}.
   *
   * Nothing about the storage changes — both columns stay ordinary timestamps,
   * sortable and filterable as themselves. What the declaration buys is the
   * `_overlaps` / `_covers` filter operators, correct treatment of a NULL
   * endpoint as an OPEN one, and a write-time check that the period is ordered.
   */
  range?: RangeSpec;
  /**
   * Configuration for a `phone` field — which country a national-form number is
   * read as, and which countries are allowed at all. See {@link PhoneSpec}.
   *
   * Optional, like `geo` and unlike `money`: a bare phone field accepts numbers
   * written in international form (`+90…`, `0090…`) and refuses national ones,
   * which is the only safe default. There is no region to assume, and assuming
   * one would silently route a number to another country.
   */
  phone?: PhoneSpec;
  /**
   * Configuration for an `email` field — whether the local part keeps its case,
   * and which domains are acceptable at all. See {@link EmailSpec}.
   *
   * Optional, like `phone` and unlike `money`: a bare email field accepts any
   * well-formed address and folds it, which is the right default — an address
   * book has no business refusing a domain it has not heard of.
   */
  email?: EmailSpec;
  /**
   * Configuration for a `url` field — whether the column holds a whole address
   * or a bare host, which schemes are acceptable, and which hosts are. See
   * {@link UrlSpec}.
   *
   * Optional, like `email`: a bare url field accepts any well-formed
   * `https`/`http` address and folds it, which is the right default — a
   * "Website" column has no business refusing a host it has not heard of.
   */
  url?: UrlSpec;
  /**
   * The lifecycle this dropdown field may move through — which value is allowed
   * to follow which, who may make the move, and what the row must carry for it.
   * See {@link TransitionSpec}.
   *
   * Unlike every other rule in this file, a transition judges the value the
   * field is changing FROM. Nothing else can: `validation.rule` and
   * {@link FieldCondition} both see only the row the write would produce.
   */
  transitions?: TransitionSpec;
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
    /**
     * integer/number: plain (raw), decimal (grouped), currency, or one of the
     * two percent renderings.
     *
     * The two exist because "percent" is ambiguous about what the COLUMN holds,
     * and picking wrong is off by a factor of a hundred:
     *
     *  - `percent` follows `Intl.NumberFormat`'s own convention — the value is a
     *    FRACTION, so `0.2` prints as `20%`.
     *  - `percent100` is for a column that already holds the percentage, so
     *    `20` prints as `20%`. This is what every schema template means: all
     *    fifteen of the genuinely-percentage columns validate `{min: 0, max:
     *    100}`, which says the stored number is 20 and not 0.2.
     *
     * `percent` is the older token and keeps its `Intl` meaning so no existing
     * workspace's rendering moves; `percent100` was added because the templates'
     * own convention had no way to be expressed and rendered `20` as `2,000%`.
     */
    style?: "plain" | "decimal" | "currency" | "percent" | "percent100";
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
  geo: "jsonb",
  // Minor units. `bigint` because an amount is a count, and because the whole
  // point of the type is that it does not go through a float. A `decimal`
  // storage money field overrides this — see `sqlTypeForField`.
  money: "bigint",
  // Deliberately IDENTICAL to `text`. A phone value is at most 16 characters,
  // but narrowing the column would turn "make this existing text column a phone
  // field" into an ALTER — and `applyCollection` is additive by design. Same
  // type means the conversion is metadata only.
  phone: "varchar(255)",
  // Same reasoning as `phone`, and it is what let all fifty-eight template email
  // columns convert at once: identical storage means the conversion is metadata.
  email: "varchar(255)",
  // `text`, NOT `varchar(255)` like `phone` and `email` — the one place this
  // type breaks their pattern, and deliberately. An address is capped at 254 by
  // RFC 5321 and a phone number at 16 by E.164, so for those the narrow column
  // and the validator agree. A URL has no such bound: a `canonical_url` or a
  // `tracking_url` with campaign parameters goes past 255 routinely, and several
  // of the template columns converting to this type are exactly those. Storing
  // them in a `varchar(255)` would let a value pass {@link parseUrl} and then be
  // refused by Postgres — the write-time/act-time disagreement this whole type
  // exists to end. The cost is that converting an EXISTING pg column from `text`
  // to `url` is a widening `ALTER` rather than pure metadata, and
  // `applyCollection` is additive so it does not perform one; a fresh workspace
  // gets `text` from the start. See `docs/urls.md`.
  url: "text",
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
  geo: "TEXT",
  // SQLite's INTEGER is 64-bit, so minor units are exact here too.
  money: "INTEGER",
  // See the PG note — same storage as `text` so a conversion needs no DDL.
  phone: "TEXT",
  // See the PG note — same storage as `text` so a conversion needs no DDL.
  email: "TEXT",
  // SQLite's TEXT is unbounded, so unlike Postgres there is nothing to trade —
  // the conversion from a `text` column really is metadata only here.
  url: "TEXT",
  hash: "TEXT",
  // Presentational — see PG_TYPES note; never emitted as DDL.
  divider: "TEXT",
  notice: "TEXT",
};

export const sqlTypeFor = (type: FieldType, dialect: Dialect): string =>
  dialect === "pg" ? PG_TYPES[type] : SQLITE_TYPES[type];

/**
 * Storage type for a field, honouring the one case where the type token alone
 * does not decide it: a `money` field in `decimal` storage keeps MAJOR units in
 * an ordinary numeric column, because that mode exists to sit on top of a
 * column an adopted table already had. Every other type answers exactly as
 * {@link sqlTypeFor}.
 */
export const sqlTypeForField = (field: FieldDef, dialect: Dialect): string =>
  field.type === "money" && isDecimalStorage(field.money)
    ? sqlTypeFor("number", dialect)
    : sqlTypeFor(field.type, dialect);

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
        ["sequence", !!f.sequence],
        ["geo", !!f.geo],
        ["money", !!f.money],
        ["order", !!f.order],
        ["transitions", !!f.transitions],
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
    if (f.sequence) {
      // A sequence column is issued by the server on INSERT, so anything that
      // implies a second writer — or a value the server cannot supply — is out:
      //  - computed/rollup: both already own the column's value, by a different
      //    rule; two owners means whichever ran last wins, silently.
      //  - localized: a document number is one string for the row. Per-locale
      //    invoice numbers would be different documents.
      //  - default: the server always writes a value, so a DDL default could
      //    only ever be dead weight — or worse, the value a failed allocation
      //    quietly falls back to.
      //  - onCreate/onUpdate: `onCreate` is the mechanism this replaces, and
      //    `onUpdate` would rewrite the number after it had been issued.
      //  - vectorize: embedding a serial number matches everything and nothing.
      for (const [flag, on] of [
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["localized", !!f.localized],
        ["default", f.default !== undefined],
        ["onCreate", !!f.onCreate],
        ["onUpdate", !!f.onUpdate],
        ["vectorize", !!f.vectorize],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a sequence field`);
        }
      }
      // `required` and `unique` are deliberately ALLOWED, and both are worth
      // having: the server fills the column on every insert, so NOT NULL can
      // never reject a write, and UNIQUE is the backstop that turns a mistake
      // in the pattern (a reset with no date token, a hand-restored counter
      // row) into a failed insert instead of two documents with one number.
      // `searchable` is allowed too — finding an order by its number is the
      // single most common reason to search a collection at all.
      validateSequenceSpec(f.name, f);
    }
    if (f.geo && f.type !== "geo") {
      throw new Error(`Field "${f.name}": "geo" configuration requires a geo field`);
    }
    if (f.type === "geo") {
      // A point is a two-number object, so the flags that assume a scalar
      // column are meaningless on it:
      //  - unique/indexed: a plain B-tree over a JSON blob orders by its text,
      //    which answers no question anyone asks of a coordinate. `_near` is a
      //    scan by design (docs/geo.md says so); an index that helps would have
      //    to be an expression index, which is not portable to SQLite.
      //  - searchable/vectorize: folding "41.0082,28.9784" into a keyword or
      //    embedding index matches on digits, which is noise.
      //  - default: a literal DDL default would put every row at one place.
      //  - computed/rollup/sequence: all three write scalars.
      //  - localized: a clinic is not somewhere else in French.
      for (const [flag, on] of [
        ["unique", !!f.unique],
        ["indexed", !!f.indexed],
        ["searchable", !!f.searchable],
        ["vectorize", !!f.vectorize],
        ["localized", !!f.localized],
        ["default", f.default !== undefined],
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["sequence", !!f.sequence],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a geo field`);
        }
      }
      if (f.geo) {
        // `geocodeFrom` is checked against the collection's OTHER field names,
        // so a typo fails at schema-save time rather than presenting as a
        // geocode that silently never fires.
        validateGeoSpec(
          f.geo,
          fields.filter((o) => o.name !== f.name).map((o) => o.name),
        );
        if (f.geo.geocodeFrom?.includes(f.name)) {
          throw new Error(`Field "${f.name}": "geocodeFrom" cannot include the geo field itself`);
        }
      }
    }
    if (f.money && f.type !== "money") {
      throw new Error(`Field "${f.name}": "money" configuration requires a money field`);
    }
    if (f.type === "money") {
      // An amount is a scalar, so most flags behave — `indexed` and `unique`
      // work on the integer column exactly as they would on `integer`, and
      // sorting/filtering are ordinary comparisons. The ones that are out:
      //  - searchable/vectorize: folding "1999" into a keyword or embedding
      //    index matches on digits, which is noise.
      //  - localized: a price is not a different amount in French. A per-locale
      //    price list is a per-locale ROW, or a second column.
      //  - sequence: a document number is a string the server issues, and a
      //    money column would have to be both.
      for (const [flag, on] of [
        ["searchable", !!f.searchable],
        ["vectorize", !!f.vectorize],
        ["localized", !!f.localized],
        ["sequence", !!f.sequence],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a money field`);
        }
      }
      if (!f.money) {
        throw new Error(
          `Field "${f.name}": a money field needs a "money" configuration saying which currency it is in`,
        );
      }
      const fieldTypes: Record<string, string> = {};
      for (const o of fields) fieldTypes[o.name] = o.type;
      validateMoneySpec(f.money, { fieldTypes, fieldName: f.name });
      if (f.default !== undefined && f.default !== null) {
        if (typeof f.default !== "number") {
          throw new Error(
            `Field "${f.name}": a money default must be a number in major units (e.g. 0 or 9.99)`,
          );
        }
        if (f.money.currencyField && f.default !== 0) {
          // Zero is zero in every currency; anything else needs an exponent,
          // and this field's exponent is whatever each row's own code says.
          throw new Error(
            `Field "${f.name}": only a default of 0 is possible when the currency comes from "${f.money.currencyField}" — each row's currency decides how many decimals the default would have`,
          );
        }
        // Surface a malformed default here rather than as broken DDL.
        toMinorUnits(f.default, currencyExponent(f.money.currency, f.money));
      }
    }
    if (f.order) {
      // A position is an ordinary integer and stays one, so `indexed` and
      // `default` still behave — and `indexed` in particular is worth having,
      // since every read of an ordered list sorts by this column. What is out:
      for (const [flag, on] of [
        // All three already own the column's value by another rule. A position
        // is the operator's to arrange and the server's to renumber; a second
        // owner means whichever ran last wins, silently.
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["sequence", !!f.sequence],
        // A localized value lives in the sidecar, one row per locale — but the
        // append and the shift both compare BASE-table columns, so a per-locale
        // position would be invisible to every statement that maintains it. A
        // list is also not in a different order in French.
        ["localized", !!f.localized],
        // Positions ARE unique within a scope, but a column-level UNIQUE is
        // across the whole table — it would make two modules unable to both
        // have a first lesson. The uniqueness that matters is per-scope and is
        // maintained by the write path, not by a constraint.
        ["unique", !!f.unique],
        // Folding "3" into a keyword or embedding index matches every row that
        // holds a three, which is noise.
        ["searchable", !!f.searchable],
        ["vectorize", !!f.vectorize],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on an order field`);
        }
      }
      if (f.type !== "integer") {
        throw new Error(
          `Field "${f.name}": an order field is an integer position (got "${f.type}")`,
        );
      }
      const fieldTypes: Record<string, string> = {};
      for (const o of fields) if (o.name !== f.name) fieldTypes[o.name] = o.type;
      validateOrderSpec(f.order, { fieldName: f.name, fieldTypes });
    }
    if (f.slug) {
      // A slug is an ordinary text column with a maintained value, so most text
      // flags still apply — `unique` above all, which every one of the
      // twenty-four template slugs carries and which is the constraint that
      // actually arbitrates a collision. What is out:
      for (const [flag, on] of [
        // All three would own the column the slug resolver writes.
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["sequence", !!f.sequence],
        // A per-locale slug is a real thing to want, and this deliberately is
        // not it. A localized value lives in the sidecar, one row per locale,
        // while `unique` constrains the BASE column — so per-locale slugs would
        // be deduplicated against the wrong table and constrained by nothing.
        // Refused rather than half-supported; see docs/slugs.md.
        ["localized", !!f.localized],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a slug field`);
        }
      }
      if (f.type !== "text") {
        throw new Error(`Field "${f.name}": a slug is a text field (got "${f.type}")`);
      }
      const fieldTypes: Record<string, string> = {};
      const privateFields = new Set<string>();
      for (const o of fields) {
        if (o.name === f.name) continue;
        fieldTypes[o.name] = o.type;
        if (o.private) privateFields.add(o.name);
      }
      validateSlugSpec(f.slug, { fieldName: f.name, fieldTypes, privateFields });
    }
    if (f.range) {
      // A period is two ordinary timestamp columns with a declared relationship,
      // so the flags that make sense on a timestamp still do — `indexed` in
      // particular, since an overlap filter compares the start column and wants
      // it indexed. What is out:
      for (const [flag, on] of [
        // The value is a moment someone sets; none of these write moments, and
        // all three would own the column the period depends on.
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["sequence", !!f.sequence],
        // A localized value lives in the sidecar, one row per locale — but the
        // overlap rewrite compares two BASE-table columns, so a per-locale
        // period would be invisible to every query that asks about it.
        ["localized", !!f.localized],
        // Two rows may legitimately cover the same period; that is what an
        // overlap query exists to FIND, not something to forbid at the column.
        ["unique", !!f.unique],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a range field`);
        }
      }
      if (f.type !== "timestamp") {
        throw new Error(
          `Field "${f.name}": a range starts at a timestamp field (got "${f.type}")`,
        );
      }
      const fieldTypes: Record<string, string> = {};
      for (const o of fields) if (o.name !== f.name) fieldTypes[o.name] = o.type;
      validateRangeSpec(f.range, { fieldName: f.name, fieldTypes });
    }
    if (f.phone && f.type !== "phone") {
      throw new Error(`Field "${f.name}": "phone" configuration requires a phone field`);
    }
    if (f.type === "phone") {
      // A canonical number is an ordinary string in an ordinary text column, so
      // most flags behave exactly as they do on `text`. Two are worth calling
      // out as deliberately ALLOWED, because they are the point of the type:
      //  - unique: it finally means something. On a `text` phone column the
      //    same person written two ways collided with nothing; on a canonical
      //    one, one number is one row.
      //  - indexed / searchable: a lookup by number is the most common reason
      //    anyone opens a customer collection at all. Note that FTS folds in the
      //    CANONICAL token, so a search matches "+905321112233" and not a
      //    fragment of it — `phone: {_eq: "0532 111 22 33"}` is the query that
      //    works, and it works because the filter value is canonicalized too.
      // The ones that are out:
      for (const [flag, on] of [
        // A semantic embedding of a phone number matches on digits, which is noise.
        ["vectorize", !!f.vectorize],
        // A person's number is not a different number in French. A per-locale
        // phone is a second column, or a second row.
        ["localized", !!f.localized],
        // All three own the column's value by another rule, and none of them
        // produces something that goes through the E.164 parser.
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["sequence", !!f.sequence],
        // A DDL default would give every row that has not been filled in the
        // same real, dialable phone number — which is worse than empty.
        ["default", f.default !== undefined],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a phone field`);
        }
      }
      if (f.phone) {
        validatePhoneSpec(
          f.phone,
          fields.filter((o) => o.name !== f.name).map((o) => o.name),
        );
        if (f.phone.regionField === f.name) {
          throw new Error(`Field "${f.name}": "regionField" cannot be the phone field itself`);
        }
      }
    }
    if (f.email && f.type !== "email") {
      throw new Error(`Field "${f.name}": "email" configuration requires an email field`);
    }
    if (f.type === "email") {
      // A canonical address is an ordinary string in an ordinary text column, so
      // most flags behave exactly as they do on `text`. The ones that are the
      // POINT of the type, and therefore deliberately allowed:
      //  - unique: it finally means one mailbox. On a `text` email column
      //    `Ada@Example.com` and `ada@example.com` were two rows and one person,
      //    which is why `portal-links` had to wrap the column in `lower()` to
      //    find anything.
      //  - indexed / searchable: looking a person up by their address is the
      //    most common reason anyone opens a customer collection, and the index
      //    is usable now precisely because nothing has to fold the column first.
      // The ones that are out:
      for (const [flag, on] of [
        // An embedding of an address matches on domain and spelling, which is
        // noise — and it puts a real person's mailbox into a vector store.
        ["vectorize", !!f.vectorize],
        // A person's address is not a different address in French.
        ["localized", !!f.localized],
        // All three own the column's value by another rule, and none of them
        // produces something that goes through the address parser.
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["sequence", !!f.sequence],
        // A DDL default would give every row nobody has filled in the same real
        // person's mailbox — and then mail it.
        ["default", f.default !== undefined],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on an email field`);
        }
      }
      if (f.email) validateEmailSpec(f.email);
    }
    if (f.url && f.type !== "url") {
      throw new Error(`Field "${f.name}": "url" configuration requires a url field`);
    }
    if (f.type === "url") {
      // A canonical URL is an ordinary string in an ordinary text column, so most
      // flags behave exactly as they do on `text`. The ones that are the POINT of
      // the type, and therefore deliberately allowed:
      //  - unique: it finally means one endpoint. On a `text` column
      //    `https://acme.com` and `https://acme.com/` were two rows and one site.
      //  - indexed / searchable: the index is usable now precisely because
      //    nothing has to fold the column first.
      // The ones that are out:
      for (const [flag, on] of [
        // An embedding of a URL matches on host and path spelling, which is
        // noise — the page's CONTENT is what anyone means to search, and this
        // column does not hold it.
        ["vectorize", !!f.vectorize],
        // A web address is not a different address in French. A localized URL is
        // a real thing, but it is a different VALUE per locale, which is what a
        // per-locale column would have to store — and none of the folding above
        // would then describe the column.
        ["localized", !!f.localized],
        // All three own the column's value by another rule, and none of them
        // produces something that goes through the URL parser.
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["sequence", !!f.sequence],
      ] as const) {
        if (on) {
          throw new Error(`Field "${f.name}": "${flag}" is not allowed on a url field`);
        }
      }
      // A DDL default IS allowed, unlike on `email` — where it would give every
      // unfilled row the same real person's mailbox and then mail it. A default
      // website or a default docs link is an ordinary thing to want and reaches
      // nobody. It still has to be a URL the field would accept.
      if (f.default !== undefined) {
        if (typeof f.default !== "string") {
          throw new Error(`Field "${f.name}": a url field's default must be a string`);
        }
        try {
          parseUrlForField(f.default, f.url);
        } catch (e) {
          throw new Error(`Field "${f.name}": default ${(e as Error).message}`);
        }
      }
      if (f.url) validateUrlSpec(f.url);
    }
    if (f.transitions) {
      // A lifecycle is a rule about what a CALLER may write, so every flag that
      // takes the column away from the caller makes it meaningless:
      //  - computed/rollup/sequence: the server already owns the value, and it
      //    does not move along a graph the admin drew.
      //  - localized: a row is not in a different state in French. A per-locale
      //    status would give the same row two lifecycles at once.
      // The type has to be `text` because that is where a dropdown lives — the
      // spec's `from` and `to` are choice values, and no other type has any.
      for (const [flag, on] of [
        ["computed", !!f.computed],
        ["rollup", !!f.rollup],
        ["sequence", !!f.sequence],
        ["localized", !!f.localized],
      ] as const) {
        if (on) {
          throw new Error(
            `Field "${f.name}": "${flag}" is not allowed on a field with transitions`,
          );
        }
      }
      if (f.type !== "text") {
        throw new Error(
          `Field "${f.name}": transitions apply to a text dropdown (got "${f.type}")`,
        );
      }
      validateTransitionSpec(f.name, f.transitions, {
        choices: getChoiceValues(f),
        siblingFields: fields.filter((o) => o.name !== f.name).map((o) => o.name),
      });
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

/** Canonical built-in format pattern for `validation.format: "email"`.
 *
 *  There is no `URL_RE` beside it any more — `format: "url"` calls {@link isUrl},
 *  so the built-in URL check and the `url` field type cannot drift apart. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  // Shape, not policy — a `geo` value that isn't a coordinate pair is rejected
  // whether or not the field carries a `validation` block, because the column
  // it lands in is read back by the `_near` compiler as one. A latitude of 91
  // that reaches storage makes every subsequent distance query wrong, and
  // nothing downstream would flag it.
  if (field.type === "geo") {
    try {
      parseGeoPoint(value);
    } catch (e) {
      fail(`${field.name}: ${(e as Error).message}`);
    }
  }

  // Shape, not policy — like `geo` above, and for the same reason. A money
  // column is an integer count of minor units, and every reader of it (the sum
  // a rollup stores, the comparison a filter makes, the string the admin
  // prints) assumes that. A value that is not an amount must never reach it,
  // whether or not the field carries a `validation` block.
  //
  // The currency is NOT resolved here: `validateValue` sees one field, and a
  // per-row currency lives in a sibling column. What this proves is that the
  // value has an amount at all and that its precision fits — the write path's
  // `canonicalizeMoneyFields` does the resolution and re-parses against the
  // row's actual currency.
  if (field.type === "money") {
    try {
      parseMoneyInput(value, (code) => currencyExponent(code ?? field.money?.currency, field.money));
    } catch (e) {
      fail(`${field.name}: ${(e as Error).message}`);
    }
  }

  // Shape, not policy — like `geo` and `money` above. A phone column is read
  // back by the SMS surfaces as a dialable number, and by `unique` as an
  // identity; a value that is not one must never reach it.
  //
  // The per-row region is NOT resolved here, for the same reason money's
  // currency is not: `validateValue` sees one field, and `phone.regionField`
  // names a sibling column. So when the field defers to the row, this proves
  // only that the value is phone-SHAPED and leaves the region-dependent half to
  // the write path's `canonicalizePhoneFields`, which has the row. Parsing
  // strictly here would 422 a perfectly good national number purely because the
  // region it needs is one column over.
  if (field.type === "phone") {
    try {
      if (field.phone?.regionField && !field.phone.region) {
        assertPhoneShaped(value);
      } else {
        parsePhoneForField(value, field.phone);
      }
    } catch (e) {
      fail(`${field.name}: ${(e as Error).message}`);
    }
  }

  // Shape AND policy, unlike `phone` above — and the difference is that nothing
  // an email field needs lives in a sibling column. There is no per-row region
  // to defer, so the domain allow-list can be enforced right here, and a value
  // that reaches the column has already been judged completely.
  if (field.type === "email") {
    try {
      parseEmailForField(value, field.email);
    } catch (e) {
      fail(`${field.name}: ${(e as Error).message}`);
    }
  }

  // Shape AND policy, like `email` and for the same reason: nothing a url field
  // needs lives in a sibling column, so the scheme and host allow-lists are
  // enforced here and a value that reaches the column has been judged completely.
  if (field.type === "url") {
    try {
      parseUrlForField(value, field.url);
    } catch (e) {
      fail(`${field.name}: ${(e as Error).message}`);
    }
  }

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
    // `email` is here so an admin can still narrow the type with their own
    // `regex` or a length bound. `format: "email"` is redundant on one — the
    // type already enforces a stricter envelope than that check ever did.
    // `url` is here for the same reason as `email` — an admin may still want a
    // length bound of their own. `format: "url"` is redundant on one, and a
    // `regex` is worse than redundant: this runs on the RAW value, BEFORE the
    // fold, so a pattern demanding `^https://` refuses the bare `acme.com` the
    // type exists to accept. That is why the sixteen template columns converting
    // to this type drop their regex rather than keep it.
    (field.type === "text" ||
      field.type === "longtext" ||
      field.type === "hash" ||
      field.type === "email" ||
      field.type === "url") &&
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
    // One parser instead of a pattern of its own. This check and the `url` TYPE
    // now judge everything after the scheme identically, which is the point: the
    // five old answers disagreed about hosts, whitespace and credentials, so a
    // value could pass here and be refused by the thing that was supposed to
    // fetch it.
    //
    // `isUrlWithScheme`, though, NOT `isUrl` — this rule runs on a plain `text`
    // column where nothing folds, so accepting the type's `acme.com` shorthand
    // would let a value pass a check named "is this a URL" and then sit in the
    // column as a string that is not one. See the note on that function.
    if (v.format === "url" && !isUrlWithScheme(value)) {
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

  // `min`/`max` on a money field are written in MAJOR units — the same units
  // the bound reads in, so "at least 10.00" is `min: 10` whatever the exponent.
  // Comparing in minor units keeps the check exact.
  if (field.type === "money" && (v.min !== undefined || v.max !== undefined)) {
    const exponentFor = (code: string | null) =>
      currencyExponent(code ?? field.money?.currency, field.money);
    let bounds: { minor: number; min?: number; max?: number };
    try {
      const parsed = parseMoneyInput(value, exponentFor);
      const exponent = exponentFor(parsed.currency);
      bounds = {
        minor: parsed.minor,
        min: v.min === undefined ? undefined : toMinorUnits(v.min, exponent),
        max: v.max === undefined ? undefined : toMinorUnits(v.max, exponent),
      };
    } catch {
      // An unparseable VALUE already failed the shape check above, so anything
      // thrown here is a malformed BOUND — an admin-config error, which like
      // the invalid-regex case is never masked by `validation.message`.
      throw new Error(`${field.name}: invalid money bound in validation`);
    }
    if (bounds.min !== undefined && bounds.minor < bounds.min) {
      fail(`${field.name}: must be ≥ ${v.min}`);
    }
    if (bounds.max !== undefined && bounds.minor > bounds.max) {
      fail(`${field.name}: must be ≤ ${v.max}`);
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
  const type = sqlTypeForField(field, dialect);
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
  if (field.type === "money") {
    // A money default is written in MAJOR units like every other money value
    // the caller states, so it is scaled here rather than being taken as the
    // raw column contents — `DEFAULT 0` and `DEFAULT 9.99` would otherwise mean
    // zero and nine cents. `validateFields` has already refused a non-zero
    // default on a per-row-currency field, where no exponent is knowable.
    if (typeof field.default === "number" && !isDecimalStorage(field.money)) {
      const exponent = currencyExponent(field.money?.currency, field.money);
      parts.push(`DEFAULT ${toMinorUnits(field.default, exponent)}`);
    } else if (typeof field.default === "number") {
      parts.push(`DEFAULT ${defaultLiteral(field.default, dialect)}`);
    }
  } else if (
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
  `${quote(field.name)} ${sqlTypeForField(field, dialect)}`;
