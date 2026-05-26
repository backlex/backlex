/**
 * Minimal MCP (Model Context Protocol) types. We hand-roll the JSON-RPC
 * surface instead of pulling in `@modelcontextprotocol/sdk` so the Worker
 * bundle stays small and we keep the same code path under Bun, CF Workers,
 * Vercel, Netlify, and Deno. The spec we target is the
 * `2025-03-26` Streamable HTTP variant in stateless mode.
 */
import type { Hono } from "hono";
import type { Env } from "../env";

/** JSON-RPC 2.0 message id. Notifications omit the id. */
export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** JSON-RPC error codes (per spec + MCP additions). */
export const RPC_ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/** MCP tool descriptor. `inputSchema` is JSON Schema; we keep it loose since
 *  callers (LLMs) read it and our handler validates the args itself. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
  /** Optional UI hint for the Ask-AI Tools tab. `tools/list` surfaces this
   *  field — admins use it to colour-code read vs write vs destructive tools
   *  at a glance. When omitted the dispatcher derives a value from the tool
   *  name suffix (see `kindFromName` in `dispatch.ts`). Only override when
   *  the heuristic would misclassify (e.g. an `*.invoke` tool that mutates
   *  state but doesn't look like it from the name). */
  kind?: "read" | "write" | "destruct";
  /** Tools that are only reachable through the admin mount (`/api/admin/mcp`)
   *  set this so the Ask-AI catalog can mark them with an `admin` badge.
   *  Pure metadata — the actual gating is enforced by `requireAdmin`
   *  middleware on the route, not by this flag. */
  adminOnly?: boolean;
}

export interface ToolCtx {
  /** Forwards an internal sub-request through the same Hono app with the
   *  original MCP request's auth (Authorization / Cookie / X-Workeros-Tenant).
   *  Reuses every middleware: session, tenant, CORS, permission DSL, etc. */
  fetchInternal: (path: string, init?: RequestInit) => Promise<Response>;
  /** Which mount surfaced this tool — `tenant` for `/mcp`, `admin` for
   *  `/api/admin/mcp`. Tools rarely need to branch on it (permissions handle
   *  the difference) but it's available for tool-level gating. */
  mode: McpMode;
  /** Workspace env — exposed so AI-native tools (`ai.*`) can read provider
   *  keys (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
   *  without going through another sub-fetch. Tools that don't need
   *  provider access ignore it. */
  env: Env;
}

export type McpMode = "tenant" | "admin";

/** MCP tools/call result shape. */
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** Optional structured payload alongside the text content. The MCP spec
   *  allows tools to attach `structuredContent` for callers that prefer
   *  machine-parseable output to the text rendering. */
  structuredContent?: unknown;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } };

/** Wiring needed to dispatch a request — closes over the parent app so
 *  tools can issue internal sub-fetches without a fresh outbound HTTP hop. */
export interface McpServerWiring {
  app: Hono;
  env: Env;
  mode: McpMode;
  tools: McpTool[];
}
