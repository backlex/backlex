import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const executeSql: McpTool = {
  name: "db.execute_sql",
  description:
    "Execute raw SQL against the workspace database (admin-only). DDL and " +
    "writes must include `?writes=1`. Bypasses the permissions DSL — agents " +
    "with this tool can read any row in any collection. Pair with the " +
    "per-key MCP allowlist for narrowing.",
  inputSchema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "SQL statement (single statement)." },
      writes: {
        type: "boolean",
        description: "Set true to allow DDL or non-SELECT statements.",
      },
    },
    required: ["sql"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const sql = String(args.sql ?? "");
    if (!sql) throw new Error("VALIDATION: sql is required");
    const qs = args.writes === true ? "?writes=1" : "";
    const res = await ctx.fetchInternal(`/api/admin/db/sql/run${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const listTables: McpTool = {
  name: "db.list_tables",
  description:
    "List every physical table in the workspace database (admin-only) — " +
    "includes backlex system tables, managed collection tables, and any " +
    "adopted tables. Useful for discovery before `db.execute_sql`.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/db/tables`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const dbTools: McpTool[] = [executeSql, listTables];
