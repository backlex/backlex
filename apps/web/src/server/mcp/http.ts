import type { Context } from "hono";
import { dispatch } from "./dispatch";
import { RPC_ERR, type McpServerWiring } from "./types";
import { resolveEra, validateStandardHeaders, type ProtocolRejection } from "./protocol";
import { isWorkspaceAllowedOrigin } from "../services/cors-origins";
import { GLOBAL_AI_CONFIG_ID, resolveAiRuntime } from "../services/ai-config";

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
    const { env } = await resolveAiRuntime(
      { db: ctx.db, dialect: ctx.dialect, env: wiring.env },
      auth?.tenantId ?? GLOBAL_AI_CONFIG_ID,
    );
    return env === wiring.env ? wiring : { ...wiring, env };
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
 *  GET/DELETE on the same path are 405, which is exactly what `2026-07-28`
 *  prescribes for a server that hosts neither the removed GET stream nor
 *  session termination. `Mcp-Session-Id` and `Last-Event-ID` are ignored for
 *  the same reason: this transport was already sessionless and never
 *  resumable, so the revision that deleted both cost us nothing.
 *
 *  The order below is deliberate. Origin is checked first because it is a
 *  security gate and cheap; the body is parsed next because **the era lives in
 *  the body** (`params._meta`) as well as in the header, and the two must be
 *  compared before either is trusted. Only then are the standard headers
 *  validated and the message dispatched.
 *
 *  Standing transport rules, unchanged:
 *  - **No JSON-RPC batching** — the body MUST be a single message; arrays are
 *    rejected.
 *  - **Origin** — when present it must be allowed (DNS-rebinding defense);
 *    absent means a non-browser client, which auth still gates. */
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

  const message = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  // A rejection here is answered with the request's own id when it has one.
  // `null` reads as "we could not attribute this to a request", which is a
  // different and less useful thing to hand a client that is trying to work
  // out whether it is even talking to a modern server.
  const rejectionId = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
  const reject = (r: ProtocolRejection): Response =>
    c.json(
      {
        jsonrpc: "2.0",
        id: rejectionId,
        error: { code: r.code, message: r.message, ...(r.data !== undefined ? { data: r.data } : {}) },
      },
      r.status,
    );

  const resolved = resolveEra(message, c.req.header("mcp-protocol-version") ?? null);
  if ("rejection" in resolved) return reject(resolved.rejection);
  const era = resolved.era;

  if (typeof message.method === "string") {
    const headerFault = validateStandardHeaders(
      { method: message.method, params: message.params },
      { get: (name) => c.req.header(name) ?? null },
      era,
      message.id === undefined,
    );
    if (headerFault) return reject(headerFault);
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
    era,
  );

  // Notification (no id) — nothing to return.
  if (!response) {
    return new Response(null, { status: 202 });
  }

  // Unknown method: `2026-07-28` wants HTTP 404 alongside the JSON-RPC
  // `-32601`, so a dual-era client can tell "this endpoint exists but not that
  // method" from a legacy server's bare 404. Only for modern requests — a
  // handshake-era client has always read this as a 200 with an error body, and
  // changing that under it would break clients the deprecation window exists
  // to protect.
  const status =
    era.modern && "error" in response && response.error.code === RPC_ERR.METHOD_NOT_FOUND ? 404 : 200;

  return new Response(JSON.stringify(response), {
    status,
    headers: { "content-type": "application/json" },
  });
};
