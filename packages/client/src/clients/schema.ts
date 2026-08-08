import type { ClientCore } from "../core";

/** A collection inside a schema snapshot — the schema-relevant subset of a
 *  collection's metadata (`/api/admin/schema`). */
export interface SchemaSnapshotCollection {
  slug: string;
  fields: { name: string; type: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

/** One categorized change produced by a schema diff. `severity` decides how it
 *  can be applied: `additive` auto-applies, `destructive` needs confirmation,
 *  `metadata` carries no DDL or data risk. */
export interface SchemaChange {
  kind: string;
  severity: "additive" | "destructive" | "metadata";
  collection: string;
  field?: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  ddl?: { pg: string[]; sqlite: string[] };
}

export interface SchemaDiff {
  changes: SchemaChange[];
  counts: { additive: number; destructive: number; metadata: number; total: number };
  hasDestructive: boolean;
}

export interface SchemaSnapshotSummary {
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

export interface SchemaSnapshotRecord extends SchemaSnapshotSummary {
  snapshot: SchemaSnapshotCollection[];
}

export interface SchemaBranch {
  id: string;
  name: string;
  note: string | null;
  headSnapshotId: string | null;
  baseSnapshotId: string | null;
  createdBy: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

/** Where a schema state comes from — the live workspace schema, a stored
 *  snapshot, or a branch head. */
export type SchemaRef =
  | { kind: "live" }
  | { kind: "snapshot"; id: string }
  | { kind: "branch"; id: string };

export interface SchemaApplyResult {
  diff: SchemaDiff;
  applied: string[];
  safetySnapshotId: string | null;
  noop: boolean;
}

/** Schema versions — migration diffing / schema branching (admin-scoped).
 *  Mirrors `/api/admin/schema`. Diff any two refs, snapshot/branch the live
 *  schema, and apply a target to reconcile live (destructive changes gated). */
export interface SchemaClient {
  /** List schema snapshots (newest first). */
  snapshots(): Promise<{ data: SchemaSnapshotSummary[] }>;
  /** Fetch one snapshot, including its full schema body. */
  snapshot(id: string): Promise<{ data: SchemaSnapshotRecord }>;
  /** Capture the current live schema as a new snapshot. */
  capture(name: string, note?: string | null): Promise<{ data: SchemaSnapshotRecord }>;
  /** Store an externally-authored schema as a snapshot (the GitOps entry point). */
  import(
    name: string,
    snapshot: SchemaSnapshotCollection[],
    note?: string | null,
  ): Promise<{ data: SchemaSnapshotRecord }>;
  /** Delete a snapshot (refused if it is a branch head). */
  deleteSnapshot(id: string): Promise<{ ok: boolean }>;
  /** List schema branches. */
  branches(): Promise<{ data: SchemaBranch[] }>;
  /** Fetch one branch. */
  branch(id: string): Promise<{ data: SchemaBranch }>;
  /** Fork a branch from the live schema (or a snapshot). */
  createBranch(
    name: string,
    opts?: { note?: string | null; fromSnapshotId?: string | null },
  ): Promise<{ data: SchemaBranch }>;
  /** Move a branch's head to an authored schema, a snapshot, or live. */
  setBranchHead(
    id: string,
    opts: { data?: SchemaSnapshotCollection[]; fromSnapshotId?: string | null; name?: string },
  ): Promise<{ data: SchemaBranch }>;
  /** Delete a branch and its branch-owned snapshots. */
  deleteBranch(id: string): Promise<{ ok: boolean }>;
  /** Diff two refs into a categorized change list. */
  diff(
    from: SchemaRef,
    to: SchemaRef,
  ): Promise<{ data: { from: string; to: string; diff: SchemaDiff } }>;
  /** Apply a target ref to the live schema. Destructive changes require
   *  `confirmDestructive`. A safety snapshot is captured before any change. */
  apply(
    target: SchemaRef,
    opts?: { confirmDestructive?: boolean },
  ): Promise<{ data: SchemaApplyResult }>;
  /** Clone a collection's schema (fields + metadata, never data) into a new
   *  managed collection. Mirrors `POST /api/collections/:slug/clone`. */
  cloneCollection(
    slug: string,
    newSlug: string,
  ): Promise<{ data: Record<string, unknown> }>;
}

export const makeSchema = (core: ClientCore): SchemaClient => {
  // Schema versions — migration diffing / schema branching over
  // `/api/admin/schema`. `import` stores an authored schema; `apply` reconciles
  // the live schema to a ref (destructive changes need confirmDestructive).
  const schemaBase = "/api/admin/schema";
  const schema: SchemaClient = {
    snapshots: () => core.request<{ data: SchemaSnapshotSummary[] }>("GET", `${schemaBase}/snapshots`),
    snapshot: (id: string) =>
      core.request<{ data: SchemaSnapshotRecord }>(
        "GET",
        `${schemaBase}/snapshots/${encodeURIComponent(id)}`,
      ),
    capture: (name: string, note?: string | null) =>
      core.request<{ data: SchemaSnapshotRecord }>("POST", `${schemaBase}/snapshots`, {
        name,
        note: note ?? null,
      }),
    import: (name: string, snapshot: SchemaSnapshotCollection[], note?: string | null) =>
      core.request<{ data: SchemaSnapshotRecord }>("POST", `${schemaBase}/snapshots/import`, {
        name,
        snapshot,
        note: note ?? null,
      }),
    deleteSnapshot: (id: string) =>
      core.request<{ ok: boolean }>("DELETE", `${schemaBase}/snapshots/${encodeURIComponent(id)}`),
    branches: () => core.request<{ data: SchemaBranch[] }>("GET", `${schemaBase}/branches`),
    branch: (id: string) =>
      core.request<{ data: SchemaBranch }>("GET", `${schemaBase}/branches/${encodeURIComponent(id)}`),
    createBranch: (name: string, opts?: { note?: string | null; fromSnapshotId?: string | null }) =>
      core.request<{ data: SchemaBranch }>("POST", `${schemaBase}/branches`, { name, ...opts }),
    setBranchHead: (
      id: string,
      opts: { data?: SchemaSnapshotCollection[]; fromSnapshotId?: string | null; name?: string },
    ) =>
      core.request<{ data: SchemaBranch }>(
        "PATCH",
        `${schemaBase}/branches/${encodeURIComponent(id)}/head`,
        opts,
      ),
    deleteBranch: (id: string) =>
      core.request<{ ok: boolean }>("DELETE", `${schemaBase}/branches/${encodeURIComponent(id)}`),
    diff: (from: SchemaRef, to: SchemaRef) =>
      core.request<{ data: { from: string; to: string; diff: SchemaDiff } }>(
        "POST",
        `${schemaBase}/diff`,
        { from, to },
      ),
    apply: (target: SchemaRef, opts?: { confirmDestructive?: boolean }) =>
      core.request<{ data: SchemaApplyResult }>("POST", `${schemaBase}/apply`, {
        target,
        confirmDestructive: opts?.confirmDestructive,
      }),
    cloneCollection: (slug: string, newSlug: string) =>
      core.request<{ data: Record<string, unknown> }>(
        "POST",
        `/api/collections/${encodeURIComponent(slug)}/clone`,
        { slug: newSlug },
      ),
  };

  return schema;
};
