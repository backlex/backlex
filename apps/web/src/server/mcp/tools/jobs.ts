import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const enqueueJobTool: McpTool = {
  name: "jobs.enqueue",
  description:
    "Enqueue a durable background job. `type` is `function` (run a named " +
    "function with `payload.name` + `payload.input`) or `webhook.deliver`. " +
    "Jobs retry with backoff and dead-letter after maxAttempts. Use `runAt` " +
    "(ISO timestamp) to schedule for later. Returns `{ id }`.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["function", "webhook.deliver"] },
      payload: { type: "object", description: "Handler input. For `function`: { name, input }." },
      queue: { type: "string", description: "Logical queue name (default `default`)." },
      runAt: { type: "string", description: "ISO timestamp to delay until." },
      maxAttempts: { type: "number" },
      priority: { type: "number" },
    },
    required: ["type"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const listJobsTool: McpTool = {
  name: "jobs.list",
  description:
    "List jobs in the active workspace, newest first. Filter by `queue` and/or " +
    "`status` (pending|active|succeeded|failed|dead_letter|cancelled).",
  inputSchema: {
    type: "object",
    properties: {
      queue: { type: "string" },
      status: {
        type: "string",
        enum: ["pending", "active", "succeeded", "failed", "dead_letter", "cancelled"],
      },
      limit: { type: "number" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = new URLSearchParams();
    if (typeof args.queue === "string") qs.set("queue", args.queue);
    if (typeof args.status === "string") qs.set("status", args.status);
    if (typeof args.limit === "number") qs.set("limit", String(args.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await ctx.fetchInternal(`/api/jobs${suffix}`);
    return textResult(await readJson<unknown>(res));
  },
};

export const getJobTool: McpTool = {
  name: "jobs.get",
  description: "Fetch a single job by id, including its payload, result and lastError.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/jobs/${encodeURIComponent(id)}`);
    return textResult(await readJson<unknown>(res));
  },
};

export const retryJobTool: McpTool = {
  name: "jobs.retry",
  description: "Requeue a failed, dead-lettered or cancelled job to run again immediately.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/jobs/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const cancelJobTool: McpTool = {
  name: "jobs.cancel",
  description: "Cancel a pending (not-yet-run) job.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const jobsTools: McpTool[] = [
  enqueueJobTool,
  listJobsTool,
  getJobTool,
  retryJobTool,
  cancelJobTool,
];
