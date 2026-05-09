import { AppError } from "@workeros/core";
import type { Condition } from "@workeros/core";
import type { FieldDef } from "@workeros/db";

export interface SortClause {
  field: string;
  dir: "asc" | "desc";
}

export interface ParsedQuery {
  filter: Condition | null;
  sort: SortClause[];
  fields: string[] | null;
  limit: number;
  offset: number;
  meta: { filterCount: boolean; totalCount: boolean };
}

const SYSTEM_COLUMNS = new Set(["id", "created_at", "updated_at"]);

const buildValidColumns = (
  fields: FieldDef[],
  ownerScoped: boolean,
): Set<string> => {
  const cols = new Set<string>(SYSTEM_COLUMNS);
  if (ownerScoped) cols.add("owner_id");
  for (const f of fields) cols.add(f.name);
  return cols;
};

const validateFilterFields = (
  cond: Condition,
  valid: Set<string>,
): void => {
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.$and)) {
    for (const sub of c.$and) validateFilterFields(sub as Condition, valid);
    return;
  }
  if (Array.isArray(c.$or)) {
    for (const sub of c.$or) validateFilterFields(sub as Condition, valid);
    return;
  }
  if (c.$not !== undefined) {
    validateFilterFields(c.$not as Condition, valid);
    return;
  }
  for (const k of Object.keys(c)) {
    if (!valid.has(k)) {
      throw new AppError("VALIDATION", `Cannot filter on field: ${k}`);
    }
  }
};

export const parseQuery = (
  params: URLSearchParams,
  fields: FieldDef[],
  ownerScoped: boolean,
  permissionFields: Set<string> | null,
): ParsedQuery => {
  const valid = buildValidColumns(fields, ownerScoped);
  // Permission allow-list narrows what user fields can be filtered/sorted/projected.
  // System columns are always allowed.
  const allowedForUser = new Set<string>(SYSTEM_COLUMNS);
  if (ownerScoped) allowedForUser.add("owner_id");
  for (const f of fields) {
    if (!permissionFields || permissionFields.has(f.name)) {
      allowedForUser.add(f.name);
    }
  }

  let filter: Condition | null = null;
  const filterRaw = params.get("filter");
  if (filterRaw) {
    try {
      filter = JSON.parse(filterRaw) as Condition;
    } catch {
      throw new AppError("VALIDATION", "Invalid `filter` JSON");
    }
    validateFilterFields(filter, allowedForUser);
  }

  const sortRaw = params.get("sort") ?? "-created_at";
  const sort: SortClause[] = sortRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const dir: "asc" | "desc" = s.startsWith("-") ? "desc" : "asc";
      const field = s.replace(/^[-+]/, "");
      if (!allowedForUser.has(field)) {
        throw new AppError("VALIDATION", `Cannot sort on field: ${field}`);
      }
      return { field, dir };
    });
  if (sort.length === 0) sort.push({ field: "created_at", dir: "desc" });

  let fieldsList: string[] | null = null;
  const fieldsRaw = params.get("fields");
  if (fieldsRaw) {
    fieldsList = fieldsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const f of fieldsList) {
      if (!valid.has(f)) {
        throw new AppError("VALIDATION", `Unknown field: ${f}`);
      }
      if (!allowedForUser.has(f)) {
        throw new AppError("FORBIDDEN", `No permission to read field: ${f}`);
      }
    }
  }

  const limit = Math.min(
    200,
    Math.max(1, Number(params.get("limit") ?? 50) || 50),
  );
  const offset = Math.max(0, Number(params.get("offset") ?? 0) || 0);

  const metaRaw = params.get("meta") ?? "";
  const metaParts = new Set(metaRaw.split(",").map((s) => s.trim()));
  const meta = {
    filterCount: metaParts.has("filter_count") || metaParts.has("*"),
    totalCount: metaParts.has("total_count") || metaParts.has("*"),
  };

  return { filter, sort, fields: fieldsList, limit, offset, meta };
};

/**
 * Compute the projection set: intersection of (user-requested fields ∪
 * system columns) with the permission allow-list. Returns null if no
 * projection is needed (i.e. select all readable columns).
 */
export const resolveProjection = (
  parsed: ParsedQuery,
  fields: FieldDef[],
  ownerScoped: boolean,
  permissionFields: Set<string> | null,
): string[] | null => {
  const sys = ["id", "created_at", "updated_at", ...(ownerScoped ? ["owner_id"] : [])];
  if (parsed.fields) {
    const set = new Set(parsed.fields);
    for (const c of sys) set.add(c);
    return [...set];
  }
  if (!permissionFields) return null;
  const cols = [...sys];
  for (const f of fields) {
    if (permissionFields.has(f.name)) cols.push(f.name);
  }
  return cols;
};
