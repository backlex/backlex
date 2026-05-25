import type { Context } from "hono";
import {
  RPC_ERR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpServerWiring,
  type McpTool,
  type ToolCtx,
} from "./types";
import { makeInternalFetch } from "./internal-fetch";
import { checkToolCall, filterByAllowlist, guardsFromAuth } from "./guards";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "workeros";
const SERVER_VERSION = "0.0.1";

const error = (id: JsonRpcRequest["id"] | null, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

const success = (id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result,
});

const findTool = (tools: McpTool[], name: string): McpTool | undefined =>
  tools.find((t) => t.name === name);

const toolDescriptor = (t: McpTool) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
});

/** Dispatch a single JSON-RPC message. Notifications (no `id`) return `null`
 *  so the HTTP transport can answer 202 Accepted with an empty body.
 *
 *  `honoCtx` is the Hono context for the original MCP request — used to read
 *  the active key's MCP guards (allowlist, read-only) from `c.var.auth`.
 *  Cookie / session callers carry no guards and the checks become no-ops. */
export const dispatch = async (
  wiring: McpServerWiring,
  originRequest: Request,
  honoCtx: Context<{ Variables: { auth?: { apiKeyMcpTools?: string[] | null; apiKeyMcpReadOnly?: boolean } } }>,
  body: JsonRpcRequest | { jsonrpc: "2.0"; method: string; params?: unknown },
): Promise<JsonRpcResponse | null> => {
  const guards = guardsFromAuth(honoCtx.get("auth") ?? {});
  // Notification — no id, no response per JSON-RPC spec.
  const id = "id" in body ? body.id : undefined;
  const isNotification = id === undefined;

  if (body.jsonrpc !== "2.0") {
    if (isNotification) return null;
    return error(id ?? null, RPC_ERR.INVALID_REQUEST, "jsonrpc must be 2.0");
  }
  if (typeof body.method !== "string") {
    if (isNotification) return null;
    return error(id ?? null, RPC_ERR.INVALID_REQUEST, "method must be a string");
  }

  // Stateless transport: every request stands alone, so `initialize` is
  // always idempotent and `notifications/initialized` is a no-op we accept.
  switch (body.method) {
    case "initialize":
      return success(id!, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: {
          tools: { listChanged: false },
        },
        instructions:
          "workeros MCP server — collections, schema, storage, and functions tools. " +
          "Permissions are enforced by the caller's identity (API key or session).",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      // No-op acknowledgements. Stateless transport doesn't need to remember
      // the initialize handshake, but well-behaved clients send these anyway.
      return null;

    case "ping":
      return success(id!, {});

    case "tools/list": {
      // Allowlist narrows what the agent SEES; the dispatcher additionally
      // rejects out-of-list calls below, so a client that ignores the list
      // and tries a hidden tool still gets a hard 403.
      const allowedNames = new Set(
        filterByAllowlist(
          wiring.tools.map((t) => t.name),
          guards,
        ),
      );
      return success(id!, {
        tools: wiring.tools
          .filter((t) => allowedNames.has(t.name))
          .map(toolDescriptor),
      });
    }

    case "tools/call": {
      const params = (body.params ?? {}) as {
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof params.name !== "string") {
        return error(id ?? null, RPC_ERR.INVALID_PARAMS, "params.name must be a string");
      }
      const tool = findTool(wiring.tools, params.name);
      if (!tool) {
        return error(id ?? null, RPC_ERR.METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
      }
      // Per-key guards run BEFORE the upstream permission DSL — a read-only
      // key calling `collections.delete` should fail fast with a clear MCP
      // error, not bounce around the REST layer first.
      const guardCheck = checkToolCall(params.name, guards);
      if (!guardCheck.ok) {
        return success(id!, {
          content: [{ type: "text", text: `${guardCheck.code}: ${guardCheck.message}` }],
          isError: true,
        });
      }
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      const toolCtx: ToolCtx = {
        fetchInternal: makeInternalFetch(wiring.app, originRequest, wiring.env),
        mode: wiring.mode,
      };
      try {
        const result = await tool.handler(args, toolCtx);
        return success(id!, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Tool errors surface inside the JSON-RPC `result.isError` channel
        // per MCP spec — that's how callers tell "the tool reported an
        // error" apart from "the protocol layer failed". A thrown error
        // means the tool didn't return a result; we synthesise one so the
        // caller still gets an error to display, not a transport 500.
        return success(id!, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }

    // We don't expose resources or prompts yet — return an empty list rather
    // than method-not-found so well-behaved MCP clients (Claude Desktop,
    // Cursor) don't surface noisy "unknown method" warnings on startup.
    case "resources/list":
      return success(id!, { resources: [] });
    case "resources/templates/list":
      return success(id!, { resourceTemplates: [] });
    case "prompts/list":
      return success(id!, { prompts: [] });

    default:
      if (isNotification) return null;
      return error(id!, RPC_ERR.METHOD_NOT_FOUND, `unknown method: ${body.method}`);
  }
};
