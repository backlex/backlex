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
import { listResources, readResource } from "./resources";
import { getPrompt, listPrompts } from "./prompts";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "backlex";
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

/** Tool-kind heuristic from the verb token after the last dot. The
 *  matching is on the leading verb token so both `schema.list` and
 *  `schema.list_collections` resolve to `read`. Used when a tool doesn't
 *  override `kind` directly — the verb set mirrors what the planner in
 *  `apps/web/src/server/routes/ai.ts` recognises so the UI badges line
 *  up with the auto-run / require-confirmation logic. Tools that mutate
 *  state but don't match the read/destruct verbs (`*.invoke`, `*.upload`,
 *  `*.grant`, `*.test`, …) fall through to `write`. */
const kindFromName = (name: string): "read" | "write" | "destruct" => {
  const dot = name.lastIndexOf(".");
  const tail = dot < 0 ? name : name.slice(dot + 1);
  const verb = tail.split("_")[0] ?? tail;
  if (verb === "delete" || verb === "drop" || verb === "revoke" || verb === "suspend") {
    return "destruct";
  }
  if (
    verb === "list" ||
    verb === "read" ||
    verb === "search" ||
    verb === "get" ||
    verb === "describe"
  ) {
    return "read";
  }
  return "write";
};

const toolDescriptor = (t: McpTool) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  // Surface UI hints alongside the standard MCP descriptor fields. Clients
  // that don't know about `kind` / `adminOnly` ignore them per JSON-RPC.
  kind: t.kind ?? kindFromName(t.name),
  ...(t.adminOnly ? { adminOnly: true as const } : {}),
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
          // Resources expose every collection as `workeros://collection/<slug>`
          // so MCP clients with attach pickers (Claude Desktop) can browse
          // and pull collection schema + sample rows into a chat. Subscribe
          // isn't supported yet — would require resumable SSE.
          resources: { listChanged: false, subscribe: false },
          // Prompts ship starter templates: describe_collection,
          // generate_queries, permission_rule.
          prompts: { listChanged: false },
        },
        instructions:
          "backlex MCP server — schema discovery, collection CRUD, storage, " +
          "vector / graphql / functions, role + permission management, plus " +
          "workspace resources and prompt templates. Permissions are enforced " +
          "by the caller's identity (API key or session); per-key allowlist + " +
          "read-only guards may further narrow what the agent can do.",
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
        env: wiring.env,
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

    case "resources/list": {
      const toolCtx: ToolCtx = {
        fetchInternal: makeInternalFetch(wiring.app, originRequest, wiring.env),
        mode: wiring.mode,
        env: wiring.env,
      };
      try {
        return success(id!, await listResources(toolCtx));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return error(id ?? null, RPC_ERR.INTERNAL, message);
      }
    }

    case "resources/templates/list":
      // No templates exposed — resources are enumerated directly via list.
      return success(id!, { resourceTemplates: [] });

    case "resources/read": {
      const params = (body.params ?? {}) as { uri?: unknown };
      if (typeof params.uri !== "string") {
        return error(id ?? null, RPC_ERR.INVALID_PARAMS, "params.uri must be a string");
      }
      const toolCtx: ToolCtx = {
        fetchInternal: makeInternalFetch(wiring.app, originRequest, wiring.env),
        mode: wiring.mode,
        env: wiring.env,
      };
      try {
        return success(id!, await readResource(toolCtx, params.uri));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return error(id ?? null, RPC_ERR.INTERNAL, message);
      }
    }

    case "prompts/list":
      return success(id!, listPrompts());

    case "prompts/get": {
      const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") {
        return error(id ?? null, RPC_ERR.INVALID_PARAMS, "params.name must be a string");
      }
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : undefined;
      const toolCtx: ToolCtx = {
        fetchInternal: makeInternalFetch(wiring.app, originRequest, wiring.env),
        mode: wiring.mode,
        env: wiring.env,
      };
      try {
        return success(id!, await getPrompt(toolCtx, params.name, args));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return error(id ?? null, RPC_ERR.INTERNAL, message);
      }
    }

    default:
      if (isNotification) return null;
      return error(id!, RPC_ERR.METHOD_NOT_FOUND, `unknown method: ${body.method}`);
  }
};
