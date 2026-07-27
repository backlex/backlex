/**
 * Sync **shapes** — the partial-replication primitive behind the changefeed.
 *
 * A shape is a *flat* `Condition` over the collection's own columns that names
 * the subset of rows a sync client wants to replicate ("my open orders", "this
 * project's tasks"). It reuses the canonical JSON filter grammar the list
 * endpoint already speaks, so there's no second query language to learn.
 *
 * Two deliberate restrictions distinguish a shape from a list `filter`:
 *
 *  - **Flat only.** Dotted relation hops (`customer.tier`) are rejected. A
 *    shape has to be re-evaluated for every changed row on every poll, and a
 *    relation hop makes membership depend on a *second* table that the
 *    changefeed's `(updated_at, id)` keyset doesn't watch — a target row
 *    changing would silently move rows in and out of the shape with no
 *    changefeed entry to carry the news. Rejecting the hop keeps membership a
 *    pure function of the row itself, which is what makes move-out detection
 *    sound.
 *  - **No hashed fields.** Same reason the list filter rejects them: a digest
 *    column would become a verification oracle.
 *
 * A shape is NOT a security boundary — permissions are. The shape narrows what
 * a client bothers to replicate; `perm.whereSql` still decides what it is
 * allowed to see, and it is AND-ed underneath every shape query.
 */

import { AppError, normalizeCondition, type AuthSubject, type Condition } from "@backlex/core";
import { compileCondition, type FieldDef } from "@backlex/db";
import type { SQL } from "drizzle-orm";

/** System columns a shape may reference on any collection. */
const SHAPE_SYSTEM_COLUMNS = ["id", "created_at", "updated_at"];
/** Extra columns only versioned collections actually have. */
const SHAPE_VERSIONED_COLUMNS = ["_status", "_published_at", "_publish_at"];

/** What `parseShape` needs to know about the target collection. */
export interface ShapeCollection {
  fields: FieldDef[];
  ownerScoped: boolean;
  versioned?: boolean;
}

/**
 * Reject anything a shape isn't allowed to reference: unknown columns, dotted
 * relation hops, hashed fields, and fields the caller's permission row doesn't
 * expose. `allowed` is the caller's readable-field set (null = unrestricted).
 */
const validateShapeFields = (
  cond: Condition,
  valid: Set<string>,
  fieldsByName: Map<string, FieldDef>,
): void => {
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.$and)) {
    for (const sub of c.$and) validateShapeFields(sub as Condition, valid, fieldsByName);
    return;
  }
  if (Array.isArray(c.$or)) {
    for (const sub of c.$or) validateShapeFields(sub as Condition, valid, fieldsByName);
    return;
  }
  if (c.$not !== undefined) {
    validateShapeFields(c.$not as Condition, valid, fieldsByName);
    return;
  }
  for (const k of Object.keys(c)) {
    if (k.includes(".")) {
      throw new AppError(
        "VALIDATION",
        `Sync shapes can't span relations: "${k}". Membership must depend only on the row itself, so the changefeed can tell when a row leaves the shape.`,
      );
    }
    if (!valid.has(k)) {
      throw new AppError("VALIDATION", `Cannot filter on field: ${k}`);
    }
    if (fieldsByName.get(k)?.type === "hash") {
      throw new AppError("VALIDATION", `Cannot filter on hashed field: ${k}`);
    }
  }
};

/** A parsed, validated shape plus the SQL fragment that tests membership. */
export interface ParsedShape {
  /** Canonical (normalized) condition — echoed back so clients can key a cursor on it. */
  condition: Condition;
  /** Boolean SQL expression: true when a row is *inside* the shape. */
  membershipSql: SQL;
}

/**
 * Parse the `shape` query parameter (a JSON `Condition`) into a validated
 * condition + membership predicate. Returns `null` when the caller sent no
 * shape, which means "replicate the whole collection" (the v1 behaviour).
 *
 * `permissionFields` is the caller's readable-field allow-list from
 * `requirePermission` — `null` means every field is readable.
 */
export const parseShape = (
  raw: string | undefined,
  collection: ShapeCollection,
  auth: AuthSubject,
  permissionFields: Set<string> | null,
  dialect: "pg" | "sqlite",
): ParsedShape | null => {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError("VALIDATION", "Invalid `shape` JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError("VALIDATION", "`shape` must be a filter object");
  }
  const condition = normalizeCondition(parsed);

  const fieldsByName = new Map(collection.fields.map((f) => [f.name, f]));
  const valid = new Set<string>(SHAPE_SYSTEM_COLUMNS);
  if (collection.ownerScoped) valid.add("owner_id");
  if (collection.versioned) for (const c of SHAPE_VERSIONED_COLUMNS) valid.add(c);
  for (const f of collection.fields) {
    // A field the caller can't read can't be shaped on either — otherwise the
    // in/out signal itself leaks the value.
    if (permissionFields && !permissionFields.has(f.name)) continue;
    valid.add(f.name);
  }
  validateShapeFields(condition, valid, fieldsByName);

  return {
    condition,
    membershipSql: compileCondition(condition, auth, undefined, undefined, { dialect }),
  };
};

/**
 * Stable identity for a shape, so a client can key its cursor on it and detect
 * that the shape changed (which forces a re-sync from scratch). Object keys are
 * sorted so two structurally identical shapes hash the same regardless of how
 * the caller wrote them.
 */
export const shapeKey = (condition: Condition | null): string => {
  if (!condition) return "all";
  const canonical = JSON.stringify(sortKeys(condition));
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return out;
};
