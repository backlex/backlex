import type { Context } from "hono";
import { dispatch } from "./dispatch";
import type { McpServerWiring } from "./types";

/** Hono handler for the Streamable HTTP transport (POST-only MVP).
 *
 *  Each POST is a single JSON-RPC message:
 *  - request (has `id`)  → JSON response with the result
 *  - notification (no id) → 202 Accepted, empty body
 *
 *  GET/DELETE on the same path are 405 — we don't implement the resumable
 *  SSE stream or session termination yet. Sessionless: there is no
 *  `Mcp-Session-Id` header and no shared state between requests. */
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

  // MCP supports a single message OR an array (batch). We handle either.
  const isBatch = Array.isArray(body);
  const messages = isBatch ? (body as unknown[]) : [body];
  if (messages.length === 0) {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "empty batch" },
      },
      400,
    );
  }

  const responses = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      responses.push({
        jsonrpc: "2.0" as const,
        id: null,
        error: { code: -32600, message: "request must be an object" },
      });
      continue;
    }
    const r = await dispatch(
      wiring,
      c.req.raw,
      msg as Parameters<typeof dispatch>[2],
    );
    if (r) responses.push(r);
  }

  if (responses.length === 0) {
    // Pure notification batch — no responses to deliver.
    return new Response(null, { status: 202 });
  }

  const payload = isBatch ? responses : responses[0];
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
