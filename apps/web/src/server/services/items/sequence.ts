import { and, eq, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  type FieldDef,
  type SequenceSpec,
  highestUsedCounters,
  renderSequenceValue,
  sequenceScopeKey,
} from "@backlex/db";
import { AppError } from "@backlex/core";
import type { Ctx } from "../../context";
import { queryAll } from "./sql-helpers";

/**
 * Sequence fields at runtime — issuing the next document number.
 *
 * The pure half (the pattern grammar, the reset bucket, the rendering) lives in
 * `@backlex/db`'s `sequence` module with no clock or database in sight. This
 * file is only the counter, and the counter is one statement.
 *
 * ## Why one statement
 *
 * The obvious implementation reads the current value, adds one, and writes it
 * back. Two creates landing together both read the same "before" and both claim
 * it, so two invoices come out with the same number. This repo has already paid
 * for that shape once — the settings upsert race that surfaced as intermittent
 * 500s — and the fix is the same one: let the database do the arithmetic inside
 * a single `INSERT … ON CONFLICT DO UPDATE SET last_value = last_value + n
 * RETURNING last_value`. Whichever statement runs second sees the first one's
 * write, and the unique index on (tenant, collection, field, scope) is what
 * makes the conflict clause fire at all.
 *
 * ## What it guarantees
 *
 * Unique and monotonic within a scope. NOT contiguous — see the module note on
 * `@backlex/db`'s `sequence` for why gapless numbering is deliberately not
 * offered. The counter is bumped against `ctx.db`, never the caller's
 * transaction handle, so an atomic batch that rolls back leaves the numbers it
 * consumed spent. That is the same trade a Postgres `SEQUENCE` makes and the
 * reason it is safe to allocate before the insert rather than during it.
 *
 * @module
 */

const sequencesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.sequences : sqlite.schema.sequences;

/** A field whose value this module issues. */
export interface SequenceField {
  name: string;
  spec: SequenceSpec;
}

/** The sequence fields on a collection, in declaration order. */
export const sequenceFieldsOf = (fields: FieldDef[]): SequenceField[] =>
  fields.flatMap((f) => (f.sequence ? [{ name: f.name, spec: f.sequence }] : []));

/**
 * A block of pre-rendered values, keyed by field name, that `performCreate`
 * draws from instead of allocating one at a time.
 *
 * Bulk callers (batch, CSV import) build one of these for the whole run so an
 * n-row import costs one allocation statement per sequence field rather than n.
 * Values are consumed from the front; a create that finds the pool empty falls
 * back to allocating its own, so an under-sized pool is a slowdown and never a
 * correctness problem.
 */
export type SequencePool = Map<string, string[]>;

/**
 * Take `count` numbers for each sequence field on the collection and render
 * them. One statement per field; `[]` fields mean no statement at all, which is
 * the case that matters — almost no collection has a sequence and none of them
 * should pay for the feature.
 *
 * `at` fixes both the reset bucket and the date tokens for the whole block, so
 * an import that straddles midnight numbers consistently under the instant it
 * started rather than splitting across two buckets mid-file.
 */
export const allocateSequenceValues = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  collectionSlug: string,
  fields: SequenceField[],
  count: number,
  at: Date,
): Promise<SequencePool> => {
  const pool: SequencePool = new Map();
  if (fields.length === 0 || count <= 0) return pool;
  const t = sequencesTable(ctx.dialect);
  // `''`, not NULL: a unique index treats NULLs as distinct, so a null tenant
  // would defeat the ON CONFLICT and hand every row the same number.
  const tenant = tenantId ?? "";
  const now = new Date();

  for (const f of fields) {
    const scope = sequenceScopeKey(f.spec, at);
    const start = f.spec.start ?? 1;
    // Both branches leave `last_value` at the LAST number of the block, so the
    // block is [last - count + 1, last] whether the counter existed or not.
    const rows = (await (ctx.db as any)
      .insert(t)
      .values({
        id: crypto.randomUUID(),
        tenantId: tenant,
        collection: collectionSlug,
        field: f.name,
        scope,
        lastValue: start + count - 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [t.tenantId, t.collection, t.field, t.scope],
        set: { lastValue: sql`${t.lastValue} + ${count}`, updatedAt: now },
      })
      .returning({ lastValue: t.lastValue })) as { lastValue: number | bigint }[];

    const last = Number(rows[0]?.lastValue);
    if (!Number.isFinite(last)) {
      // The upsert either inserts or updates exactly one row, so an empty
      // RETURNING means the statement did not do what this code believes it
      // does — a driver that silently drops RETURNING, say. Failing loudly is
      // the only safe answer: the alternative is issuing a number nobody
      // recorded, which duplicates on the very next create.
      throw new AppError(
        "INTERNAL",
        `Could not allocate a value for sequence field "${collectionSlug}.${f.name}"`,
      );
    }
    const first = last - count + 1;
    pool.set(
      f.name,
      Array.from({ length: count }, (_, i) => renderSequenceValue(f.spec, first + i, at)),
    );
  }
  return pool;
};

/**
 * One rendered value per sequence field, for a single row. Draws from `pool`
 * when the caller pre-allocated a block, otherwise allocates a block of one.
 *
 * Returns `{}` — with no database work at all — for the overwhelming majority
 * of collections, which have no sequence field.
 */
export const nextSequenceValues = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  collectionSlug: string,
  fields: SequenceField[],
  at: Date,
  pool?: SequencePool,
): Promise<Record<string, string>> => {
  if (fields.length === 0) return {};
  const out: Record<string, string> = {};
  const missing: SequenceField[] = [];
  for (const f of fields) {
    const queued = pool?.get(f.name);
    const hit = queued?.shift();
    if (hit !== undefined) out[f.name] = hit;
    else missing.push(f);
  }
  if (missing.length > 0) {
    const fresh = await allocateSequenceValues(ctx, tenantId, collectionSlug, missing, 1, at);
    for (const f of missing) {
      const v = fresh.get(f.name)?.[0];
      if (v !== undefined) out[f.name] = v;
    }
  }
  return out;
};

// --- Repair -----------------------------------------------------------------

export interface SequenceSyncResult {
  field: string;
  /** Buckets whose counter was moved forward, and to what. */
  advanced: { scope: string; to: number }[];
  /** Stored values that this spec could not have produced, so they could not
   *  be taken into account. */
  unreadable: number;
}

/**
 * Move each counter forward to the highest number already sitting in the
 * column.
 *
 * This is the sequence equivalent of the rollup backfill, and it closes a hole
 * that is easy to miss: adopting a table that already holds `INV-0001` …
 * `INV-0499` starts the counter at zero, so the very first create issues
 * `INV-0001` again and collides. Same for a restore from a dump taken before
 * the counter existed, and for a bulk seed written around the write path.
 *
 * Only ever forward. Lowering a counter would reissue numbers that are already
 * on documents, so a bucket whose stored maximum is BELOW the counter is left
 * exactly where it is — the counter is the source of truth for what has been
 * handed out, and rows can be deleted.
 */
export const syncSequenceCounters = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  collection: { slug: string; physicalTable: string; tenantScoped: boolean },
  fields: SequenceField[],
): Promise<SequenceSyncResult[]> => {
  if (fields.length === 0) return [];
  const t = sequencesTable(ctx.dialect);
  const tenant = tenantId ?? "";
  const now = new Date();
  const out: SequenceSyncResult[] = [];

  for (const f of fields) {
    const scope =
      collection.tenantScoped && tenantId
        ? sql` WHERE ${sql.identifier("tenant_id")} = ${tenantId}`
        : sql``;
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT ${sql.identifier(f.name)} AS v FROM ${sql.identifier(collection.physicalTable)}${scope}`,
    );
    const { byScope, unreadable } = highestUsedCounters(
      f.spec,
      rows.map((r) => r.v),
    );
    const advanced: { scope: string; to: number }[] = [];
    for (const [bucket, high] of byScope) {
      await (ctx.db as any)
        .insert(t)
        .values({
          id: crypto.randomUUID(),
          tenantId: tenant,
          collection: collection.slug,
          field: f.name,
          scope: bucket,
          lastValue: high,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [t.tenantId, t.collection, t.field, t.scope],
          set: {
            // Forward only — see the note above. `excluded` is the row this
            // statement tried to insert, and is spelled the same way in both
            // dialects.
            lastValue: sql`CASE WHEN excluded.${sql.identifier("last_value")} > ${t.lastValue} THEN excluded.${sql.identifier("last_value")} ELSE ${t.lastValue} END`,
            updatedAt: now,
          },
        });
      advanced.push({ scope: bucket, to: high });
    }
    out.push({ field: f.name, advanced, unreadable });
  }
  return out;
};

/**
 * Forget the counters for a collection, or for one field of it.
 *
 * Called when a collection is dropped and when a sequence field is dropped.
 * Keeping the row would mean that recreating `invoices` — a fresh table with no
 * rows in it — resumed at `INV-0501`, which is not what dropping a collection
 * means. It also leaves counters for collections nobody can name any more
 * sitting in the table forever.
 *
 * Best-effort: a failure here must not turn a successful drop into an error the
 * caller has to reason about, since the physical table is already gone by then.
 */
export const dropSequenceCounters = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  collectionSlug: string,
  fieldName?: string,
): Promise<void> => {
  const t = sequencesTable(ctx.dialect);
  const where = [
    eq(t.tenantId, tenantId ?? ""),
    eq(t.collection, collectionSlug),
    ...(fieldName ? [eq(t.field, fieldName)] : []),
  ];
  try {
    await (ctx.db as any).delete(t).where(and(...where));
  } catch {
    // Swallowed on purpose — see the note above.
  }
};

/**
 * What the next value WOULD be, without consuming it — for the admin's "next:
 * INV-2026-0043" hint.
 *
 * A read, so it is inherently a guess: by the time it is rendered someone else
 * may have taken that number. Callers must present it as a preview and never
 * write it, which is why this is a separate function from the allocator rather
 * than a flag on it.
 */
export const peekSequenceValues = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  collectionSlug: string,
  fields: SequenceField[],
  at: Date,
): Promise<Record<string, string>> => {
  if (fields.length === 0) return {};
  const t = sequencesTable(ctx.dialect);
  const tenant = tenantId ?? "";
  const out: Record<string, string> = {};
  for (const f of fields) {
    const scope = sequenceScopeKey(f.spec, at);
    const rows = (await (ctx.db as any)
      .select({ lastValue: t.lastValue })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenant),
          eq(t.collection, collectionSlug),
          eq(t.field, f.name),
          eq(t.scope, scope),
        ),
      )
      .limit(1)) as { lastValue: number | bigint }[];
    const last = rows[0] ? Number(rows[0].lastValue) : null;
    // No counter row yet means this bucket has issued nothing, so the next
    // number is `start` — not `start + 1`.
    const next = last === null ? (f.spec.start ?? 1) : last + 1;
    out[f.name] = renderSequenceValue(f.spec, next, at);
  }
  return out;
};
