import { sql, type SQL } from "drizzle-orm";
import type { FieldDef } from "@backlex/db";
import {
  resolveSlug,
  type SlugSpec,
  slugCandidates,
  SLUG_MAX_DEFAULT,
} from "@backlex/db/slug";
import type { Ctx } from "../../context";
import { execute, pkEq, queryAll } from "./sql-helpers";

/**
 * Maintaining a slug column — folding one out of the row's own title when the
 * field is left empty, and picking a free one when the obvious answer is taken.
 *
 * The fold itself is pure and lives in `@backlex/db/slug`, so the admin's
 * preview and the server's write run the same function. What is here is the
 * half that needs the database: which candidate is still free.
 */

/**
 * The parts of a collection a slug statement needs.
 *
 * Structural rather than the items layer's `CollectionRow` because GraphQL
 * carries its own, narrower row shape — and the point of the parity gate is
 * that both surfaces reach THIS code instead of hand-writing a second fold that
 * can drift from it. Same widening `tenantFilter` and `deletedFilter` got.
 */
export interface SlugCollection {
  physicalTable: string;
  pkColumn: string;
  fields: FieldDef[];
}

/** A slug field paired with its spec, so callers stop re-narrowing the type. */
export interface SlugField {
  name: string;
  spec: SlugSpec;
}

/** The slug fields of a collection, in declaration order. */
export const slugFieldsOf = (fields: FieldDef[]): SlugField[] =>
  fields.flatMap((f) => (f.slug ? [{ name: f.name, spec: f.slug }] : []));

/**
 * Which of `candidates` are already present in this column.
 *
 * **Deliberately unfiltered — no tenant clause, no soft-delete clause.** That
 * looks wrong next to every other query in this directory, and it is the one
 * thing in this file most likely to be "fixed" into a bug, so: the arbiter of a
 * slug collision is the column's own `UNIQUE` constraint, and `columnDefSql`
 * emits that as a plain column-level `UNIQUE` with no predicate. It therefore
 * spans every tenant sharing the table and counts soft-deleted rows, which
 * still physically hold their value.
 *
 * So a dedupe that scoped itself to the caller's tenant, or that skipped
 * soft-deleted rows, would confidently propose a slug the database then
 * refuses — turning a working suffix into a 409 in exactly the cases this
 * function exists to prevent. **A dedupe must ask the same question the
 * constraint answers.**
 *
 * (Managed tables are named `c_<tenantPrefix12>_<slug>` and so are per-tenant
 * anyway; adopted ones may genuinely be shared. Unfiltered is correct for both,
 * which is why it is not conditional on `tenantScoped`.)
 */
const takenAmong = async (
  ctx: Ctx,
  collection: SlugCollection,
  column: string,
  candidates: string[],
  excludeId: string | null,
  db?: unknown,
): Promise<Set<string>> => {
  if (candidates.length === 0) return new Set();
  const col = sql`${sql.identifier(column)}`;
  const inList = sql.join(
    candidates.map((c) => sql`${c}`),
    sql`, `,
  );
  // Excluding the row being updated is what stops a PATCH that leaves the slug
  // alone from seeing its own value as taken and suffixing itself on every save.
  const notSelf = excludeId ? sql` AND NOT ${pkEq(collection.pkColumn, excludeId)}` : sql``;
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${col} AS ${sql.identifier("v")} FROM ${sql.identifier(collection.physicalTable)} WHERE ${col} IN (${inList})${notSelf}`,
    db,
  );
  const out = new Set<string>();
  for (const r of rows) {
    const v = r.v;
    if (typeof v === "string") out.add(v);
  }
  return out;
};

/** What {@link resolveSlugsForWrite} decided for one field. */
export interface SlugOutcome {
  field: string;
  /** The slug to store, or `null` to leave the column alone. */
  value: string | null;
  /** True when the value was folded out of a source column rather than stated. */
  derived: boolean;
}

/**
 * Resolve every slug column for a row that is about to be written.
 *
 * Reads `data` for both the supplied slug and the `from` sources, so it must be
 * called with the payload as it will be STORED — after defaults and after any
 * other canonicalization, or a slug folds from a title the row will not have.
 *
 * A **stated** slug is folded and returned as-is: if it collides, the database
 * says so and the caller gets a 409 naming their own choice, which is the right
 * answer to "I want this exact URL and it is taken". A **derived** slug is a
 * blank being filled, so it walks `base`, `base-2`, `base-3`… and takes the
 * first one free.
 *
 * The free-candidate search is ONE query per slug field regardless of how many
 * candidates it considers — it asks which of the fifty are taken and picks the
 * first that is not, rather than probing them one at a time.
 *
 * Concurrency, stated honestly: two creates racing on the same title can both
 * see `summer-sale` free and both try it. The `UNIQUE` constraint is what makes
 * that safe — the loser gets the 409 it already got before this feature
 * existed, and a retry lands on `summer-sale-2`. This is the same trade
 * `sequences` documents (unique and monotonic guaranteed, contiguous not): the
 * common case is a person creating a second row hours later, and paying for the
 * rare case with a lock on every write would be the wrong bargain.
 *
 * @param excludeId primary key of the row being updated, so it does not see
 *                  its own current slug as taken. `null` on create.
 * @param reserved slugs already spoken for by this same run but not yet in the
 *                 database — the backfill's batch, and the reason a dry run can
 *                 report what it WOULD do without two rows claiming one URL.
 */
export const resolveSlugsForWrite = async (
  ctx: Ctx,
  collection: SlugCollection,
  data: Record<string, unknown>,
  opts: { excludeId?: string | null; db?: unknown; reserved?: Set<string> } = {},
): Promise<SlugOutcome[]> => {
  const fields = slugFieldsOf(collection.fields);
  if (fields.length === 0) return [];
  const excludeId = opts.excludeId ?? null;
  const out: SlugOutcome[] = [];
  for (const f of fields) {
    const resolved = resolveSlug(data[f.name], data, f.spec);
    if (resolved.source === "none") {
      // Nothing to store and nothing to guess. Leaving the column untouched is
      // the honest move — see the module note in `@backlex/db/slug` on why a
      // generated token is not offered. `required` is enforced downstream by
      // the ordinary validator, which will name the field if it matters.
      out.push({ field: f.name, value: null, derived: false });
      continue;
    }
    if (resolved.source === "stated") {
      out.push({ field: f.name, value: resolved.value, derived: false });
      continue;
    }
    const cap = f.spec.maxLength ?? SLUG_MAX_DEFAULT;
    const candidates = slugCandidates(resolved.value, cap);
    const taken = await takenAmong(ctx, collection, f.name, candidates, excludeId, opts.db);
    const free = candidates.find((c) => !taken.has(c) && !opts.reserved?.has(c));
    // Every candidate taken means fifty rows already share this title. Storing
    // the base anyway hands the constraint a violation it will report properly,
    // which beats inventing an unbounded suffix nobody can read.
    out.push({ field: f.name, value: free ?? resolved.value, derived: true });
  }
  return out;
};

/**
 * Apply resolved slugs onto the payload, in place.
 *
 * Canonicalizing on the PAYLOAD rather than only in `serialize` is the rule geo
 * and money both had to learn: `performCreate` builds its 201 body, its
 * realtime event, its activity row and its FTS/embed text out of this object,
 * so a slug written only into the INSERT would leave every one of those saying
 * the row has no slug while the column holds one.
 */
/** One slug the backfill filled in (or would have). */
export interface SlugBackfillEntry {
  id: string;
  slug: string;
}

/** What a backfill run did to one field. */
export interface SlugBackfillResult {
  field: string;
  /** Rows found with an empty slug, within the caller's scope. */
  examined: number;
  /** Rows given one. */
  filled: number;
  /** Rows whose source text folded to nothing — reported, never invented. */
  unfoldable: number;
  /** Sample of what was written, capped so a report stays readable. */
  entries: SlugBackfillEntry[];
}

/** Rows a single backfill call will look at, per field. */
const BACKFILL_LIMIT = 1000;
/** How many filled slugs the report names before it stops listing them. */
const BACKFILL_SAMPLE = 50;

/**
 * Fill in slugs for rows that have none.
 *
 * The repair path for a column that predates the field being declared one:
 * every slug in the schema-template catalog is `required: false` and nothing
 * server-side ever generated one, so a workspace can hold years of rows whose
 * URL handle is simply empty.
 *
 * Only ever fills what is EMPTY. A row that already has a slug is left exactly
 * as it is, because that slug may be a published URL somebody is linking to,
 * and a "tidy-up" that rewrote it would break those links with no way back —
 * the same rule the update path follows.
 *
 * ## Scope, and how it differs from `order/normalize`
 *
 * The caller's row condition is APPLIED here rather than being grounds for
 * refusal, which is the opposite of what rearranging a list does — and the
 * difference is not an inconsistency. Renumbering a filtered subset produces
 * positions that collide with the rows it skipped, so a partial grant has no
 * coherent answer and must be refused. A slug is independent per row: filling
 * the ones a role can see is a complete, correct operation on exactly those
 * rows, and the collision check still consults the whole table.
 *
 * The FIELD allow-list is a refusal either way — a role that may not write the
 * slug column may not write it here (see the route).
 *
 * @param scope the full row scope: the caller's permission condition, the
 *   tenant clause and the soft-delete clause, exactly as the read path builds
 *   them. Restated on the SELECT **and** on every UPDATE, because a backfill
 *   writes rows the caller never named — the authorization bug the geo
 *   backfill shipped with and this is written to avoid.
 */
export const backfillSlugs = async (
  ctx: Ctx,
  collection: SlugCollection,
  field: SlugField,
  opts: { scope: SQL; dryRun: boolean; db?: unknown },
): Promise<SlugBackfillResult> => {
  const col = sql`${sql.identifier(field.name)}`;
  const pk = sql`${sql.identifier(collection.pkColumn)}`;
  // "Empty" has two spellings, and knowing only one of them is a bug this
  // codebase has already shipped once: the admin clears a text box by sending
  // `""`, which is stored as `""`, while an untouched column is NULL. A filter
  // that knew only `IS NULL` would skip every row an operator had actively
  // blanked — which is most of them.
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(collection.physicalTable)} WHERE ${opts.scope} AND (${col} IS NULL OR ${col} = '') LIMIT ${BACKFILL_LIMIT}`,
    opts.db,
  );
  const result: SlugBackfillResult = {
    field: field.name,
    examined: rows.length,
    filled: 0,
    unfoldable: 0,
    entries: [],
  };
  // Slugs this run has already spoken for. Needed because a dry run writes
  // nothing, so the database cannot tell the second "Summer Sale" that the
  // first one took the name — and on a real run it saves a round trip.
  const reserved = new Set<string>();
  for (const row of rows) {
    const id = row[collection.pkColumn];
    if (typeof id !== "string" && typeof id !== "number") continue;
    const outcomes = await resolveSlugsForWrite(ctx, collection, { ...row, [field.name]: null }, {
      excludeId: String(id),
      db: opts.db,
      reserved,
    });
    const hit = outcomes.find((o) => o.field === field.name);
    if (!hit || hit.value === null) {
      result.unfoldable++;
      continue;
    }
    reserved.add(hit.value);
    result.filled++;
    if (result.entries.length < BACKFILL_SAMPLE) {
      result.entries.push({ id: String(id), slug: hit.value });
    }
    if (opts.dryRun) continue;
    // The scope is restated on the UPDATE, not just on the SELECT above.
    // Defence in depth rather than the primary guard — the SELECT has already
    // narrowed to the caller's rows, so this clause earns its place only when a
    // row LEAVES the condition between the two statements (a concurrent write
    // to the column the condition tests). `slug-permissions.test.ts` says so
    // explicitly rather than claiming to pin it.
    await execute(
      ctx,
      sql`UPDATE ${sql.identifier(collection.physicalTable)} SET ${col} = ${hit.value} WHERE ${opts.scope} AND ${pk} = ${id}`,
      opts.db,
    );
  }
  return result;
};

export const applySlugs = (data: Record<string, unknown>, outcomes: SlugOutcome[]): void => {
  for (const o of outcomes) {
    if (o.value === null) {
      // A field the caller explicitly emptied and that folded to nothing must
      // not be left holding the empty string it arrived as: `""` would pass a
      // `unique` column exactly once and then collide with the next one.
      if (o.field in data) data[o.field] = null;
      continue;
    }
    data[o.field] = o.value;
  }
};
