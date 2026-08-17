/**
 * Schema versions — migration diffing / schema branching (#9).
 *
 * backlex's schema is dynamic: a collection is a metadata row + a physical
 * table the additive applier (`applyCollection`) maintains. This service adds
 * GitOps-for-schema on top of that model:
 *
 *   - **snapshot** — capture the schema-relevant subset of the live `collections`
 *     rows (`SchemaCollection[]`) as an immutable, content-hashed row.
 *   - **branch** — a named, mutable pointer (`head`) into snapshot history with a
 *     `base` fork point; lets an admin stage schema changes off to the side.
 *   - **diff** — compare any two refs (live / snapshot / branch) into a
 *     categorized change list (additive / destructive / metadata) via the pure
 *     `diffSchema` engine in `@backlex/db`.
 *   - **apply** — reconcile the live schema to a target ref: additive changes go
 *     through the idempotent applier, destructive ones (drop column/table, type
 *     change) only run behind an explicit `confirmDestructive`, and a safety
 *     snapshot is captured first so an apply is always reversible.
 *
 * All DDL stays behind the same `applyCollection` / `dropField` / `dropCollection`
 * primitives the unified create endpoint uses — this service never emits raw DDL.
 */
import { AppError } from "@backlex/core";
import {
  applyCollection,
  canonicalizeDocument,
  derivePhysicalTable,
  diffDocument,
  dropCollection,
  dropField,
  type FieldDef,
  readDocument,
  type SchemaCollection,
  type SchemaDiff,
  type SchemaDocument,
  type SchemaSnapshot,
  validateFields,
} from "@backlex/db";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, desc, eq } from "drizzle-orm";
import { invalidateTenantCollections } from "./collections-cache";
import { CONFIG_RESOURCES, configResource, loadLiveConfig } from "./config-resources";
import { invalidateTenantPermissions } from "./permissions-cache";
import { seedOwnerScopedPermissions } from "./seed";
import { snapshotBeforeDrop } from "./backup";
import type { Ctx } from "../context";
import { loadAppSettings } from "./settings";

type Dialect = "pg" | "sqlite";
// The Pg/Sqlite Drizzle union has no shared typed surface — the whole codebase
// casts to `any` at these call sites (see routes/items.ts, routes/collections.ts).
type AnyDb = any;

export interface SchemaVersionsCtx {
  db: AnyDb;
  dialect: Dialect;
  /**
   * Storage adapter, when the caller has one.
   *
   * Present → every destructive change in an apply captures a **data** snapshot
   * before the DDL runs. `captureSnapshot` below is a SCHEMA snapshot: it
   * records what the columns were, not what was in them, so on its own it makes
   * an apply reversible in shape and irreversible in content.
   *
   * Optional rather than required because this type is also used by callers that
   * only read (`loadLiveSchema`, `diffSchema`). When it is absent the drops still
   * happen — refusing would break every existing caller — and `applySchema`
   * reports `dataSnapshotIds: []` so nobody is told a safety net exists that
   * does not.
   */
  storage?: Ctx["storage"];
}

/** Where a schema state comes from: the live workspace schema, a stored
 *  snapshot, or a branch head. The single ref shape every op resolves. */
export type SchemaRef =
  | { kind: "live" }
  | { kind: "snapshot"; id: string }
  | { kind: "branch"; id: string };

export interface SnapshotSummary {
  id: string;
  name: string;
  note: string | null;
  hash: string;
  kind: string;
  branchId: string | null;
  parentSnapshotId: string | null;
  createdBy: string | null;
  createdAt: unknown;
  collectionCount: number;
}

export interface SnapshotRecord extends SnapshotSummary {
  snapshot: SchemaSnapshot;
}

export interface BranchRecord {
  id: string;
  name: string;
  note: string | null;
  headSnapshotId: string | null;
  baseSnapshotId: string | null;
  createdBy: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface ApplyResult {
  diff: SchemaDiff;
  /** Change summaries that were applied (empty on a no-op). */
  applied: string[];
  /** Id of the auto safety SCHEMA snapshot taken before applying (null on a
   *  no-op). Records what the columns were, not what was in them. */
  safetySnapshotId: string | null;
  /** Ids of the `pre-drop` DATA backups captured for each destructive change.
   *  Empty when the apply was non-destructive, or when the caller supplied no
   *  storage adapter — in which case no safety copy of the rows exists. */
  dataSnapshotIds: string[];
  noop: boolean;
}

const collectionsTable = (d: Dialect) =>
  d === "pg" ? pg.schema.collections : sqlite.schema.collections;
const snapshotsTable = (d: Dialect) =>
  d === "pg" ? pg.schema.schemaSnapshots : sqlite.schema.schemaSnapshots;
const branchesTable = (d: Dialect) =>
  d === "pg" ? pg.schema.schemaBranches : sqlite.schema.schemaBranches;

/** Project a `collections` row onto the schema-relevant subset we snapshot.
 *  Runtime/lifecycle columns (id, status, timestamps, vectorize model) are
 *  intentionally dropped — they don't define the *shape* of the schema. */
const rowToSchemaCollection = (r: Record<string, unknown>): SchemaCollection => ({
  slug: String(r.slug),
  physicalTable: r.physicalTable ? String(r.physicalTable) : undefined,
  adopted: Boolean(r.adopted),
  ownerScoped: Boolean(r.ownerScoped),
  tenantScoped: r.tenantScoped !== false,
  versioned: Boolean(r.versioned),
  softDelete: Boolean(r.softDelete),
  fts: Boolean(r.fts),
  singleton: Boolean(r.singleton),
  fields: (Array.isArray(r.fields) ? r.fields : []) as FieldDef[],
  singular: (r.singular as string | null) ?? null,
  plural: (r.plural as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  displayTemplate: (r.displayTemplate as string | null) ?? null,
  defaultSort: (r.defaultSort as string | null) ?? null,
  icon: (r.icon as string | null) ?? null,
  color: (r.color as string | null) ?? null,
  previewUrl: (r.previewUrl as string | null) ?? null,
  hidden: Boolean(r.hidden),
});

/** Canonicalize a collection the same way `rowToSchemaCollection` does, so an
 *  authored/imported snapshot diffs cleanly against the live schema instead of
 *  tripping on implicit flag defaults (notably `tenantScoped`, which is true by
 *  default — an omitted flag must not read as a "disable" change). */
const normalizeCollection = (c: SchemaCollection): SchemaCollection => ({
  slug: c.slug,
  physicalTable: c.physicalTable,
  adopted: Boolean(c.adopted),
  ownerScoped: Boolean(c.ownerScoped),
  tenantScoped: c.tenantScoped !== false,
  versioned: Boolean(c.versioned),
  softDelete: Boolean(c.softDelete),
  fts: Boolean(c.fts),
  singleton: Boolean(c.singleton),
  fields: Array.isArray(c.fields) ? c.fields : [],
  singular: c.singular ?? null,
  plural: c.plural ?? null,
  note: c.note ?? null,
  displayTemplate: c.displayTemplate ?? null,
  defaultSort: c.defaultSort ?? null,
  icon: c.icon ?? null,
  color: c.color ?? null,
  previewUrl: c.previewUrl ?? null,
  hidden: Boolean(c.hidden),
});

const normalizeSnapshot = (snap: SchemaSnapshot): SchemaSnapshot => snap.map(normalizeCollection);

/** The live schema of a workspace — its active collections, normalized. */
export const loadLiveSchema = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
): Promise<SchemaSnapshot> => {
  const t = collectionsTable(ctx.dialect);
  const rows = (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.status, "active")))) as Record<string, unknown>[];
  return rows.map(rowToSchemaCollection);
};

/**
 * The whole live workspace — its collections AND its config resources.
 *
 * `loadLiveSchema` above is the collections half and stays exactly what it was,
 * because `executeDiff` and every existing caller are written against it. This
 * is the pair, and it is what a snapshot now captures.
 */
export const loadLiveDocument = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
): Promise<SchemaDocument> => ({
  collections: await loadLiveSchema(ctx, tenantId),
  config: await loadLiveConfig(ctx, tenantId),
});

/** {@link resolveRef}, returning both halves. */
export const resolveDocument = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  ref: SchemaRef,
): Promise<{ data: SchemaDocument; label: string }> => {
  if (ref.kind === "live") {
    return { data: await loadLiveDocument(ctx, tenantId), label: "live" };
  }
  if (ref.kind === "snapshot") {
    const s = await getSnapshot(ctx, tenantId, ref.id);
    return { data: readDocument(s.snapshot), label: `snapshot:${s.name}` };
  }
  const b = await getBranch(ctx, tenantId, ref.id);
  if (!b.headSnapshotId) return { data: { collections: [] }, label: `branch:${b.name}` };
  const s = await getSnapshot(ctx, tenantId, b.headSnapshotId);
  return { data: readDocument(s.snapshot), label: `branch:${b.name}` };
};

const sha256Hex = async (text: string): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const toSummary = (r: Record<string, unknown>): SnapshotSummary => ({
  id: String(r.id),
  name: String(r.name),
  note: (r.note as string | null) ?? null,
  hash: String(r.hash),
  kind: String(r.kind),
  branchId: (r.branchId as string | null) ?? null,
  parentSnapshotId: (r.parentSnapshotId as string | null) ?? null,
  createdBy: (r.createdBy as string | null) ?? null,
  createdAt: r.createdAt,
  collectionCount: readDocument(r.snapshot).collections.length,
});

// ── Snapshots ──────────────────────────────────────────────────────────────

export const captureSnapshot = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  opts: {
    name: string;
    note?: string | null;
    createdBy?: string | null;
    kind?: "manual" | "branch" | "auto" | "scheduled";
    branchId?: string | null;
    parentSnapshotId?: string | null;
    /** Pre-resolved state to store; defaults to the live document. Accepts a
     *  bare collections array too, which is what every caller passed before
     *  config joined. */
    data?: SchemaSnapshot | SchemaDocument;
  },
): Promise<SnapshotRecord> => {
  const doc = opts.data ? readDocument(opts.data) : await loadLiveDocument(ctx, tenantId);
  // A configless document canonicalizes to exactly what a bare array did, so
  // hashes already in this table stay valid and a collections-only capture is
  // byte-identical to the one it would have produced yesterday.
  const hash = await sha256Hex(canonicalizeDocument(doc));
  const snapshot = doc;
  const id = crypto.randomUUID();
  const t = snapshotsTable(ctx.dialect);
  await ctx.db.insert(t).values({
    id,
    tenantId,
    name: opts.name,
    note: opts.note ?? null,
    snapshot,
    hash,
    kind: opts.kind ?? "manual",
    branchId: opts.branchId ?? null,
    parentSnapshotId: opts.parentSnapshotId ?? null,
    createdBy: opts.createdBy ?? null,
  });
  const row = await getSnapshotRow(ctx, tenantId, id);
  if (!row) throw new AppError("INTERNAL", "Snapshot insert did not persist");
  return { ...toSummary(row), snapshot: (row.snapshot as SchemaSnapshot) ?? [] };
};

/** Slug rule mirrors the collections create route (snake_case, leading letter). */
const SLUG_RE = /^[a-z][a-z0-9_]*$/;

/** Store an externally-authored schema as a snapshot — the GitOps entry point.
 *  An admin can export the schema JSON, edit it (in git, by hand, in another
 *  workspace), and import it back as a target to diff/apply. Validates each
 *  collection's slug + fields so a malformed import can't reach `applySchema`. */
export const importSnapshot = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  opts: {
    name: string;
    /** A bare collections array (what an export was before config joined) or a
     *  whole document. Both are accepted, because this is the GitOps entry
     *  point: an admin exports the JSON, edits it in git, and imports it back —
     *  and a document that could be exported but not re-imported would break
     *  exactly the loop this function exists for. */
    snapshot: SchemaSnapshot | SchemaDocument;
    note?: string | null;
    createdBy?: string | null;
  },
): Promise<SnapshotRecord> => {
  if (!opts.snapshot || typeof opts.snapshot !== "object") {
    throw new AppError("VALIDATION", "snapshot must be an array of collections or a document");
  }
  const doc = readDocument(opts.snapshot);
  if (!Array.isArray(opts.snapshot) && !Array.isArray((opts.snapshot as SchemaDocument).collections)) {
    throw new AppError("VALIDATION", "snapshot.collections must be an array");
  }
  // Config rows are checked for the one thing this layer can check without
  // knowing a resource: that each is an object carrying a natural key. The
  // resource itself validates its own shape when the apply reaches it, which is
  // the same split the collection half uses (`validateFields` here, the applier
  // later).
  for (const [resource, items] of Object.entries(doc.config ?? {})) {
    if (!Array.isArray(items)) {
      throw new AppError("VALIDATION", `config.${resource} must be an array`);
    }
    if (!configResource(resource)) {
      throw new AppError("VALIDATION", `Unknown config resource: ${resource}`);
    }
    const keys = new Set<string>();
    for (const item of items) {
      const key = (item as { key?: unknown })?.key;
      if (typeof key !== "string" || key === "") {
        throw new AppError("VALIDATION", `config.${resource}: every entry needs a "key"`);
      }
      if (keys.has(key)) {
        throw new AppError("VALIDATION", `config.${resource}: duplicate key "${key}"`);
      }
      keys.add(key);
    }
  }
  const seen = new Set<string>();
  for (const c of doc.collections) {
    if (!c || typeof c.slug !== "string" || !SLUG_RE.test(c.slug)) {
      throw new AppError("VALIDATION", `Invalid collection slug: ${JSON.stringify(c?.slug)}`);
    }
    if (seen.has(c.slug)) throw new AppError("VALIDATION", `Duplicate collection slug: ${c.slug}`);
    seen.add(c.slug);
    if (!Array.isArray(c.fields)) {
      throw new AppError("VALIDATION", `${c.slug}: fields must be an array`);
    }
    try {
      validateFields(c.fields);
    } catch (e) {
      throw new AppError("VALIDATION", `${c.slug}: ${(e as Error).message}`);
    }
  }
  return captureSnapshot(ctx, tenantId, {
    name: opts.name,
    note: opts.note,
    createdBy: opts.createdBy,
    kind: "manual",
    data: {
      collections: normalizeSnapshot(doc.collections),
      ...(doc.config ? { config: doc.config } : {}),
    },
  });
};

export const listSnapshots = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
): Promise<SnapshotSummary[]> => {
  const t = snapshotsTable(ctx.dialect);
  const rows = (await ctx.db
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(desc(t.createdAt))) as Record<string, unknown>[];
  return rows.map(toSummary);
};

const getSnapshotRow = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  id: string,
): Promise<Record<string, unknown> | undefined> => {
  const t = snapshotsTable(ctx.dialect);
  const rows = (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
    .limit(1)) as Record<string, unknown>[];
  return rows[0];
};

export const getSnapshot = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  id: string,
): Promise<SnapshotRecord> => {
  const row = await getSnapshotRow(ctx, tenantId, id);
  if (!row) throw new AppError("NOT_FOUND", "Snapshot not found");
  return { ...toSummary(row), snapshot: (row.snapshot as SchemaSnapshot) ?? [] };
};

export const deleteSnapshot = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = snapshotsTable(ctx.dialect);
  const branches = branchesTable(ctx.dialect);
  // Refuse to delete a snapshot that is a branch head — it would orphan the
  // branch. The admin must delete the branch first.
  const ref = (await ctx.db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.headSnapshotId, id)))
    .limit(1)) as { id: string }[];
  if (ref[0]) {
    throw new AppError("CONFLICT", "Snapshot is a branch head — delete the branch first");
  }
  await ctx.db.delete(t).where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
};

// ── Branches ───────────────────────────────────────────────────────────────

const BRANCH_NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;

const toBranch = (r: Record<string, unknown>): BranchRecord => ({
  id: String(r.id),
  name: String(r.name),
  note: (r.note as string | null) ?? null,
  headSnapshotId: (r.headSnapshotId as string | null) ?? null,
  baseSnapshotId: (r.baseSnapshotId as string | null) ?? null,
  createdBy: (r.createdBy as string | null) ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export const createBranch = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  opts: { name: string; note?: string | null; createdBy?: string | null; fromSnapshotId?: string | null },
): Promise<BranchRecord> => {
  if (!BRANCH_NAME.test(opts.name)) {
    throw new AppError("VALIDATION", "Branch name must be 1–64 chars: letters, digits, . _ / -");
  }
  const branches = branchesTable(ctx.dialect);
  const dup = (await ctx.db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.name, opts.name)))
    .limit(1)) as { id: string }[];
  if (dup[0]) throw new AppError("CONFLICT", `Branch "${opts.name}" already exists`);

  // Seed the branch head from a snapshot or from the live schema.
  const data = opts.fromSnapshotId
    ? (await getSnapshot(ctx, tenantId, opts.fromSnapshotId)).snapshot
    : await loadLiveSchema(ctx, tenantId);
  const head = await captureSnapshot(ctx, tenantId, {
    name: `${opts.name} (branch base)`,
    kind: "branch",
    data,
    createdBy: opts.createdBy,
  });

  const id = crypto.randomUUID();
  await ctx.db.insert(branches).values({
    id,
    tenantId,
    name: opts.name,
    note: opts.note ?? null,
    headSnapshotId: head.id,
    baseSnapshotId: head.id,
    createdBy: opts.createdBy ?? null,
  });
  // Back-link the head snapshot to its branch.
  const snaps = snapshotsTable(ctx.dialect);
  await ctx.db.update(snaps).set({ branchId: id }).where(eq(snaps.id, head.id));
  return getBranch(ctx, tenantId, id);
};

export const listBranches = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
): Promise<BranchRecord[]> => {
  const t = branchesTable(ctx.dialect);
  const rows = (await ctx.db
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(desc(t.createdAt))) as Record<string, unknown>[];
  return rows.map(toBranch);
};

export const getBranch = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  id: string,
): Promise<BranchRecord> => {
  const t = branchesTable(ctx.dialect);
  const rows = (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
    .limit(1)) as Record<string, unknown>[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Branch not found");
  return toBranch(rows[0]);
};

/** Move a branch's head to a new snapshot built from `data` (an authored
 *  schema), a source snapshot, or the current live schema. This is how an
 *  admin stages changes on a branch before diffing/applying it. The new head
 *  is parented to the old one so the branch keeps a linear history. */
export const updateBranchHead = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  id: string,
  opts: { data?: SchemaSnapshot; fromSnapshotId?: string | null; createdBy?: string | null; name?: string },
): Promise<BranchRecord> => {
  const branch = await getBranch(ctx, tenantId, id);
  let data: SchemaSnapshot;
  if (opts.data) data = normalizeSnapshot(opts.data);
  else if (opts.fromSnapshotId) data = (await getSnapshot(ctx, tenantId, opts.fromSnapshotId)).snapshot;
  else data = await loadLiveSchema(ctx, tenantId);

  const head = await captureSnapshot(ctx, tenantId, {
    name: opts.name ?? `${branch.name} (head)`,
    kind: "branch",
    data,
    branchId: id,
    parentSnapshotId: branch.headSnapshotId,
    createdBy: opts.createdBy,
  });
  const branches = branchesTable(ctx.dialect);
  await ctx.db
    .update(branches)
    .set({ headSnapshotId: head.id, updatedAt: new Date() })
    .where(and(eq(branches.tenantId, tenantId), eq(branches.id, id)));
  return getBranch(ctx, tenantId, id);
};

export const deleteBranch = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const branch = await getBranch(ctx, tenantId, id);
  const branches = branchesTable(ctx.dialect);
  await ctx.db.delete(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, id)));
  // Drop the branch-owned snapshots (heads tagged with this branch id).
  const snaps = snapshotsTable(ctx.dialect);
  await ctx.db.delete(snaps).where(and(eq(snaps.tenantId, tenantId), eq(snaps.branchId, id)));
  void branch;
};

// ── Resolve / diff ───────────────────────────────────────────────────────────

export const resolveRef = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  ref: SchemaRef,
): Promise<{ data: SchemaSnapshot; label: string }> => {
  // Reads through `readDocument` so a stored envelope and a pre-envelope bare
  // array both answer, and hands back the COLLECTIONS half — every caller of
  // this function is written against a snapshot, and `resolveDocument` is the
  // one that wants both.
  if (ref.kind === "snapshot") {
    const s = await getSnapshot(ctx, tenantId, ref.id);
    return { data: readDocument(s.snapshot).collections, label: `snapshot:${s.name}` };
  }
  if (ref.kind === "branch") {
    const b = await getBranch(ctx, tenantId, ref.id);
    if (!b.headSnapshotId) return { data: [], label: `branch:${b.name}` };
    const s = await getSnapshot(ctx, tenantId, b.headSnapshotId);
    return { data: readDocument(s.snapshot).collections, label: `branch:${b.name}` };
  }
  return { data: await loadLiveSchema(ctx, tenantId), label: "live" };
};

export const diff = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  from: SchemaRef,
  to: SchemaRef,
): Promise<{ from: string; to: string; diff: SchemaDiff }> => {
  const a = await resolveDocument(ctx, tenantId, from);
  const b = await resolveDocument(ctx, tenantId, to);
  return { from: a.label, to: b.label, diff: diffDocument(a.data, b.data) };
};

// ── Apply ────────────────────────────────────────────────────────────────────

const upsertMetadata = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  tc: SchemaCollection,
  existing: SchemaCollection | undefined,
): Promise<{ physicalTable: string; isNew: boolean }> => {
  const t = collectionsTable(ctx.dialect);
  const managed = !tc.adopted;
  const physicalTable =
    (managed ? existing?.physicalTable : tc.physicalTable ?? existing?.physicalTable) ??
    derivePhysicalTable(tenantId, tc.slug);
  // Soft-delete needs a physical column → managed-only (mirrors create).
  const softDelete = managed ? Boolean(tc.softDelete) : false;
  const common = {
    singular: tc.singular ?? null,
    plural: tc.plural ?? null,
    note: tc.note ?? null,
    displayTemplate: tc.displayTemplate ?? null,
    fields: tc.fields,
    ownerScoped: Boolean(tc.ownerScoped),
    tenantScoped: tc.tenantScoped !== false,
    versioned: Boolean(tc.versioned),
    softDelete,
    singleton: Boolean(tc.singleton),
    fts: Boolean(tc.fts),
    defaultSort: tc.defaultSort ?? null,
    icon: tc.icon ?? null,
    color: tc.color ?? null,
    previewUrl: tc.previewUrl ?? null,
    hidden: Boolean(tc.hidden),
  };
  if (existing) {
    await ctx.db
      .update(t)
      .set({ ...common, updatedAt: new Date() })
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, tc.slug)));
    return { physicalTable, isNew: false };
  }
  await ctx.db.insert(t).values({
    id: crypto.randomUUID(),
    slug: tc.slug,
    tenantId,
    physicalTable,
    ...common,
    adopted: Boolean(tc.adopted),
    auditReads: false,
    vectorize: false,
    vectorizeModel: null,
    pkColumn: "id",
    hasCreatedAt: true,
    hasUpdatedAt: true,
    createdAtColumn: null,
    updatedAtColumn: null,
    ownerIdColumn: null,
    status: "active",
  });
  return { physicalTable, isNew: true };
};

/** Reconcile the live schema to `targetData`. Caller has already gated
 *  destructive changes; this runs the DDL + metadata writes in safe order:
 *  destructive drops → metadata upsert + additive apply → drop orphaned rows. */
const executeDiff = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  live: SchemaSnapshot,
  targetData: SchemaSnapshot,
  d: SchemaDiff,
  createdBy?: string | null,
): Promise<{ dataSnapshotIds: string[] }> => {
  const liveMap = new Map(live.map((c) => [c.slug, c]));
  const targetMap = new Map(targetData.map((c) => [c.slug, c]));
  const t = collectionsTable(ctx.dialect);
  const dataSnapshotIds: string[] = [];

  // 1. Destructive drops first (managed only — adopted tables are never DDL'd).
  //
  // Each one captures its data first, when the caller gave us a storage adapter.
  // This route reaches the SAME `dropField` / `dropCollection` the collections
  // endpoints do, from REST, the SDK, the CLI, MCP and GraphQL — so a guard
  // living in those handlers would have covered none of this. That is why the
  // snapshot is a service both callers invoke rather than route-local code.
  for (const ch of d.changes) {
    if (ch.severity !== "destructive") continue;
    const lc = liveMap.get(ch.collection);
    if (!lc || lc.adopted) continue;
    const table = lc.physicalTable ?? derivePhysicalTable(tenantId, ch.collection);
    const tenantScoped = lc.tenantScoped !== false;
    const capture = async (
      columns: string[] | undefined,
      what: string,
      nonNullColumn?: string,
    ): Promise<void> => {
      if (!ctx.storage) return;
      const snap = await snapshotBeforeDrop(
        { db: ctx.db, dialect: ctx.dialect, storage: ctx.storage },
        {
          tenantId,
          userId: createdBy ?? null,
          table,
          columns,
          nonNullColumn,
          label: `Before schema apply: ${what} on ${ch.collection}`,
          tenantScoped,
        },
      );
      if (snap) dataSnapshotIds.push(snap.id);
    };
    if (ch.kind === "field.drop" && ch.field) {
      await capture(["id", ch.field], `drop ${ch.field}`, ch.field);
      await dropField(ctx.db, ctx.dialect, table, ch.field);
    } else if (ch.kind === "field.type" && ch.field) {
      // Drop the old column; the additive apply below re-adds it with the new
      // type. The values are NOT carried across (the diff summary warned), so
      // the snapshot is the only copy of them that survives.
      await capture(["id", ch.field], `retype ${ch.field}`, ch.field);
      await dropField(ctx.db, ctx.dialect, table, ch.field);
    } else if (ch.kind === "collection.drop") {
      await capture(undefined, "drop collection");
      await dropCollection(ctx.db, ctx.dialect, table, { adopted: false });
    }
  }

  // 2. Upsert metadata + run the additive applier for every target collection.
  for (const tc of targetData) {
    try {
      validateFields(tc.fields);
    } catch (e) {
      throw new AppError("VALIDATION", `${tc.slug}: ${(e as Error).message}`);
    }
    const existing = liveMap.get(tc.slug);
    const { physicalTable, isNew } = await upsertMetadata(ctx, tenantId, tc, existing);
    if (!tc.adopted) {
      await applyCollection(ctx.db, ctx.dialect, {
        table: physicalTable,
        fields: tc.fields,
        ownerScoped: Boolean(tc.ownerScoped),
        tenantScoped: tc.tenantScoped !== false,
        versioned: Boolean(tc.versioned),
        softDelete: Boolean(tc.softDelete),
        fts: Boolean(tc.fts),
        hasCreatedAt: true,
        hasUpdatedAt: true,
        adopted: false,
      });
      if (isNew && tc.ownerScoped) {
        await seedOwnerScopedPermissions({ db: ctx.db, dialect: ctx.dialect }, tenantId, tc.slug);
        invalidateTenantPermissions(tenantId);
      }
    }
  }

  // 3. Drop metadata rows for collections that vanished from the target.
  for (const lc of live) {
    if (targetMap.has(lc.slug)) continue;
    await ctx.db.delete(t).where(and(eq(t.tenantId, tenantId), eq(t.slug, lc.slug)));
  }

  return { dataSnapshotIds };
};

/**
 * Apply the config half of a diff.
 *
 * Walks the categorised changes rather than reconciling from scratch, so what
 * runs is exactly what the operator saw and confirmed — a resource whose rows
 * did not change is never written to, and a `config.drop` only happens because
 * the gate let it.
 *
 * Permission caches are invalidated after a role change for the same reason the
 * collections half invalidates its own: the next request must not answer from a
 * grant this apply just replaced.
 */
const applyConfigChanges = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  d: SchemaDiff,
  target: SchemaDocument,
): Promise<void> => {
  const configChanges = d.changes.filter((c) => c.kind.startsWith("config."));
  if (configChanges.length === 0) return;
  let touchedRoles = false;
  // In registry order, so a resource that names a role is applied after it.
  for (const resource of CONFIG_RESOURCES) {
    const mine = configChanges.filter((c) => c.collection === resource.key);
    if (mine.length === 0) continue;
    const wanted = new Map(
      (target.config?.[resource.key] ?? []).map((i) => [i.key, i] as const),
    );
    for (const c of mine) {
      const key = c.field as string;
      if (c.kind === "config.drop") {
        await resource.remove(ctx, tenantId, key);
      } else {
        const item = wanted.get(key);
        if (item) await resource.upsert(ctx, tenantId, item);
      }
    }
    if (resource.key === "roles") touchedRoles = true;
  }
  if (touchedRoles) invalidateTenantPermissions(tenantId);
};

export const applySchema = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  opts: { target: SchemaRef; confirmDestructive?: boolean; createdBy?: string | null },
): Promise<ApplyResult> => {
  const liveDoc = await loadLiveDocument(ctx, tenantId);
  const { data: targetDoc } = await resolveDocument(ctx, tenantId, opts.target);
  const live = liveDoc.collections;
  const targetData = targetDoc.collections;
  const d = diffDocument(liveDoc, targetDoc);

  if (d.counts.total === 0) {
    return { diff: d, applied: [], safetySnapshotId: null, dataSnapshotIds: [], noop: true };
  }
  if (d.hasDestructive && !opts.confirmDestructive) {
    throw new AppError(
      "VALIDATION",
      "This apply includes destructive changes. Re-send with confirmDestructive: true to proceed.",
      { destructive: d.changes.filter((c) => c.severity === "destructive") },
    );
  }

  // Safety net #1: the current live SCHEMA, so a bad apply can be rolled back by
  // applying the safety snapshot. Note what this does not cover — it records
  // what the columns were, not what was in them.
  const safety = await captureSnapshot(ctx, tenantId, {
    name: "Pre-apply safety snapshot",
    kind: "auto",
    // The whole document, not just the collections — otherwise rolling back an
    // apply that changed a role would restore the tables and leave the grant.
    data: liveDoc,
    createdBy: opts.createdBy,
  });

  // Safety net #2: the DATA each destructive change is about to destroy,
  // captured inside `executeDiff` immediately before the corresponding DDL.
  const { dataSnapshotIds } = await executeDiff(
    ctx,
    tenantId,
    live,
    targetData,
    d,
    opts.createdBy,
  );
  await applyConfigChanges(ctx, tenantId, d, targetDoc);
  invalidateTenantCollections(tenantId);

  return {
    diff: d,
    applied: d.changes.map((c) => c.summary),
    safetySnapshotId: safety.id,
    dataSnapshotIds,
    noop: false,
  };
};

// ── Scheduled auto-snapshots (cron) ──────────────────────────────────────────

const toMs = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const n = new Date(v as string).getTime();
  return Number.isFinite(n) ? n : 0;
};

const INTERVAL_MS: Record<"daily" | "weekly", number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Delete `scheduled`-kind snapshots for a tenant beyond the newest `keepLast`.
 *  Never touches manual/branch/auto snapshots. */
export const pruneScheduledSnapshots = async (
  ctx: SchemaVersionsCtx,
  tenantId: string,
  keepLast: number,
): Promise<number> => {
  const t = snapshotsTable(ctx.dialect);
  const rows = (await ctx.db
    .select({ id: t.id, createdAt: t.createdAt })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.kind, "scheduled")))
    .orderBy(desc(t.createdAt))) as { id: string; createdAt: unknown }[];
  const stale = rows.slice(Math.max(0, keepLast));
  for (const s of stale) {
    await ctx.db.delete(t).where(and(eq(t.tenantId, tenantId), eq(t.id, s.id)));
  }
  return stale.length;
};

/**
 * Cron entry point — capture a `scheduled` schema snapshot for every workspace
 * whose `schemaSnapshotSchedule` is `daily`/`weekly` and whose last scheduled
 * snapshot is older than the interval (or has none), then prune to `keepLast`.
 * Idempotent within an interval: a second tick inside the same day/week is a
 * no-op because the freshly-written snapshot is now within the window.
 */
export const runScheduledSnapshots = async (
  ctx: SchemaVersionsCtx,
  now: Date = new Date(),
): Promise<{ captured: string[]; pruned: number }> => {
  const settingsTbl = ctx.dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;
  const captured: string[] = [];
  let pruned = 0;

  // Every workspace that has opted into a cadence. The value is validated again
  // via loadAppSettings below (this query just narrows the tenant set).
  const rows = (await ctx.db
    .select({ tenantId: settingsTbl.tenantId, value: settingsTbl.value })
    .from(settingsTbl)
    .where(eq(settingsTbl.key, "schemaSnapshotSchedule"))) as {
    tenantId: string | null;
    value: unknown;
  }[];

  for (const row of rows) {
    if (!row.tenantId || (row.value !== "daily" && row.value !== "weekly")) continue;
    const tenantId = row.tenantId;
    try {
      const settings = await loadAppSettings(ctx.db, ctx.dialect, tenantId);
      if (settings.schemaSnapshotSchedule === "off") continue;
      const interval = INTERVAL_MS[settings.schemaSnapshotSchedule];

      const snaps = snapshotsTable(ctx.dialect);
      const last = (await ctx.db
        .select({ createdAt: snaps.createdAt })
        .from(snaps)
        .where(and(eq(snaps.tenantId, tenantId), eq(snaps.kind, "scheduled")))
        .orderBy(desc(snaps.createdAt))
        .limit(1)) as { createdAt: unknown }[];
      const dueSince = last[0] ? now.getTime() - toMs(last[0].createdAt) >= interval : true;
      if (!dueSince) continue;

      const snap = await captureSnapshot(ctx, tenantId, {
        name: `Auto (${settings.schemaSnapshotSchedule}) ${now.toISOString().slice(0, 10)}`,
        kind: "scheduled",
      });
      captured.push(snap.id);
      pruned += await pruneScheduledSnapshots(ctx, tenantId, settings.schemaSnapshotKeepLast);
    } catch (e) {
      console.error(`[schema-auto-snapshot:${tenantId}] failed`, e);
    }
  }
  return { captured, pruned };
};
