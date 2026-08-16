import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listBackups: McpTool = {
  name: "backups.list",
  description:
    "List backup tracking rows for the active workspace, newest first. Each " +
    "row shows id, kind (manual/auto), label, size, tableCount and status. " +
    "Use `backups.run` to take one now and `backups.restore` to re-apply one.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/db/backups`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const runBackupNow: McpTool = {
  name: "backups.run",
  description:
    "Run a manual backup now (dumps system tables + the workspace's collection " +
    "tables to storage). Returns the tracking row with `done`/`failed` status. " +
    "Set `async: true` on a large workspace to queue the dump as a durable " +
    "background job instead: the tracking row is created immediately and the " +
    "call returns `{jobId}` — poll it with `jobs.get`. Prefer that over waiting " +
    "on a dump that may outlast your own request.",
  inputSchema: {
    type: "object",
    properties: {
      label: { type: "string", description: "Optional label, max 80 chars." },
      async: {
        type: "boolean",
        description:
          "Queue the dump as a background job and return a `jobId` instead of the finished row.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(
      `/api/admin/db/backups/now${args.async ? "?async=1" : ""}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args.label ? { label: String(args.label) } : {}),
      },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const restoreBackup: McpTool = {
  name: "backups.restore",
  description:
    "Restore a backup into the active workspace. By default additive — " +
    "missing/deleted rows come back, existing rows are never overwritten or " +
    "removed. Set `overwrite: true` to also restate rows that still exist to " +
    "their backup-era values; that is the only way to undo a bad write, and the " +
    "only mode that can destroy current data. `onlyTables` narrows which tables " +
    "are touched. Requires `confirm: true` since it writes data.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      confirm: {
        type: "boolean",
        description: "Must be true — acknowledges the data write.",
      },
      overwrite: {
        type: "boolean",
        description:
          "Restate rows that still exist (ON CONFLICT DO UPDATE). Destructive: " +
          "current values are replaced by the backup's. Requires `confirm` too.",
      },
      onlyTables: {
        type: "array",
        items: { type: "string" },
        description:
          "Restrict the restore to these table names. Recommended with " +
          "`overwrite` so a targeted recovery does not roll settings back too.",
      },
      async: {
        type: "boolean",
        description:
          "Queue the restore as a background job and return a `jobId` instead " +
          "of waiting. It is never retried if it dies part-way — a restore " +
          "writes into live tables, so a half-finished one is reported rather " +
          "than replayed.",
      },
    },
    required: ["id", "confirm"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    if (args.confirm !== true)
      throw new Error("VALIDATION: confirm must be true to restore a backup");
    const q = new URLSearchParams();
    if (args.overwrite === true) q.set("mode", "overwrite");
    const onlyTables = args.onlyTables;
    if (Array.isArray(onlyTables) && onlyTables.length > 0)
      q.set("onlyTables", onlyTables.map((t) => String(t)).join(","));
    if (args.async === true) q.set("async", "1");
    const qs = q.toString();
    const res = await ctx.fetchInternal(
      `/api/admin/db/backups/${encodeURIComponent(id)}/restore${qs ? `?${qs}` : ""}`,
      {
        method: "POST",
        headers: { "x-backlex-confirm": "yes" },
      },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const getBackupConfig: McpTool = {
  name: "backups.get_config",
  description:
    "Get the workspace's automatic-backup schedule (`off` | `daily` | `weekly`) " +
    "and retention count.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/db/backups/config`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const setBackupConfig: McpTool = {
  name: "backups.set_config",
  description:
    "Set the automatic-backup schedule (`off` | `daily` | `weekly`) and/or how " +
    "many backups to retain (1–365). Auto backups run from the cron tick.",
  inputSchema: {
    type: "object",
    properties: {
      schedule: { type: "string", enum: ["off", "daily", "weekly"] },
      retain: { type: "number", minimum: 1, maximum: 365 },
      retainDays: {
        type: ["number", "null"],
        description:
          "Prune auto backups older than this many days (1–3650); null disables the age rule.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const patch: Record<string, unknown> = {};
    if (args.schedule !== undefined) patch.schedule = args.schedule;
    if (args.retain !== undefined) patch.retain = args.retain;
    if (args.retainDays !== undefined) patch.retainDays = args.retainDays;
    const res = await ctx.fetchInternal(`/api/admin/db/backups/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const backupsTools: McpTool[] = [
  listBackups,
  runBackupNow,
  restoreBackup,
  getBackupConfig,
  setBackupConfig,
];
