import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

interface FunctionRow {
  id: string;
  name: string;
  trigger: "http" | "event" | "cron";
  pattern?: string | null;
  timeoutMs?: number;
  active?: boolean;
}

export const listFunctions: McpTool = {
  name: "functions.list",
  description:
    "List sandbox functions available in the active workspace (admin-only). " +
    "Each entry shows name, trigger, and active state. Use this to discover " +
    "what's invokable before calling `functions.invoke`.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/functions`);
    const body = await readJson<{ data: FunctionRow[] }>(res);
    const summary = body.data.map((f) => ({
      name: f.name,
      trigger: f.trigger,
      pattern: f.pattern ?? null,
      active: f.active !== false,
      timeoutMs: f.timeoutMs ?? null,
    }));
    return textResult({ functions: summary });
  },
};

export const invokeFunction: McpTool = {
  name: "functions.invoke",
  description:
    "Invoke an HTTP-triggered sandbox function by name (admin-only). The " +
    "`input` object is passed as the function's payload. Returns " +
    "`{ ok, result?, error?, logs, durationMs }`.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Function name (e.g. `daily-report`)." },
      input: { type: "object", description: "Payload object passed to the function." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const name = args.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("VALIDATION: name is required");
    }
    const input =
      args.input && typeof args.input === "object"
        ? (args.input as Record<string, unknown>)
        : {};
    const res = await ctx.fetchInternal(
      `/api/functions/${encodeURIComponent(name)}/invoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    // The function endpoint returns one of three shapes:
    //   - 200 + InvokeResult `{ok: true,  result, logs, durationMs}`
    //   - 500 + InvokeResult `{ok: false, error, logs, durationMs}`
    //   - 4xx/5xx + error envelope `{error: {code, message}}`
    // We surface the body verbatim and set `isError` whenever the upstream
    // failed OR the function itself reported failure. Both cases matter to
    // the caller; the InvokeResult shape is preserved so a successful run
    // returns its `result` field as expected.
    let body: ({ ok?: boolean } & Record<string, unknown>) | null;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error(`functions.invoke: upstream returned non-JSON (status ${res.status})`);
    }
    const isFunctionFailure =
      body !== null && typeof body === "object" && "ok" in body && body.ok === false;
    const isUpstreamError =
      !res.ok && !(body !== null && typeof body === "object" && "ok" in body);
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body ?? undefined,
      isError: isFunctionFailure || isUpstreamError,
    };
  },
};

export const functionsTools: McpTool[] = [listFunctions, invokeFunction];
