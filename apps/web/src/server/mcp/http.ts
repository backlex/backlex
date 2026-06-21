import type { Context } from "hono";
import { dispatch, SUPPORTED_PROTOCOL_VERSIONS } from "./dispatch";
import type { McpServerWiring } from "./types";
import { isWorkspaceAllowedOrigin } from "../services/cors-origins";
import {
  GLOBAL_AI_CONFIG_ID,
  applyAiOverride,
  resolveAiOverride,
} from "../services/ai-config";

/**
 * For an `ai.*` tool call, overlay the workspace's bring-your-own AI key onto
 * the wiring env so `ctx.env` inside the tool carries it (and, via
 * `callClaude`'s direct-key-first ordering, bypasses the managed cloud gateway).
 * Scoped to ai.* `tools/call` so non-AI MCP requests skip the extra DB read.
 * Degrades to the unchanged wiring on any failure — AI generation still works.
 */
const withAiOverride = async (
  c: Context,
  wiring: McpServerWiring,
  body: { method?: unknown; params?: unknown },
): Promise<McpServerWiring> => {
  if (body.method !== "tools/call") return wiring;
  const name = (body.params as { name?: unknown } | undefined)?.name;
  if (typeof name !== "string" || !name.startsWith("ai.")) return wiring;
  try {
    const ctx = c.get("ctx") as
      | { db: unknown; dialect: "pg" | "sqlite" }
      | undefined;
    const auth = c.get("auth") as { tenantId?: string | null } | undefined;
    if (!ctx) return wiring;
    const override = await resolveAiOverride(
      { db: ctx.db, dialect: ctx.dialect, env: wiring.env },
      auth?.tenantId ?? GLOBAL_AI_CONFIG_ID,
    );
    return override
      ? { ...wiring, env: applyAiOverride(wiring.env, override) }
      : wiring;
  } catch {
    return wiring;
  }
};

/** Hono handler for the Streamable HTTP transport (POST-only).
 *
 *  Each POST is a single JSON-RPC message:
 *  - request (has `id`)  → JSON response with the result
 *  - notification (no id) → 202 Accepted, empty body
 *
 *  GET/DELETE on the same path are 405 — we don't implement the resumable
 *  SSE stream or session termination. Sessionless: no `Mcp-Session-Id`.
 *
 *  Protocol baseline is the current MCP revision (see dispatch.ts). Two
 *  transport rules the spec makes load-bearing as of 2025-06-18:
 *  - **No JSON-RPC batching** — the body MUST be a single message; arrays are
 *    rejected.
 *  - **`MCP-Protocol-Version` header** — when present it MUST be a version we
 *    support, else 400. When absent we assume the legacy `2025-03-26` and
 *    proceed (non-browser clients on older revisions don't send it).
 *  And the standing **Origin** requirement: when an `Origin` header is present
 *  it must be allowed (DNS-rebinding defense); absent = a non-browser client. */
export const handleMcpRequest = async (
  c: Context,
  wiring: McpServerWiring,
): Promise<Response> => {
  if (c.req.method === "GET" || c.req.method === "DELETE") {
    return c.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: `${c.req.method} not supported on this MCP endpoint` } },
      405,
    );
  }
  if (c.req.method !== "POST") {
    return c.json({ error: { code: "METHOD_NOT_ALLOWED", message: "MCP requires POST" } }, 405);
  }

  // DNS-rebinding defense: a browser always sends Origin, so a disallowed one is
  // a cross-site caller and is rejected. Non-browser MCP clients (Claude
  // Desktop, the CLI proxy, curl) send no Origin — allowed, since auth still
  // gates them. Mirrors the global CORS allow-list (cache already refreshed by
  // the CORS middleware that ran ahead of this route).
  const origin = c.req.header("origin");
  if (
    origin &&
    origin !== wiring.env.APP_URL &&
    !isWorkspaceAllowedOrigin(origin, wiring.env)
  ) {
    return c.json({ error: { code: "FORBIDDEN", message: "origin not allowed" } }, 403);
  }

  // Negotiated protocol version, echoed by the client on every post-initialize
  // request. Present + unsupported → 400; absent → assume 2025-03-26 and proceed.
  const pv = c.req.header("mcp-protocol-version");
  if (pv && !SUPPORTED_PROTOCOL_VERSIONS.has(pv)) {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: `unsupported MCP-Protocol-Version: ${pv}` },
      },
      400,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error: body is not valid JSON" },
      },
      400,
    );
  }

  // JSON-RPC batching was removed in MCP 2025-06-18 — the body MUST be a single
  // message. Reject arrays instead of silently iterating them.
  if (Array.isArray(body)) {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "JSON-RPC batching is not supported" },
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request must be an object" } },
      400,
    );
  }

  const effectiveWiring = await withAiOverride(
    c,
    wiring,
    body as { method?: unknown; params?: unknown },
  );
  const response = await dispatch(
    effectiveWiring,
    c.req.raw,
    c,
    body as Parameters<typeof dispatch>[3],
  );

  // Notification (no id) — nothing to return.
  if (!response) {
    return new Response(null, { status: 202 });
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
