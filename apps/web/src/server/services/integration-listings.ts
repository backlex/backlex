/**
 * Putting a workspace's products on sale at a marketplace, and reading back
 * what the marketplace made of them.
 *
 * The third runner, after the pull and the push in `integration-syncs.ts`, and
 * the first one that is not a mirror. A pull and a push both finish when the
 * last row moves; a publish finishes minutes or hours later, at the far end,
 * one unit at a time, with a verdict a person has to read. That gap is the
 * whole of this file.
 *
 * Three decisions shape it:
 *
 * **A publish is two phases, and they are scheduled separately.** `publish`
 * hands over a batch and receives a queue ticket; `poll` asks what became of
 * it. The sweep that polls does NOT ride on the sync's schedule, because a
 * listing sync defaults to manual and the scheduler skips those — a verdict is
 * owed whether the publish was clicked or scheduled.
 *
 * **A verdict lands on the row the UNIT came from.** A marketplace rules per
 * barcode, so the answer belongs on the barcode's row: the variant collection
 * when a workspace models variants, the product row when it does not. The
 * collection travels with the batch rather than being re-derived later, so an
 * operator who repoints the sync mid-flight cannot have answers written into
 * rows that merely share an id.
 *
 * **Nothing here writes a column directly.** The writeback goes through
 * `ingestRows` in `patch` mode — the same chokepoint the task runner uses, and
 * for the same reason it exists: an upsert plans a column for every field the
 * collection has, so recording an approval would blank everything else on the
 * row.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import {
  fetchListingAttributes,
  INTEGRATION_LISTINGS,
  fetchListingCategories,
  isRateLimited,
  listingColumnsFor,
  listingFor,
  publishListings,
  pollListingBatch,
  searchListingLookup,
  type ListingProduct,
  type ListingVariant,
  type ListingVerdict,
} from "@backlex/integrations";
import type { Ctx } from "../context";
import { loadCollection } from "./items/collection-loader";
import { ingestRows } from "./migrate-ingest";
import { queryAll } from "./items/sql-helpers";
import { LISTING_VARIANT_GROUP, type SyncRow } from "./integration-syncs";
import { connectionConfigFor, type ConnectionRow } from "./integration-credentials";
import { enqueueJob } from "./jobs";

type AnyDb = any;

const mapsTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.integrationListingMaps
    : sqlite.schema.integrationListingMaps) as typeof pg.schema.integrationListingMaps;

const batchesTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.integrationListingBatches
    : sqlite.schema.integrationListingBatches) as typeof pg.schema.integrationListingBatches;

/**
 * Products per publish call.
 *
 * Well under every provider's cap (Trendyol and n11 take 1,000, Çiçeksepeti
 * 1,000) because the binding constraint is not theirs: a product fans out into
 * its variants, and a Worker invocation has a subrequest budget. The next run
 * resumes at the watermark.
 */
const PUBLISH_BATCH = 100;

/** Batches one sweep will ask about. Bounds the invocation, not the backlog. */
const POLL_BATCH_LIMIT = 25;

/** One entry of a batch's `sent` map — where a verdict is owed. */
export interface SentUnit {
  rowId: string;
  collection: string;
}

export interface ListingMapRow {
  id: string;
  tenantId: string;
  syncId: string;
  localValue: string;
  categoryId: string;
  attributes: Record<string, { valueId?: string; custom?: string; field?: string }>;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export interface ListingBatchRow {
  id: string;
  tenantId: string;
  syncId: string;
  integrationId: string;
  batchId: string;
  status: string;
  sent: Record<string, SentUnit>;
  pendingCount: number;
  error: string | null;
  createdAt: Date | number | null;
  resolvedAt: Date | number | null;
}

// ── Reading the taxonomy ─────────────────────────────────────────────────────

/**
 * Load a connection and decrypt it, for the reads that browse a marketplace.
 *
 * Keyed on the INTEGRATION rather than a sync: an operator browses categories
 * while deciding whether to make a sync at all, and for the providers whose
 * catalog is public the browse works before a credential has been pasted.
 */
const loadListingConnection = async (
  ctx: Ctx,
  tenantId: string,
  integrationId: string,
): Promise<{ id: string; kind: string; config: Record<string, unknown> }> => {
  const t = (ctx.dialect === "pg" ? pg.schema.integrations : sqlite.schema.integrations) as typeof pg.schema.integrations;
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, integrationId)))) as ConnectionRow[];
  if (!row) throw new AppError("NOT_FOUND", "Integration not found");
  if (!listingFor(row.kind)) throw new AppError("VALIDATION", `${row.kind} cannot list products`);
  // Through the chokepoint, which is what renews an OAuth token. Browsing a
  // taxonomy is the first thing an operator does after connecting, so a token
  // that expired here reads as "this marketplace has no categories".
  const config = await connectionConfigFor(ctx, row, ctx.env.AUTH_SECRET);
  return { id: row.id, kind: row.kind, config };
};

/**
 * The whole tree, flattened.
 *
 * Not cached: this is a few hundred kilobytes fetched once while an operator
 * fills a form, and a cache here would be per-isolate — so two requests from
 * one browser could see two different answers, which is the read-your-writes
 * trap this codebase has been bitten by before. If it becomes a cost, the place
 * to cache it is a shared store keyed by connection, not module state.
 */
export async function readListingCategories(ctx: Ctx, tenantId: string, integrationId: string) {
  const conn = await loadListingConnection(ctx, tenantId, integrationId);
  return asOperatorError(() =>
    fetchListingCategories(conn.kind, { config: conn.config, connectionKey: conn.id }),
  );
}

export async function readListingAttributes(
  ctx: Ctx,
  tenantId: string,
  integrationId: string,
  categoryId: string,
) {
  const conn = await loadListingConnection(ctx, tenantId, integrationId);
  const attrs = await asOperatorError(() =>
    fetchListingAttributes(conn.kind, { config: conn.config, categoryId, connectionKey: conn.id }),
  );
  // The engine's `values` is readonly — a provider's declaration is not the
  // caller's to edit. Copied on the way out so the JSON boundary owns its own.
  return attrs.map((a) => ({ ...a, values: [...a.values] }));
}

export async function searchListingRegistry(
  ctx: Ctx,
  tenantId: string,
  integrationId: string,
  input: { lookup: string; query: string; cursor: string | null },
) {
  const conn = await loadListingConnection(ctx, tenantId, integrationId);
  // Checked HERE as well as in the engine, and the difference is the status an
  // operator sees. The engine's guard is a plain throw — right for a contract
  // violation, wrong for a typo in a query string, which would surface as an
  // internal error rather than as the bad request it is.
  const declared = INTEGRATION_LISTINGS[conn.kind]?.lookups ?? [];
  if (!declared.some((l) => l.key === input.lookup)) {
    throw new AppError(
      "VALIDATION",
      `${conn.kind} has no searchable registry "${input.lookup}"${declared.length ? ` — one of: ${declared.map((l) => l.key).join(", ")}` : ""}`,
    );
  }
  return asOperatorError(() =>
    searchListingLookup(conn.kind, { config: conn.config, connectionKey: conn.id, ...input }),
  );
}

/**
 * A marketplace's refusal is not our internal error.
 *
 * The same call the manual-run route makes, and for the same reason: a provider
 * goes to trouble to write a message an operator can act on ("check the API key
 * on the Integration Details page"), and reporting it as a 500 buries exactly
 * that. An `AppError` from our own layer passes through untouched.
 */
const asOperatorError = async <T,>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("UNAVAILABLE", e instanceof Error ? e.message : String(e));
  }
};

// ── The category mapping ─────────────────────────────────────────────────────

/** Every mapping this sync holds. Tenant-scoped on top of the sync id: the id
 *  comes from a caller, and a sync id alone would cross workspaces. */
export async function listListingMaps(
  ctx: Ctx,
  tenantId: string,
  syncId: string,
): Promise<ListingMapRow[]> {
  const t = mapsTableFor(ctx.dialect);
  return (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.syncId, syncId)))
    .orderBy(asc(t.localValue))) as ListingMapRow[];
}

/**
 * Map one local category, or re-map it.
 *
 * An upsert on `(sync_id, local_value)` rather than a create-or-update read:
 * two operators mapping the same category at once must converge on one row,
 * and the unique index is what makes that true rather than hopeful.
 */
export async function upsertListingMap(
  ctx: Ctx,
  tenantId: string,
  input: {
    syncId: string;
    localValue: string;
    categoryId: string;
    attributes?: Record<string, { valueId?: string; custom?: string; field?: string }>;
  },
): Promise<ListingMapRow> {
  const localValue = input.localValue.trim();
  if (!localValue) throw new AppError("VALIDATION", "A mapping needs the local category value it is for");
  const categoryId = input.categoryId.trim();
  if (!categoryId) throw new AppError("VALIDATION", "A mapping needs a marketplace category");
  // The sync id comes from a path. Writing the row under the CALLER's tenant
  // already makes it unreadable to anyone else, so this is not a leak — it is
  // what stops an operator quietly filling their workspace with mappings
  // attached to a sync that is not theirs and that will never read them.
  await loadListingSync(ctx, tenantId, input.syncId);

  const t = mapsTableFor(ctx.dialect);
  const now = new Date();
  const attributes = input.attributes ?? {};
  await (ctx.db as AnyDb)
    .insert(t)
    .values({
      id: crypto.randomUUID(),
      tenantId,
      syncId: input.syncId,
      localValue,
      categoryId,
      attributes,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [t.syncId, t.localValue],
      set: { categoryId, attributes, updatedAt: now },
    });

  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.syncId, input.syncId), eq(t.localValue, localValue)))) as ListingMapRow[];
  if (!row) throw new AppError("NOT_FOUND", "The mapping could not be read back");
  return row;
}

/**
 * This sync's batches, newest first — the operator's record of what was sent.
 *
 * `sent` is deliberately not returned. It is a map of every barcode in the
 * batch to the row it came from, which is the whole payload again in a
 * different shape; what a reader needs is how many units are outstanding and
 * whether anything went wrong.
 */
export async function listListingBatches(
  ctx: Ctx,
  tenantId: string,
  syncId: string,
): Promise<
  {
    id: string;
    batchId: string;
    status: string;
    unitCount: number;
    pendingCount: number;
    error: string | null;
    createdAt: Date | number | null;
    resolvedAt: Date | number | null;
  }[]
> {
  const t = batchesTableFor(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.syncId, syncId)))
    .orderBy(desc(t.createdAt))
    .limit(50)) as ListingBatchRow[];
  return rows.map((b) => ({
    id: b.id,
    batchId: b.batchId,
    status: b.status,
    unitCount: Object.keys(b.sent ?? {}).length,
    pendingCount: b.pendingCount,
    error: b.error,
    createdAt: b.createdAt,
    resolvedAt: b.resolvedAt,
  }));
}

export async function deleteListingMap(ctx: Ctx, tenantId: string, id: string): Promise<void> {
  const t = mapsTableFor(ctx.dialect);
  await (ctx.db as AnyDb).delete(t).where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
}

// ── Publishing ───────────────────────────────────────────────────────────────

export interface ListingRunResult {
  /** Units handed to the marketplace. */
  sent: number;
  /** Units the provider refused before anything was queued. */
  rejected: number;
  /** Products skipped because their local category is not mapped yet. */
  unmapped: number;
  /** The ticket, or null when nothing was queued. */
  batchId: string | null;
}

/**
 * Read one mapped value off a row.
 *
 * Everything a marketplace receives is a string on the wire, but a collection
 * column may be a number, a boolean or JSON — so `undefined` is the only thing
 * treated as absent. A `0` quantity and an empty title are real answers and the
 * provider is the one entitled to refuse them.
 */
const project = (
  row: Record<string, unknown>,
  mapping: Record<string, string>,
  allowed: Set<string> | null,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(mapping)) {
    if (allowed && !allowed.has(column)) continue;
    const v = row[field];
    if (v !== undefined) out[column] = v;
  }
  return out;
};

/** The attribute bindings for one unit, resolved against its own row first. */
const bindAttributes = (
  map: ListingMapRow,
  variantRow: Record<string, unknown>,
  productRow: Record<string, unknown>,
): ListingVariant["attributes"] => {
  const out: { attributeId: string; valueId?: string; custom?: string }[] = [];
  for (const [attributeId, binding] of Object.entries(map.attributes ?? {})) {
    if (binding.valueId) {
      out.push({ attributeId, valueId: binding.valueId });
      continue;
    }
    if (binding.field) {
      // The variant is asked first on purpose: a varianter attribute (size,
      // colour) is exactly the column that differs per unit, and falling back
      // to the product would give every unit the same value and collapse the
      // variants into one.
      const raw = variantRow[binding.field] ?? productRow[binding.field];
      const custom = raw === undefined || raw === null ? "" : String(raw).trim();
      if (custom) out.push({ attributeId, custom });
      continue;
    }
    if (binding.custom) out.push({ attributeId, custom: binding.custom });
  }
  return out;
};

/**
 * Publish one listing sync's products.
 *
 * Deliberately NOT resumable by watermark the way a push is. A push mirrors and
 * may re-send freely; a publish costs a listing at the far end, so the run
 * takes one bounded batch and reports what it did. The operator (or the
 * schedule) asks again for the next one.
 */
export async function runListingSync(
  ctx: Ctx,
  tenantId: string,
  syncId: string,
  opts: { fetchImpl?: Parameters<typeof publishListings>[2] } = {},
): Promise<ListingRunResult> {
  const { row, integration, config } = await loadListingSync(ctx, tenantId, syncId);
  const kind = integration.kind;
  const block = listingFor(kind);
  if (!block) throw new AppError("VALIDATION", `${kind} cannot list products`);

  const categoryField = row.categoryField?.trim();
  if (!categoryField) {
    throw new AppError("VALIDATION", "This sync has no category field — say which column names the local category");
  }

  const collection = await loadCollection(ctx, tenantId, row.collection);
  const maps = new Map((await listListingMaps(ctx, tenantId, syncId)).map((m) => [m.localValue, m]));

  // A workspace that models variants points at the child collection through the
  // same `childMappings` a pull uses, read in the other direction.
  const variantSpec = row.childMappings?.[LISTING_VARIANT_GROUP] ?? null;
  const variantCollection = variantSpec ? await loadCollection(ctx, tenantId, variantSpec.collection) : null;

  const productColumns = new Set((listingColumnsFor(kind, row.settings, "product") ?? []).map((c) => c.value));
  const variantColumns = new Set((listingColumnsFor(kind, row.settings, "variant") ?? []).map((c) => c.value));
  // With no variant collection the product row IS the unit, so it is projected
  // through both lists — which is what makes "no variants" a configuration
  // rather than a branch every provider would have to write.
  const unitColumns = variantCollection ? variantColumns : new Set([...productColumns, ...variantColumns]);

  const where = collection.tenantScoped
    ? sql`${sql.identifier("tenant_id")} = ${tenantId}`
    : sql`1 = 1`;
  const products = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(collection.physicalTable)} WHERE ${where} ORDER BY ${sql.identifier(collection.pkColumn)} ASC LIMIT ${PUBLISH_BATCH}`,
  );

  const payload: ListingProduct[] = [];
  const sent: Record<string, SentUnit> = {};
  let unmapped = 0;

  for (const productRow of products) {
    const productId = String(productRow[collection.pkColumn] ?? "");
    if (!productId) continue;
    const localValue = String(productRow[categoryField] ?? "").trim();
    const map = localValue ? maps.get(localValue) : undefined;
    if (!map) {
      // Counted, never silent. A product whose category nobody mapped is the
      // single most likely reason a run looks like it did nothing.
      unmapped++;
      continue;
    }

    // Scoped by tenant as well as by parent. The parent id is a UUID so a
    // cross-workspace collision is implausible — but "implausible" is not the
    // standard a row-reading query is held to here, and the push path scopes.
    const variantWhere = variantCollection?.tenantScoped
      ? sql`${sql.identifier("tenant_id")} = ${tenantId} AND ${sql.identifier(variantSpec!.parentField)} = ${productId}`
      : sql`${sql.identifier(variantSpec?.parentField ?? "id")} = ${productId}`;
    const unitRows = variantCollection
      ? await queryAll<Record<string, unknown>>(
          ctx,
          // A product with more variants than this publishes the first page and
          // the rest on the next run, because the reference of an already-sent
          // unit is skipped. Bounded rather than unbounded on purpose: one
          // product must not be able to fill a whole invocation's budget.
          sql`SELECT * FROM ${sql.identifier(variantCollection.physicalTable)} WHERE ${variantWhere} ORDER BY ${sql.identifier(variantCollection.pkColumn)} ASC LIMIT ${PUBLISH_BATCH}`,
        )
      : [productRow];
    const unitCollection = variantCollection ?? collection;
    const unitMapping = variantCollection ? (variantSpec!.mapping ?? {}) : row.mapping;

    const variants: ListingVariant[] = [];
    for (const unitRow of unitRows) {
      const fields = project(unitRow, unitMapping, unitColumns);
      const reference = String(fields[block.referenceColumn] ?? "").trim();
      // No reference means no way to match a verdict back. Sending it anyway
      // would list the product and then lose the answer, which is worse than
      // not listing it — so it is left for the next run, once the column is
      // filled.
      if (!reference || sent[reference]) continue;
      const rowId = String(unitRow[unitCollection.pkColumn] ?? "");
      if (!rowId) continue;
      variants.push({ rowId, reference, fields, attributes: bindAttributes(map, unitRow, productRow) });
      sent[reference] = { rowId, collection: unitCollection.slug };
    }
    if (variants.length === 0) continue;

    payload.push({
      rowId: productId,
      // Stable across runs: it is what makes several barcodes one product page
      // at the marketplace, and a changed value orphans that page.
      groupId: productId,
      categoryId: map.categoryId,
      fields: project(productRow, row.mapping, productColumns),
      variants,
    });
  }

  if (payload.length === 0) {
    return { sent: 0, rejected: 0, unmapped, batchId: null };
  }

  let batch: Awaited<ReturnType<typeof publishListings>>;
  try {
    batch = await publishListings(
      kind,
      { config, settings: row.settings ?? {}, products: payload, connectionKey: integration.id },
      opts.fetchImpl,
    );
  } catch (e) {
    await noteRunFailure(ctx, row, e);
    throw e;
  }

  // Refusals the provider made before queueing anything are already final, so
  // they are written now rather than waited for.
  if (batch.rejected?.length) await applyVerdicts(ctx, tenantId, row, sent, batch.rejected);

  const queued = Object.keys(sent).length - (batch.rejected?.length ?? 0);
  if (batch.batchId) {
    await recordBatch(ctx, {
      tenantId,
      syncId: row.id,
      integrationId: integration.id,
      batchId: batch.batchId,
      sent,
      pendingCount: Math.max(0, queued),
    });
  }

  return {
    sent: Math.max(0, queued),
    rejected: batch.rejected?.length ?? 0,
    unmapped,
    batchId: batch.batchId || null,
  };
}

// ── Polling ──────────────────────────────────────────────────────────────────

/**
 * Ask every open batch what became of it.
 *
 * Runs on its own schedule, deliberately: `enqueueDueSyncs` only considers
 * syncs with an interval, and a listing sync defaults to manual. Without this
 * an operator who clicked "publish" would never be told whether it worked.
 */
export async function enqueueOpenListingBatches(ctx: Ctx): Promise<number> {
  const t = batchesTableFor(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.status, "open"))
    .orderBy(asc(t.createdAt))
    .limit(POLL_BATCH_LIMIT)) as ListingBatchRow[];

  await Promise.all(
    rows.map((b) =>
      enqueueJob(ctx, {
        type: "integration.listing-poll",
        queue: "integrations",
        tenantId: b.tenantId,
        payload: { batchId: b.id },
      }),
    ),
  );
  return rows.length;
}

/**
 * Poll one batch and write what it says onto the rows that asked.
 *
 * A batch is closed only when nothing is pending. A provider that has forgotten
 * the ticket — Trendyol keeps results for four hours — throws, and the breaker
 * on the sync is what eventually stops the asking; the batch's own `error`
 * records why for the operator.
 */
export async function pollListingBatchRow(
  ctx: Ctx,
  tenantId: string,
  id: string,
  opts: { fetchImpl?: Parameters<typeof pollListingBatch>[2] } = {},
): Promise<{ applied: number; pending: number; closed: boolean }> {
  const t = batchesTableFor(ctx.dialect);
  const [batch] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as ListingBatchRow[];
  if (!batch) throw new AppError("NOT_FOUND", "Listing batch not found");
  if (batch.status !== "open") return { applied: 0, pending: 0, closed: true };

  const { row, integration, config } = await loadListingSync(ctx, tenantId, batch.syncId);

  let verdicts: ListingVerdict[];
  try {
    verdicts = await pollListingBatch(
      integration.kind,
      {
        config,
        settings: row.settings ?? {},
        batchId: batch.batchId,
        // The engine drops anything this batch never carried, so a provider
        // that reports a whole queue cannot write another sync's rows.
        known: Object.keys(batch.sent ?? {}),
        connectionKey: integration.id,
      },
      opts.fetchImpl,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await (ctx.db as AnyDb)
      .update(t)
      .set({ error: message.slice(0, 500) })
      .where(eq(t.id, batch.id));
    await noteRunFailure(ctx, row, e);
    throw e;
  }

  const settled = verdicts.filter((v) => v.status !== "pending");
  const applied = await applyVerdicts(ctx, tenantId, row, batch.sent ?? {}, settled);

  const pending = verdicts.filter((v) => v.status === "pending").length;
  const closed = pending === 0;
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      pendingCount: pending,
      ...(closed ? { status: "settled", resolvedAt: new Date(), error: null } : {}),
    })
    .where(eq(t.id, batch.id));

  return { applied, pending, closed };
}

/**
 * Write verdicts onto the rows that asked for them.
 *
 * Grouped by collection because a batch may legitimately span one — the product
 * collection when a workspace models no variants, the variant collection when
 * it does — and `ingestRows` writes into one table per call.
 */
const applyVerdicts = async (
  ctx: Ctx,
  tenantId: string,
  row: SyncRow,
  sent: Record<string, SentUnit>,
  verdicts: readonly ListingVerdict[],
): Promise<number> => {
  const outputs = row.outputsMapping ?? {};
  if (Object.keys(outputs).length === 0 || verdicts.length === 0) return 0;

  const byCollection = new Map<string, Record<string, unknown>[]>();
  for (const v of verdicts) {
    const unit = sent[v.reference];
    // A verdict for something this batch never sent has no row to land on. The
    // engine already filters these, so reaching here means the provider echoed
    // something we did not send — dropped rather than guessed at.
    if (!unit) continue;
    const values: Record<string, unknown> = {
      listingStatus: v.status,
      listingId: v.externalId ?? null,
      listingError: v.errors?.length ? v.errors.join("; ").slice(0, 1000) : null,
      listedAt: v.status === "accepted" ? new Date().toISOString() : null,
    };
    const patch: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(outputs)) {
      if (values[key] !== undefined) patch[field] = values[key];
    }
    if (Object.keys(patch).length === 0) continue;
    const list = byCollection.get(unit.collection) ?? [];
    list.push({ __rowId: unit.rowId, ...patch });
    byCollection.set(unit.collection, list);
  }

  let applied = 0;
  for (const [slug, rows] of byCollection) {
    const collection = await loadCollection(ctx, tenantId, slug);
    const patches = rows.map(({ __rowId, ...rest }) => ({ [collection.pkColumn]: __rowId, ...rest }));
    // `patch`, not `upsert`: a verdict is the two or three things the
    // marketplace decided, not the row. An upsert plans a column for every
    // field the collection has, so recording an approval would blank the
    // product's title, price and images on its way past.
    const out = await ingestRows(ctx, collection, tenantId, patches, { mode: "patch" });
    applied += out.inserted + out.updated;
    if (out.failed.length > 0) {
      throw new AppError(
        "VALIDATION",
        `writing listing verdicts to "${slug}" failed: ${out.failed[0]?.error ?? "unknown"}`,
      );
    }
  }
  return applied;
};

// ── Shared ───────────────────────────────────────────────────────────────────

const recordBatch = async (
  ctx: Ctx,
  input: {
    tenantId: string;
    syncId: string;
    integrationId: string;
    batchId: string;
    sent: Record<string, SentUnit>;
    pendingCount: number;
  },
): Promise<void> => {
  const t = batchesTableFor(ctx.dialect);
  await (ctx.db as AnyDb)
    .insert(t)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      syncId: input.syncId,
      integrationId: input.integrationId,
      batchId: input.batchId,
      status: "open",
      sent: input.sent,
      pendingCount: input.pendingCount,
      createdAt: new Date(),
    })
    // A retried publish that reached the provider before failing on our side
    // gets the SAME ticket back. Opening a second row for it would double every
    // verdict; the unique index is what makes this an update.
    .onConflictDoUpdate({
      target: [t.syncId, t.batchId],
      set: { sent: input.sent, pendingCount: input.pendingCount, status: "open" },
    });
};

/** Fold a failure into the sync's breaker, exactly as a pull or push does. */
const noteRunFailure = async (ctx: Ctx, row: SyncRow, e: unknown): Promise<void> => {
  const t = (ctx.dialect === "pg" ? pg.schema.integrationSyncs : sqlite.schema.integrationSyncs) as typeof pg.schema.integrationSyncs;
  const message = e instanceof Error ? e.message : String(e);
  // A 429 is "busy", not "broken" — the same call the delivery and sync paths
  // make, and the reason a marketplace with a per-second quota does not pause
  // a healthy connection after five busy runs.
  const held = isRateLimited(e);
  const next = held ? (row.consecutiveFailures ?? 0) : (row.consecutiveFailures ?? 0) + 1;
  await (ctx.db as AnyDb)
    .update(t)
    .set({ lastRunAt: new Date(), lastError: message.slice(0, 500), consecutiveFailures: next, updatedAt: new Date() })
    .where(eq(t.id, row.id));
};

/** Load a listing sync with its connection, refusing anything else. */
const loadListingSync = async (
  ctx: Ctx,
  tenantId: string,
  syncId: string,
): Promise<{
  row: SyncRow;
  integration: { id: string; kind: string };
  config: Record<string, unknown>;
}> => {
  const st = (ctx.dialect === "pg" ? pg.schema.integrationSyncs : sqlite.schema.integrationSyncs) as typeof pg.schema.integrationSyncs;
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(st)
    .where(and(eq(st.tenantId, tenantId), eq(st.id, syncId)))) as SyncRow[];
  if (!row) throw new AppError("NOT_FOUND", "Sync not found");
  if (row.direction !== "listing") {
    throw new AppError("VALIDATION", `Sync "${syncId}" is a ${row.direction} sync, not a listing`);
  }

  const it = (ctx.dialect === "pg" ? pg.schema.integrations : sqlite.schema.integrations) as typeof pg.schema.integrations;
  const [integration] = (await (ctx.db as AnyDb)
    .select()
    .from(it)
    .where(and(eq(it.tenantId, tenantId), eq(it.id, row.integrationId)))) as ConnectionRow[];
  if (!integration) throw new AppError("NOT_FOUND", "Integration not found");

  // A publish or a poll is minutes-to-hours after the connect, which is exactly
  // where an un-renewed access token turns into a batch that never gets a
  // verdict.
  const config = await connectionConfigFor(ctx, integration, ctx.env.AUTH_SECRET);
  return { row, integration: { id: integration.id, kind: integration.kind }, config };
};
