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
   * Relation field names to inline-expand in the response. Each entry is a
   * `relation` (to-one) or `relation_many` (to-many) field on this collection
   * that the caller has read permission on; multi-hop chains (`a.b`) are
   * rejected at parse time (see "What's not yet supported" in
   * docs/querying.md). Validation only covers source-side rules — the target
   * collection + per-target read permission gate is enforced by the items
   * list/get handlers (a LEFT JOIN for to-one, a batch fetch for to-many).
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
  /**
   * Keyset-pagination cursor. `null` = caller did not opt in (classic offset
   * paging, unchanged). `""` = cursor mode requested with no boundary yet
   * (first page — the handler appends an `id` tiebreaker, emits `next_cursor`).
   * A non-empty value is the opaque base64url boundary tuple of the previous
   * page's last row (see services/items/keyset.ts).
   */
  cursor: string | null;
  meta: { filterCount: boolean; totalCount: boolean };
  /**
   * Raw `?q=` needle when the collection has full-text search active — the
   * list handler turns this into a keyword-index predicate (`_fts @@ …` /
   * FTS5 `MATCH`) instead of the substring `LIKE` fallback. Null when FTS is
   * off (the needle was already folded into `filter` as `_contains` clauses)
   * or no `?q=` was given.
   */
  search: string | null;
}

const SYSTEM_COLUMNS = new Set(["id", "created_at", "updated_at"]);
/** Extra system columns present only on versioned collections. Sortable /
 *  filterable so a CMS can order by publish date (`-_published_at`) and filter
 *  by `_status`. Gated on the collection actually being versioned — referencing
 *  them on a plain table would compile to SQL against a missing column. */
const VERSIONED_COLUMNS = ["_status", "_published_at", "_publish_at"];

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
    // A hash field's stored value is a salted digest and reads back as null —
    // allowing filters on it would turn the list endpoint into a verification
    // oracle (probe by trying `_eq`/`_contains` against the digest). Reject.
    if (fieldsByName.get(k)?.type === "hash") {
      throw new AppError("VALIDATION", `Cannot filter on hashed field: ${k}`);
    }
  }
};

export const parseQuery = (
  params: URLSearchParams,
  fields: FieldDef[],
  ownerScoped: boolean,
  permissionFields: Set<string> | null,
  defaultSort: string | null = null,
  /** When true, the collection maintains a full-text index, so `?q=` is
   *  surfaced as `parsed.search` (keyword ranking) instead of being expanded
   *  into substring `_contains` clauses on the filter. */
  ftsActive: boolean = false,
  /** When true, the collection has the versioned system columns
   *  (`_status` / `_published_at` / `_publish_at`) — they become sortable and
   *  filterable. */
  versioned: boolean = false,
): ParsedQuery => {
  const valid = buildValidColumns(fields, ownerScoped);
  // Permission allow-list narrows what user fields can be filtered/sorted/projected.
  // System columns are always allowed.
  const allowedForUser = new Set<string>(SYSTEM_COLUMNS);
  if (ownerScoped) allowedForUser.add("owner_id");
  if (versioned) {
    for (const col of VERSIONED_COLUMNS) {
      valid.add(col);
      allowedForUser.add(col);
    }
  }
  for (const f of fields) {
    if (!permissionFields || permissionFields.has(f.name)) {
      allowedForUser.add(f.name);
    }
  }

  // Relation heads — let the normalizer flatten the PostgREST-style
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

  // `q=...` is a free-text search. When the collection has full-text search
  // active, hand the raw needle to the list handler as `search` so it can run
  // the keyword index (`_fts @@ …` / FTS5 `MATCH`). Otherwise fall back to the
  // legacy behaviour: `_contains` OR-ed across every readable text/longtext
  // field, AND-combined with the explicit `filter`.
  let search: string | null = null;
  const qRaw = params.get("q");
  if (qRaw && qRaw.trim()) {
    const needle = qRaw.trim();
    if (ftsActive) {
      search = needle;
    } else {
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
      // Sorting on a hash digest is meaningless (salted → random order) and is
      // a probing surface — reject it like filtering.
      if (sortFieldsByName.get(field)?.type === "hash") {
        throw new AppError("VALIDATION", `Cannot sort on hashed field: ${field}`);
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
        if (def.type !== "relation" && def.type !== "relation_many") {
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

  // `expand=<relation_field>[,<relation_field>…]` — inline the target row(s) of
  // each named relation field in the response. Both `relation` (to-one → nested
  // object) and `relation_many` (to-many → array of nested rows) heads are
  // accepted; multi-hop chains (`a.b`) still return 422. The handler resolves
  // the target collection, gates read perm, and materializes the JOIN (to-one)
  // or a batch fetch (to-many) — we only enforce source-side identifier shape,
  // field existence, type, and the caller's source-side `fields` allow-list here.
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
      if (def.type !== "relation" && def.type !== "relation_many") {
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
  // `?cursor` present (even empty) switches the list handler into keyset mode;
  // `params.get` returns "" for `?cursor=` and null when the key is absent.
  const cursor = params.has("cursor") ? (params.get("cursor") ?? "") : null;

  const metaRaw = params.get("meta") ?? "";
  const metaParts = new Set(metaRaw.split(",").map((s) => s.trim()));
  const meta = {
    filterCount: metaParts.has("filter_count") || metaParts.has("*"),
    totalCount: metaParts.has("total_count") || metaParts.has("*"),
  };

  return { filter, sort, fields: fieldsList, expand, expandSubs, limit, offset, cursor, meta, search };
};

/** Which columns of the *local* table one parsed list query touches — the
 *  input the advisor's traffic-derived index rules aggregate over. */
export interface QueryShape {
  /** Local column names appearing in the filter, deduped. */
  filters: string[];
  /** Local column names appearing in the sort, deduped, in sort order. */
  sorts: string[];
}

/** Local column a filter/sort key refers to. A dotted key traverses a relation
 *  (`customer_id.city`), and the column the *local* table has to look up — and
 *  therefore the one an index would help — is the head segment. */
const localColumnOf = (key: string): string => {
  const head = key.split(".")[0];
  return head ?? key;
};

/** Walk a condition tree, collecting the local column of every leaf key. */
const collectFilterColumns = (cond: Condition, into: Set<string>): void => {
  for (const [key, value] of Object.entries(cond)) {
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        for (const sub of value as Condition[]) collectFilterColumns(sub, into);
      }
      continue;
    }
    if (key === "$not") {
      if (value && typeof value === "object") {
        collectFilterColumns(value as Condition, into);
      }
      continue;
    }
    into.add(localColumnOf(key));
  }
};

/**
 * Reduce a parsed query to the set of columns it filters and sorts on. Recorded
 * as a span attribute by the list handler so the advisor can tell which columns
 * real traffic actually needs indexed — as opposed to guessing from the schema.
 * Names only: no values, so nothing user-supplied leaks into telemetry.
 */
export const queryShapeOf = (parsed: ParsedQuery): QueryShape => {
  const filters = new Set<string>();
  if (parsed.filter) collectFilterColumns(parsed.filter, filters);
  const sorts: string[] = [];
  for (const s of parsed.sort) {
    const col = localColumnOf(s.field);
    if (!sorts.includes(col)) sorts.push(col);
  }
  return { filters: [...filters], sorts };
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
