import { AppError, normalizeCondition } from "@backlex/core";
import type { Condition } from "@backlex/core";
import type { FieldDef } from "@backlex/db";

export interface SortClause {
  field: string;
  dir: "asc" | "desc";
}

export interface ParsedQuery {
  filter: Condition | null;
  sort: SortClause[];
  fields: string[] | null;
  /**
   * Relation field names to inline-expand in the response. Each entry must
   * be a single-FK `relation` field on this collection that the caller has
   * read permission on; chains (`a.b`) and `relation_many` heads are
   * rejected at parse time (see "What's not yet supported" in
   * docs/querying.md). Validation only covers source-side rules — the
   * target collection + per-target read permission gate is enforced by the
   * items list/get handlers when the LEFT JOIN is materialized.
   */
  expand: string[];
  /**
   * Per-expanded-head sub-field projection, populated when `fields` carries a
   * relation dot-path (`fields=customer.name`). The head is added to `expand`
   * and its requested leaf columns recorded here so the expand SELECT trims the
   * inlined object to just those columns. A head expanded "whole" (via the
   * `expand=` param or a `head.*` wildcard) is absent from this map.
   */
  expandSubs: Map<string, Set<string>>;
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
  fieldsByName: Map<string, FieldDef>,
  allowedForUser: Set<string>,
): void => {
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.$and)) {
    for (const sub of c.$and) validateFilterFields(sub as Condition, valid, fieldsByName, allowedForUser);
    return;
  }
  if (Array.isArray(c.$or)) {
    for (const sub of c.$or) validateFilterFields(sub as Condition, valid, fieldsByName, allowedForUser);
    return;
  }
  if (c.$not !== undefined) {
    validateFilterFields(c.$not as Condition, valid, fieldsByName, allowedForUser);
    return;
  }
  for (const k of Object.keys(c)) {
    // Nested-relation filter: `<relation_field>.<sub>[.<sub2>…]` — the
    // FIRST segment must be a `relation` / `relation_many` field on THIS
    // collection that the caller has read permission on. Middle segments
    // (for multi-hop) can't be type-checked here because the target
    // collection isn't loaded yet — items.ts resolves each hop, the
    // target collection, and the per-hop read permission at compile
    // time. We only enforce identifier shape on every segment.
    if (k.includes(".")) {
      const dotCount = (k.match(/\./g) || []).length;
      // Hard ceiling: keys may have up to 3 segments (= 2 hops + leaf).
      // `a.b` is 1-hop (head `a`, leaf `b`). `a.b.c` is 2-hop (chain
      // `[a, b]`, leaf `c`). `a.b.c.d` is 3-hop — rejected. The ceiling
      // keeps generated aliases under the PG 63-char identifier limit
      // and the JOIN ladder readable in EXPLAIN.
      if (dotCount > 2) {
        throw new AppError(
          "VALIDATION",
          `Nested filter exceeds max depth: ${k}`,
        );
      }
      const segments = k.split(".");
      if (segments.some((s) => !s)) {
        throw new AppError("VALIDATION", `Invalid nested filter key: ${k}`);
      }
      const head = segments[0]!;
      const def = fieldsByName.get(head);
      if (!def) {
        throw new AppError("VALIDATION", `Unknown field on nested filter: ${head}`);
      }
      if (def.type !== "relation" && def.type !== "relation_many") {
        throw new AppError(
          "VALIDATION",
          `Nested filter only works on relation fields — "${head}" is ${def.type}`,
        );
      }
      if (!allowedForUser.has(head)) {
        throw new AppError("FORBIDDEN", `No permission to read field: ${head}`);
      }
      // Every segment after the head must have a safe identifier shape;
      // mid-segment type-checking and target-collection existence are
      // enforced by the items.ts compile-time wiring.
      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i]!;
        if (!/^[a-z_][a-z0-9_]*$/.test(seg)) {
          throw new AppError("VALIDATION", `Invalid nested subfield: ${seg}`);
        }
      }
      continue;
    }
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
  defaultSort: string | null = null,
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

  // Relation heads — let the normalizer flatten the Directus/PostgREST-style
  // nested-object filter form (`{ customer: { name: { _eq } } }`) into the
  // canonical dotted-key form without mistaking a `json` column for a relation.
  const relationFields = new Set(
    fields
      .filter((f) => f.type === "relation" || f.type === "relation_many")
      .map((f) => f.name),
  );

  let filter: Condition | null = null;
  const filterRaw = params.get("filter");
  if (filterRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(filterRaw);
    } catch {
      throw new AppError("VALIDATION", "Invalid `filter` JSON");
    }
    // Accept `_and`/`_or`/`_not` aliases, nested-object relation filters, and
    // implicit-equality sugar; everything downstream sees canonical form only.
    filter = normalizeCondition(parsed, { relationFields });
    const fieldsByName = new Map(fields.map((f) => [f.name, f] as const));
    validateFilterFields(filter, allowedForUser, fieldsByName, allowedForUser);
  }

  // `q=...` is a free-text search: `_contains` OR-ed across every readable
  // text/longtext field. AND-combined with the explicit `filter` so the two
  // are independent — search narrows whatever the user already filtered.
  const qRaw = params.get("q");
  if (qRaw && qRaw.trim()) {
    const needle = qRaw.trim();
    const searchable = fields.filter(
      (f) =>
        (f.type === "text" || f.type === "longtext") &&
        allowedForUser.has(f.name),
    );
    if (searchable.length > 0) {
      const orClauses = searchable.map(
        (f) => ({ [f.name]: { _contains: needle } }) as Condition,
      );
      const searchCond: Condition =
        orClauses.length === 1 ? orClauses[0]! : { $or: orClauses };
      filter = filter ? { $and: [filter, searchCond] } : searchCond;
    }
  }

  const fallbackSort = defaultSort?.trim() || "-created_at";
  const sortRaw = params.get("sort")?.trim() || fallbackSort;
  const sortFieldsByName = new Map(fields.map((f) => [f.name, f] as const));
  const sort: SortClause[] = sortRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const dir: "asc" | "desc" = s.startsWith("-") ? "desc" : "asc";
      const field = s.replace(/^[-+]/, "");
      // Nested sort: `<relation_field>.<sub>[.<sub2>…]` — same gate as
      // nested filter. items.ts threads the multi-hop JOIN chain through
      // `nestedColRef` for ORDER BY at compile time. The HEAD must be a
      // single-FK `relation` (relation_many sort has no well-defined
      // order). Middle hops must also be relations — but that's enforced
      // by items.ts when it walks the chain and loads target collections.
      if (field.includes(".")) {
        const dotCount = (field.match(/\./g) || []).length;
        if (dotCount > 2) {
          throw new AppError("VALIDATION", `Nested sort exceeds max depth: ${field}`);
        }
        const segments = field.split(".");
        if (segments.some((s) => !s)) {
          throw new AppError("VALIDATION", `Invalid nested sort key: ${field}`);
        }
        const head = segments[0]!;
        const def = sortFieldsByName.get(head);
        if (!def) {
          throw new AppError("VALIDATION", `Unknown sort field: ${head}`);
        }
        if (def.type !== "relation" && def.type !== "relation_many") {
          throw new AppError(
            "VALIDATION",
            `Nested sort only works on relation fields — "${head}" is ${def.type}`,
          );
        }
        if (def.type === "relation_many") {
          // Sorting through a JSON array of foreign ids has no well-defined
          // semantics — which related row's value drives the order? Reject
          // up front so the caller gets a precise 422 instead of a cryptic
          // SQL error from the items.ts code path that only sets up JOINs
          // for single-FK `relation` heads.
          throw new AppError(
            "VALIDATION",
            `Nested sort on relation_many is not supported: ${head}`,
          );
        }
        if (!allowedForUser.has(head)) {
          throw new AppError("FORBIDDEN", `No permission to read field: ${head}`);
        }
        for (let i = 1; i < segments.length; i++) {
          const seg = segments[i]!;
          if (!/^[a-z_][a-z0-9_]*$/.test(seg)) {
            throw new AppError("VALIDATION", `Invalid nested sort subfield: ${seg}`);
          }
        }
        return { field, dir };
      }
      if (!allowedForUser.has(field)) {
        throw new AppError("VALIDATION", `Cannot sort on field: ${field}`);
      }
      return { field, dir };
    });
  if (sort.length === 0) sort.push({ field: "created_at", dir: "desc" });

  // `fields` accepts plain columns AND single-hop relation dot-paths
  // (`customer.name`, `customer.*`). A dot-path routes its head into `expand`
  // and records the requested leaves so the inlined object is trimmed — the
  // SAME traversal grammar filter/sort use, so the projection is no longer the
  // odd one out. Multi-hop projection (`a.b.c`) is deferred (single-hop expand).
  const fieldDefsByName = new Map(fields.map((f) => [f.name, f] as const));
  const expandSubs = new Map<string, Set<string>>();
  const fieldExpandHeads = new Set<string>();
  const fieldExpandFull = new Set<string>();
  let fieldsList: string[] | null = null;
  const fieldsRaw = params.get("fields");
  if (fieldsRaw) {
    const requested = fieldsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const baseFields: string[] = [];
    for (const f of requested) {
      if (f.includes(".")) {
        const segs = f.split(".");
        if (segs.length !== 2) {
          throw new AppError(
            "VALIDATION",
            `Multi-hop field projection not yet supported: ${f}`,
          );
        }
        const [head, sub] = segs as [string, string];
        if (!head || !sub) {
          throw new AppError("VALIDATION", `Invalid field path: ${f}`);
        }
        const def = fieldDefsByName.get(head);
        if (!def) throw new AppError("VALIDATION", `Unknown field: ${head}`);
        if (def.type === "relation_many") {
          throw new AppError(
            "VALIDATION",
            `Field projection through relation_many not yet supported: ${f}`,
          );
        }
        if (def.type !== "relation") {
          throw new AppError(
            "VALIDATION",
            `Cannot project a sub-field of non-relation "${head}"`,
          );
        }
        if (!allowedForUser.has(head)) {
          throw new AppError("FORBIDDEN", `No permission to read field: ${head}`);
        }
        fieldExpandHeads.add(head);
        if (sub === "*") fieldExpandFull.add(head);
        else {
          if (!expandSubs.has(head)) expandSubs.set(head, new Set());
          expandSubs.get(head)!.add(sub);
        }
        continue;
      }
      if (!valid.has(f)) {
        throw new AppError("VALIDATION", `Unknown field: ${f}`);
      }
      if (!allowedForUser.has(f)) {
        throw new AppError("FORBIDDEN", `No permission to read field: ${f}`);
      }
      baseFields.push(f);
    }
    fieldsList = baseFields;
  }

  // `expand=<relation_field>[,<relation_field>…]` — inline the target row of
  // each named relation field in the response. Single-hop only in this PR;
  // chains (`a.b`) and `relation_many` heads return 422. The handler resolves
  // the target collection, gates read perm, and materializes the JOIN — we
  // only enforce source-side identifier shape, field existence, type, and
  // the caller's source-side `fields` allow-list here.
  const expand: string[] = [];
  const expandRaw = params.get("expand");
  if (expandRaw) {
    const expandFieldsByName = new Map(fields.map((f) => [f.name, f] as const));
    const seen = new Set<string>();
    for (const raw of expandRaw.split(",")) {
      const name = raw.trim();
      if (!name) continue;
      if (name.includes(".")) {
        throw new AppError(
          "VALIDATION",
          `expand chain not yet supported: ${name}`,
        );
      }
      const def = expandFieldsByName.get(name);
      if (!def) {
        throw new AppError("VALIDATION", `Unknown expand field: ${name}`);
      }
      if (def.type === "relation_many") {
        throw new AppError(
          "VALIDATION",
          `expand on relation_many not yet supported: ${name}`,
        );
      }
      if (def.type !== "relation") {
        throw new AppError(
          "VALIDATION",
          `expand only works on relation fields — "${name}" is ${def.type}`,
        );
      }
      if (!allowedForUser.has(name)) {
        throw new AppError("FORBIDDEN", `No permission to read field: ${name}`);
      }
      if (!seen.has(name)) {
        seen.add(name);
        expand.push(name);
      }
    }
  }
  // Fold relation dot-paths from `fields` into the expand set. A head also
  // requested via the explicit `expand=` param (or `head.*`) is expanded whole
  // — drop any sub-trim for it so the full row wins.
  const explicitExpand = new Set(expand);
  for (const head of fieldExpandHeads) {
    if (!explicitExpand.has(head)) expand.push(head);
  }
  for (const head of [...expandSubs.keys()]) {
    if (explicitExpand.has(head) || fieldExpandFull.has(head)) {
      expandSubs.delete(head);
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

  return { filter, sort, fields: fieldsList, expand, expandSubs, limit, offset, meta };
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
  opts: { hasCreatedAt?: boolean; hasUpdatedAt?: boolean } = {},
): string[] | null => {
  // Default true preserves the legacy contract for managed collections;
  // adopted collections opt out when the underlying table doesn't carry
  // the system column (or aliases it through a separate column, which
  // routes/items.ts handles via SELECT-time aliasing).
  const hasCreatedAt = opts.hasCreatedAt !== false;
  const hasUpdatedAt = opts.hasUpdatedAt !== false;
  const sys: string[] = ["id"];
  if (hasCreatedAt) sys.push("created_at");
  if (hasUpdatedAt) sys.push("updated_at");
  if (ownerScoped) sys.push("owner_id");
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
