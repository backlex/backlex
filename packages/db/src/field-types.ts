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
  /** Localized text — JSON `{en, tr, …}`. Resolver swaps by `?locale=xx`. */
  | "i18n_text";

/** Soft validation rules — enforced at the API layer, not at the DB. */
export interface FieldValidation {
  /** Regex pattern (string-form, ECMA syntax). Applied to text/longtext. */
  regex?: string;
  /** Inclusive bounds for integer/number. */
  min?: number;
  max?: number;
  /** Length bounds for text/longtext. */
  minLength?: number;
  maxLength?: number;
}

/**
 * Optional UI hint that overrides the default editor for a field. Storage
 * shape is unchanged — `dropdown` still stores TEXT, `richtext` still
 * stores TEXT, `color` still stores TEXT.
 */
export type FieldInterface =
  | "dropdown"
  | "richtext"
  | "color";

/**
 * One option in a dropdown — Directus-shaped. `value` is what the column
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
  /** Per-choice metadata for `interface: dropdown` (Directus-shaped). */
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

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
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
  /** Conditional visibility in the form. Pure UI — no DB or API effect. */
  visibleWhen?: FieldVisibility;
  /** Group label for form section rendering. UI only. */
  group?: string;
  /**
   * SQL expression for a generated column. When present, the column is
   * created with `GENERATED ALWAYS AS (formula) STORED` and the items
   * routes reject writes to this field. Read-only end-to-end.
   */
  computed?: { formula: string };
}

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
  i18n_text: "jsonb",
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
  i18n_text: "TEXT",
};

export const sqlTypeFor = (type: FieldType, dialect: Dialect): string =>
  dialect === "pg" ? PG_TYPES[type] : SQLITE_TYPES[type];

const IDENT = /^[a-z][a-z0-9_]*$/;

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

const RESERVED = new Set([
  "id",
  "owner_id",
  "created_at",
  "updated_at",
]);

export const isReservedField = (name: string): boolean => RESERVED.has(name);

export const validateFields = (fields: FieldDef[]): void => {
  const seen = new Set<string>();
  const names = new Set(fields.map((f) => f.name));
  for (const f of fields) {
    assertIdent(f.name);
    if (RESERVED.has(f.name)) {
      throw new Error(`Field name "${f.name}" is reserved (system column)`);
    }
    if (seen.has(f.name)) {
      throw new Error(`Duplicate field name: ${f.name}`);
    }
    seen.add(f.name);
    if (f.type === "relation" || f.type === "relation_many") {
      if (!f.to) {
        throw new Error(
          `Relation field "${f.name}" must specify "to" (target collection slug)`,
        );
      }
      assertIdent(f.to);
    }
    if (f.interface === "dropdown" && getChoiceValues(f).length === 0) {
      throw new Error(
        `Field "${f.name}": dropdown interface requires options.choices (or legacy options.values)`,
      );
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
  }
};

/**
 * Validates an incoming item value against the field's soft rules. Throws
 * a string-message Error on the first violation; route handlers map to 422.
 * Skips null/undefined unless `required` (caller checks separately).
 */
export const validateValue = (field: FieldDef, value: unknown): void => {
  if (value === null || value === undefined || value === "") return;
  const v = field.validation;
  if (!v) return;

  if (
    (field.type === "text" || field.type === "longtext") &&
    typeof value === "string"
  ) {
    if (v.minLength !== undefined && value.length < v.minLength) {
      throw new Error(`${field.name}: must be at least ${v.minLength} characters`);
    }
    if (v.maxLength !== undefined && value.length > v.maxLength) {
      throw new Error(`${field.name}: must be at most ${v.maxLength} characters`);
    }
    if (v.regex) {
      try {
        const re = new RegExp(v.regex);
        if (!re.test(value)) {
          throw new Error(`${field.name}: doesn't match the required pattern`);
        }
      } catch (e) {
        if ((e as Error).message.startsWith(field.name)) throw e;
        throw new Error(`${field.name}: invalid validation regex`);
      }
    }
  }

  if (
    (field.type === "integer" || field.type === "number") &&
    typeof value === "number"
  ) {
    if (v.min !== undefined && value < v.min) {
      throw new Error(`${field.name}: must be ≥ ${v.min}`);
    }
    if (v.max !== undefined && value > v.max) {
      throw new Error(`${field.name}: must be ≤ ${v.max}`);
    }
  }

  if (field.interface === "dropdown") {
    const allowed = getChoiceValues(field);
    if (allowed.length && !allowed.includes(String(value))) {
      throw new Error(
        `${field.name}: must be one of ${allowed.join(", ")}`,
      );
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
  if (field.required) parts.push("NOT NULL");
  if (field.unique) parts.push("UNIQUE");
  return parts.join(" ");
};
