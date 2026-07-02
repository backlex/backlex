/**
 * MCP tools for external-DB migration, wrapping `/api/admin/migrate`
 * (docs/migrating-in.md). Sources are saved connections (URLs encrypted at
 * rest, masked on read); runs are durable server-side copies advanced by the
 * scheduler tick. The `backlex import-db` CLI is the client-side twin for
 * sources the server can't reach.
 */
import { readJson } from "../internal-fetch";
import type { McpTool, ToolResult } from "../types";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const post = async (
  ctx: Parameters<McpTool["handler"]>[1],
  path: string,
  body?: unknown,
): Promise<ToolResult> => {
  const res = await ctx.fetchInternal(path, {
    method: "POST",
    ...(body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const parsed = (await res.json().catch(() => null)) as object | null;
  if (!parsed) throw new Error(`upstream returned non-JSON (status ${res.status})`);
  return {
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
    structuredContent: parsed,
    isError: !res.ok,
  };
};

export const migrateListSources: McpTool = {
  name: "migrate.sources",
  description:
    "List saved external-database sources for server-side migration. URLs are masked " +
    "(credentials never leave the server). Pair with `migrate.plan` → `migrate.start_run`.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) =>
    textResult(await readJson(await ctx.fetchInternal("/api/admin/migrate/sources"))),
};

export const migrateCreateSource: McpTool = {
  name: "migrate.create_source",
  description:
    "Save an external Postgres connection as a migration source. The URL is encrypted at rest. " +
    "Private/internal hosts are rejected unless the deployment sets MIGRATE_ALLOW_PRIVATE_SOURCES.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      url: { type: "string", description: "postgres://user:pass@host:port/db" },
    },
    required: ["name", "url"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    post(ctx, "/api/admin/migrate/sources", {
      name: String(args.name ?? ""),
      url: String(args.url ?? ""),
    }),
};

export const migrateDeleteSource: McpTool = {
  name: "migrate.delete_source",
  description: "Delete a saved migration source (refused while one of its runs is in flight).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(
      `/api/admin/migrate/sources/${encodeURIComponent(String(args.id ?? ""))}`,
      { method: "DELETE" },
    );
    return textResult(await readJson(res));
  },
};

export const migrateTestSource: McpTool = {
  name: "migrate.test_source",
  description: "Connectivity check against a saved source — opens it and counts its tables.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    post(ctx, `/api/admin/migrate/sources/${encodeURIComponent(String(args.id ?? ""))}/test`),
};

export const migrateSourceTables: McpTool = {
  name: "migrate.source_tables",
  description: "List an external source's tables (name + planner row estimate).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson(
        await ctx.fetchInternal(
          `/api/admin/migrate/sources/${encodeURIComponent(String(args.id ?? ""))}/tables`,
        ),
      ),
    ),
};

export const migratePlan: McpTool = {
  name: "migrate.plan",
  description:
    "Introspect a saved source and build an editable migration plan: table→collection mapping, " +
    "PK types (preserved verbatim), FK→relation wiring, copy order, and warnings for lossy mappings. " +
    "Review/edit the plan, then pass it to `migrate.start_run`.",
  inputSchema: {
    type: "object",
    properties: {
      sourceId: { type: "string" },
      tables: {
        type: "array",
        items: { type: "string" },
        description: "Restrict the plan to these source tables (default: all).",
      },
    },
    required: ["sourceId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    post(
      ctx,
      `/api/admin/migrate/sources/${encodeURIComponent(String(args.sourceId ?? ""))}/plan`,
      { tables: args.tables ?? undefined },
    ),
};

export const migrateStartRun: McpTool = {
  name: "migrate.start_run",
  description:
    "Queue a server-side copy run for a (possibly edited) plan. The scheduler advances it in " +
    "resumable slices; poll `migrate.run` for progress. One run per workspace at a time.",
  inputSchema: {
    type: "object",
    properties: {
      sourceId: { type: "string" },
      plan: { type: "object", description: "A MigrationPlan document (from migrate.plan)." },
    },
    required: ["sourceId", "plan"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    post(ctx, "/api/admin/migrate/runs", { sourceId: args.sourceId, plan: args.plan }),
};

export const migrateListRuns: McpTool = {
  name: "migrate.runs",
  description: "List external-DB migration runs, newest first (status + per-table progress).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) =>
    textResult(await readJson(await ctx.fetchInternal("/api/admin/migrate/runs"))),
};

export const migrateGetRun: McpTool = {
  name: "migrate.run",
  description:
    "One migration run with live per-table progress (copied / failed / source vs target counts).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson(
        await ctx.fetchInternal(
          `/api/admin/migrate/runs/${encodeURIComponent(String(args.id ?? ""))}`,
        ),
      ),
    ),
};

export const migrateCancelRun: McpTool = {
  name: "migrate.cancel_run",
  description: "Cancel a pending/running migration run (resumable later — cursors are kept).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    post(ctx, `/api/admin/migrate/runs/${encodeURIComponent(String(args.id ?? ""))}/cancel`),
};

export const migrateResumeRun: McpTool = {
  name: "migrate.resume_run",
  description:
    "Re-queue a failed/cancelled run. Per-table cursors resume where the copy stopped; " +
    "the ingest is idempotent so overlap never dupes.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    post(ctx, `/api/admin/migrate/runs/${encodeURIComponent(String(args.id ?? ""))}/resume`),
};

export const migrateTools: McpTool[] = [
  migrateListSources,
  migrateCreateSource,
  migrateDeleteSource,
  migrateTestSource,
  migrateSourceTables,
  migratePlan,
  migrateStartRun,
  migrateListRuns,
  migrateGetRun,
  migrateCancelRun,
  migrateResumeRun,
];
