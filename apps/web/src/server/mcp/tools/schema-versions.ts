/**
 * MCP tools for migration diffing / schema branching (#9), wrapping
 * `/api/admin/schema`. Distinct from the `schema.create_collection` / etc.
 * tools (schema-admin.ts) — these operate on whole-schema snapshots, diffs,
 * and branches. A ref is the string `live`, `snapshot:<id>`, or `branch:<id>`.
 */
import { readJson } from "../internal-fetch";
import type { McpTool, ToolResult } from "../types";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

type Ref = { kind: "live" } | { kind: "snapshot"; id: string } | { kind: "branch"; id: string };

const parseRef = (raw: unknown, label: string): Ref => {
  const s = String(raw ?? "");
  if (s === "live") return { kind: "live" };
  const [kind, id] = s.split(":", 2);
  if ((kind === "snapshot" || kind === "branch") && id) return { kind, id };
  throw new Error(`VALIDATION: ${label} must be "live", "snapshot:<id>", or "branch:<id>"`);
};

const REF_DESC = 'A schema ref: "live", "snapshot:<id>", or "branch:<id>".';

const post = async (
  ctx: Parameters<McpTool["handler"]>[1],
  path: string,
  body: unknown,
): Promise<ToolResult> => {
  const res = await ctx.fetchInternal(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as object | null;
  if (!parsed) throw new Error(`upstream returned non-JSON (status ${res.status})`);
  return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }], structuredContent: parsed, isError: !res.ok };
};

export const listSchemaSnapshots: McpTool = {
  name: "schema.snapshots",
  description:
    "List schema snapshots (migration checkpoints) in the active workspace. " +
    "Each shows id, name, kind, and collectionCount. Pair with `schema.diff` to " +
    "preview what changed, then `schema.apply` to reconcile the live schema.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => textResult(await readJson(await ctx.fetchInternal("/api/admin/schema/snapshots"))),
};

export const captureSchemaSnapshot: McpTool = {
  name: "schema.capture",
  description: "Capture the current live schema as a named snapshot (a checkpoint you can diff/restore later).",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, note: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    post(ctx, "/api/admin/schema/snapshots", { name: String(args.name ?? ""), note: args.note ?? null }),
};

export const listSchemaBranches: McpTool = {
  name: "schema.branches",
  description: "List schema branches (named pointers into snapshot history) in the active workspace.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => textResult(await readJson(await ctx.fetchInternal("/api/admin/schema/branches"))),
};

export const diffSchemaTool: McpTool = {
  name: "schema.diff",
  description:
    "Diff two schema refs into a categorized change list (additive / destructive / metadata) with the DDL each " +
    "change would emit. Use this to preview a migration before applying it.",
  inputSchema: {
    type: "object",
    properties: { from: { type: "string", description: REF_DESC }, to: { type: "string", description: REF_DESC } },
    required: ["from", "to"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    post(ctx, "/api/admin/schema/diff", { from: parseRef(args.from, "from"), to: parseRef(args.to, "to") }),
};

export const applySchemaTool: McpTool = {
  name: "schema.apply",
  description:
    "Apply a target schema ref to the live schema, reconciling collections and columns. Additive changes apply " +
    "freely; destructive ones (drop column/table, type change) require `confirmDestructive: true`. A safety " +
    "snapshot is captured before any change so the apply is reversible.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: REF_DESC },
      confirmDestructive: { type: "boolean", description: "Required to apply destructive changes." },
    },
    required: ["target"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    post(ctx, "/api/admin/schema/apply", {
      target: parseRef(args.target, "target"),
      confirmDestructive: Boolean(args.confirmDestructive),
    }),
};

export const schemaVersionsTools: McpTool[] = [
  listSchemaSnapshots,
  captureSchemaSnapshot,
  listSchemaBranches,
  diffSchemaTool,
  applySchemaTool,
];
