import type { McpTool, ToolResult, ToolCtx } from "../types";
import { readJson } from "../internal-fetch";

/** Bulk operations are implemented as bounded-concurrency loops over the
 *  single-record endpoint — there is no dedicated `/api/items` bulk path,
 *  and we deliberately don't add one (per-row validation + activity logging
 *  + vectorize hooks are easier to reason about when each row is one call).
 *  The tool aggregates results so the agent gets one summary instead of
 *  having to script the loop itself. */
const BULK_CONCURRENCY = 5;

const runWithLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]!, idx);
      }
    });
  await Promise.all(workers);
  return out;
};

interface RowResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

const insertOne = async (
  ctx: ToolCtx,
  slug: string,
  data: Record<string, unknown>,
): Promise<RowResult> => {
  const res = await ctx.fetchInternal(`/api/items/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (res.ok) {
    const body = (await res.json()) as { data?: unknown };
    return { ok: true, data: body.data };
  }
  const body = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  return {
    ok: false,
    error: {
      code: body?.error?.code ?? `HTTP_${res.status}`,
      message: body?.error?.message ?? `upstream failed (status ${res.status})`,
    },
  };
};

const updateOne = async (
  ctx: ToolCtx,
  slug: string,
  id: string,
  data: Record<string, unknown>,
): Promise<RowResult> => {
  const res = await ctx.fetchInternal(
    `/api/items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  if (res.ok) {
    const body = (await res.json()) as { data?: unknown };
    return { ok: true, data: body.data };
  }
  const body = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  return {
    ok: false,
    error: {
      code: body?.error?.code ?? `HTTP_${res.status}`,
      message: body?.error?.message ?? `upstream failed (status ${res.status})`,
    },
  };
};

const summarize = (results: RowResult[]): ToolResult => {
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const summary = {
    total: results.length,
    succeeded,
    failed,
    results,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    structuredContent: summary,
    isError: failed > 0,
  };
};

export const bulkInsert: McpTool = {
  name: "collections.bulk_insert",
  description:
    "Insert many rows into a collection in one call. Iterates the single-" +
    "record endpoint with bounded concurrency so per-row validation, " +
    "permission checks, and activity logging still apply. Returns " +
    "`{ total, succeeded, failed, results: [{ok, data?, error?}] }` — " +
    "individual row failures don't abort the rest.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      rows: { type: "array", description: "Array of field → value maps." },
    },
    required: ["collection", "rows"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = String(args.collection ?? "");
    if (!slug) throw new Error("VALIDATION: collection is required");
    if (!Array.isArray(args.rows)) throw new Error("VALIDATION: rows must be an array");
    const rows = args.rows as Record<string, unknown>[];
    const results = await runWithLimit(rows, BULK_CONCURRENCY, (row) =>
      insertOne(ctx, slug, row),
    );
    return summarize(results);
  },
};

export const bulkUpdate: McpTool = {
  name: "collections.bulk_update",
  description:
    "Patch many rows in one call. Each entry is `{ id, data }` — `id` " +
    "selects the row, `data` is the partial patch. Same per-row semantics " +
    "as `collections.bulk_insert`.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      updates: {
        type: "array",
        description: "Array of `{ id, data }` objects.",
      },
    },
    required: ["collection", "updates"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = String(args.collection ?? "");
    if (!slug) throw new Error("VALIDATION: collection is required");
    if (!Array.isArray(args.updates))
      throw new Error("VALIDATION: updates must be an array");
    const updates = args.updates as Array<{ id: unknown; data: unknown }>;
    const results = await runWithLimit(updates, BULK_CONCURRENCY, (u) => {
      if (typeof u.id !== "string") {
        return Promise.resolve<RowResult>({
          ok: false,
          error: { code: "VALIDATION", message: "id must be a string" },
        });
      }
      if (!u.data || typeof u.data !== "object") {
        return Promise.resolve<RowResult>({
          ok: false,
          error: { code: "VALIDATION", message: "data must be an object" },
        });
      }
      return updateOne(ctx, slug, u.id, u.data as Record<string, unknown>);
    });
    return summarize(results);
  },
};

export const batchWrite: McpTool = {
  name: "collections.batch",
  description:
    "Run a mixed set of create/update/delete operations on ONE collection in a " +
    "single call. `operations` is an array of `{ op: \"create\"|\"update\"|" +
    "\"delete\", id?, data? }` (update/delete need `id`). By default each op is " +
    "independent (partial success). Pass `atomic: true` for all-or-nothing — " +
    "the first failure rolls the whole set back (Postgres / self-host SQLite " +
    "only; rejected on D1 / libSQL / neon-http). Returns `{ atomic, total, " +
    "succeeded, failed, results }`.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      operations: {
        type: "array",
        description: 'Array of `{ op, id?, data? }` (e.g. `{ "op": "create", "data": {…} }`).',
      },
      atomic: { type: "boolean", description: "All-or-nothing transaction (default false)." },
    },
    required: ["collection", "operations"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = String(args.collection ?? "");
    if (!slug) throw new Error("VALIDATION: collection is required");
    if (!Array.isArray(args.operations))
      throw new Error("VALIDATION: operations must be an array");
    const res = await ctx.fetchInternal(`/api/items/${encodeURIComponent(slug)}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations: args.operations, atomic: args.atomic === true }),
    });
    const body = await readJson<{ data?: unknown; error?: unknown }>(res);
    const payload = res.ok ? (body.data ?? body) : body;
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload as object,
      isError: !res.ok,
    };
  },
};

export const bulkUpdateShared: McpTool = {
  name: "collections.bulk_update_shared",
  description:
    "Set the SAME fields on MANY rows at once — one shared patch applied to a " +
    "list of ids. `keys` selects the rows, `data` is the partial patch written " +
    "to every one of them (only the named fields change). Differs from " +
    "`collections.bulk_update`, which takes a distinct `{ id, data }` per row. " +
    "Partial-success: a key you can't write (row-scope / tenant filtered) is " +
    "reported as `NOT_FOUND` in `failed`. Structured fields " +
    "(json / file / relation_many / i18n_text) are rejected. Returns " +
    "`{ total, updated, failed, results }`.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      keys: { type: "array", description: "Ids to update.", items: { type: "string" } },
      data: { type: "object", description: "Shared partial patch (the fields to set on every id)." },
    },
    required: ["collection", "keys", "data"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const slug = String(args.collection ?? "");
    if (!slug) throw new Error("VALIDATION: collection is required");
    if (!Array.isArray(args.keys)) throw new Error("VALIDATION: keys must be an array");
    if (!args.data || typeof args.data !== "object")
      throw new Error("VALIDATION: data must be an object");
    const res = await ctx.fetchInternal(`/api/items/${encodeURIComponent(slug)}/bulk-update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: args.keys, data: args.data }),
    });
    const body = await readJson<{ data?: unknown; error?: unknown }>(res);
    const payload = res.ok ? (body.data ?? body) : body;
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload as object,
      isError: !res.ok,
    };
  },
};

export const bulkTools: McpTool[] = [bulkInsert, bulkUpdate, batchWrite, bulkUpdateShared];
