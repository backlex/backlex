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
import { aiMeterForTenant, assertAiQuota } from "../services/usage";
import {
  checkToolCall,
  filterByAllowlist,
  guardsFromAuth,
  mergeGuards,
  type KeyGuards,
} from "./guards";
import { loadRoleMcpGuards } from "../services/roles/mcp-guards";
import { auditMcp, auditMcpResource } from "./audit";
import { resolveKind } from "./kind";
import { listResources, listResourceTemplates, readResource } from "./resources";
import { getPrompt, listPrompts } from "./prompts";
import { complete } from "./completions";
import { resolveToolAlias } from "./tool-aliases";
import { fromWireToolName, toWireToolName } from "./wire-names";

/** The protocol version we prefer (latest we implement). Returned from
 *  `initialize` when the client doesn't request a version we recognise. */
const PROTOCOL_VERSION = "2025-11-25";
/** Versions we accept from a client — both at `initialize` negotiation and in
 *  the `MCP-Protocol-Version` header on later HTTP requests. We support the
 *  current revision plus the two prior ones (the transport is unchanged across
 *  them aside from batching, which we no longer accept regardless). */
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
]);
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

/** Methods that can't reach a tool, a resource, or the caller's own scope —
 *  so the role-guard lookup is pure overhead for them. */
const HANDSHAKE_METHODS = new Set([
  "initialize",
  "ping",
  "notifications/initialized",
  "notifications/cancelled",
]);

/** Per-key guards folded together with the caller's role-derived guards.
 *  Degrades to the key guards alone when there's no request context (the MCP
 *  unit tests dispatch against a bare Hono context). */
const resolveEffectiveGuards = async (
  honoCtx: {
    get: (k: string) => unknown;
  },
  auth: {
    userId?: string | null;
    apiKeyRoleId?: string | null;
    apiKeyMcpTools?: string[] | null;
    apiKeyMcpReadOnly?: boolean;
  },
): Promise<KeyGuards> => {
  const keyGuards = guardsFromAuth(auth);
  const dbCtx = honoCtx.get("ctx") as
    | { db?: unknown; dialect?: "pg" | "sqlite" }
    | undefined;
  if (!dbCtx?.db || !dbCtx.dialect) return keyGuards;
  const role = await loadRoleMcpGuards(
    { db: dbCtx.db, dialect: dbCtx.dialect },
    {
      userId: auth.userId ?? null,
      apiKeyRoleId: auth.apiKeyRoleId ?? null,
    },
  );
  return mergeGuards(keyGuards, role);
};

/** First text block of a tool result — the error message when `isError` is set.
 *  Clipped, because the audit row wants a reason, not a payload dump. */
const firstText = (result: { content?: { type: string; text?: string }[] }): string => {
  const text = result.content?.find((b) => b.type === "text")?.text ?? "";
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
};

const toolDescriptor = (t: McpTool, mode: McpServerWiring["mode"]) => {
  const kind = resolveKind(t);
  return {
    // Wire name: on the tenant mount (external agents — claude.ai custom
    // connectors, Claude Desktop, Cursor, curl) dots → hyphens so strict
    // clients accept the `^[a-zA-Z0-9_-]{1,64}$` tool contract; `tools/call`
    // translates back. The admin mount (`/api/admin/mcp`, the Ask-AI Tools
    // tab) keeps the canonical dotted id — the tab round-trips these names
    // into the per-key `mcpTools` allowlist, which the guard matches dotted.
    name: mode === "tenant" ? toWireToolName(t.name) : t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    // Standard MCP behavioural hints (since 2025-03-26) so clients can
    // auto-approve reads / warn on destructive calls. Derived from the same
    // `kind` that drives the read-only guard, so badge and gate never disagree.
    annotations: {
      readOnlyHint: kind === "read",
      destructiveHint: kind === "destruct",
      idempotentHint: kind === "read",
      openWorldHint: false,
    },
    // Back-compat custom hints for the Ask-AI Tools tab; clients that don't
    // know `kind` / `adminOnly` ignore them per JSON-RPC.
    kind,
    ...(t.adminOnly ? { adminOnly: true as const } : {}),
  };
};

/** Dispatch a single JSON-RPC message. Notifications (no `id`) return `null`
 *  so the HTTP transport can answer 202 Accepted with an empty body.
 *
 *  `honoCtx` is the Hono context for the original MCP request — used to read
 *  the active key's MCP guards (allowlist, read-only) from `c.var.auth`.
 *  Cookie / session callers carry no guards and the checks become no-ops. */
export const dispatch = async (
  wiring: McpServerWiring,
  originRequest: Request,
  honoCtx: Context<{
    Variables: {
      auth?: {
        userId?: string | null;
        tenantId?: string | null;
        apiKeyId?: string | null;
        apiKeyRoleId?: string | null;
        apiKeyMcpTools?: string[] | null;
        apiKeyMcpReadOnly?: boolean;
      };
      /** Request context (db + dialect) — the audit writer needs it. Optional
       *  because the MCP tests dispatch against a bare Hono context. */
      ctx?: { db: unknown; dialect: "pg" | "sqlite" };
    };
  }>,
  body: JsonRpcRequest | { jsonrpc: "2.0"; method: string; params?: unknown },
): Promise<JsonRpcResponse | null> => {
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

  // Effective guards = the key's own restrictions folded together with whatever
  // the caller's roles impose. The role lookup is one indexed join, skipped
  // entirely for the handshake methods that can't touch a tool — every other
  // method either lists, calls, or reports the guards.
  const auth = honoCtx.get("auth") ?? {};
  const guards = HANDSHAKE_METHODS.has(body.method)
    ? guardsFromAuth(auth)
    : await resolveEffectiveGuards(honoCtx, auth);

  // One ToolCtx for every tool / resource / prompt / completion sub-call. The
  // internal fetch carries the caller's auth; `guards` lets a resource report
  // the caller's own MCP scope. Cheap to build (fetchInternal is lazy).
  const toolCtx: ToolCtx = {
    fetchInternal: makeInternalFetch(wiring.app, originRequest, wiring.env),
    mode: wiring.mode,
    env: wiring.env,
    guards,
    // The MCP request carries the workspace, so an `ai.*` tool's generation is
    // billed to whoever called the tool rather than going uncounted. Built from
    // the tenant rather than the Hono context because `dispatch` declares a
    // deliberately narrow structural context — the MCP tests hand it a bare one.
    meterAi: aiMeterForTenant(
      honoCtx.get("ctx") as Parameters<typeof aiMeterForTenant>[0],
      auth.tenantId,
      auth.apiKeyId,
    ),
    assertAiBudget: () =>
      assertAiQuota(
        honoCtx.get("ctx") as Parameters<typeof assertAiQuota>[0],
        wiring.env,
        auth.tenantId,
      ),
  };

  // Stateless transport: every request stands alone, so `initialize` is
  // always idempotent and `notifications/initialized` is a no-op we accept.
  switch (body.method) {
    case "initialize": {
      // Version negotiation: echo the client's requested version when we
      // support it, otherwise answer with our preferred one (per the lifecycle
      // spec). The client then sends this back in the MCP-Protocol-Version
      // header on subsequent HTTP requests.
      const requested = (body.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const negotiated =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : PROTOCOL_VERSION;
      return success(id!, {
        protocolVersion: negotiated,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: {
          tools: { listChanged: false },
          // Resources expose every collection as `backlex://collection/<slug>`
          // so MCP clients with attach pickers (Claude Desktop) can browse
          // and pull collection schema + sample rows into a chat. Subscribe
          // isn't supported yet — would require resumable SSE.
          resources: { listChanged: false, subscribe: false },
          // Prompts ship starter templates: describe_collection,
          // generate_queries, permission_rule, generate_sdk_code.
          prompts: { listChanged: false },
          // Argument autocompletion for prompt / resource-template args
          // (collection slugs, generate_sdk_code language).
          completions: {},
        },
        instructions:
          "backlex MCP server — schema discovery, collection CRUD, storage, " +
          "vector / graphql / functions, role + permission management, plus " +
          "workspace resources and prompt templates. Permissions are enforced " +
          "by the caller's identity (API key or session); per-key allowlist + " +
          "read-only guards may further narrow what the agent can do.",
      });
    }

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
          .map((t) => toolDescriptor(t, wiring.mode)),
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
      // Translate the wire name (hyphens) back to the canonical dotted id
      // before anything downstream — findTool, the guard allowlist, and the
      // activity log all key on the dotted id. A client that sent the dotted
      // id directly resolves unchanged.
      const canonicalName = resolveToolAlias(
        fromWireToolName(params.name, new Set(wiring.tools.map((t) => t.name))),
      );
      const tool = findTool(wiring.tools, canonicalName);
      if (!tool) {
        return error(id ?? null, RPC_ERR.METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
      }
      // Per-key guards run BEFORE the upstream permission DSL — a read-only
      // key calling `collections.delete` should fail fast with a clear MCP
      // error, not bounce around the REST layer first. The kind passed here is
      // the same one the descriptor advertised, so read-only is enforced on the
      // tool's true classification (not a separate name heuristic).
      const kind = resolveKind(tool);
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      const startedAt = Date.now();
      const guardCheck = checkToolCall(canonicalName, kind, guards);
      if (!guardCheck.ok) {
        // A refused call is the row an operator most wants to find later, so
        // it's audited unconditionally (see `shouldAudit`).
        auditMcp(honoCtx, wiring.env, {
          tool: canonicalName,
          kind,
          mode: wiring.mode,
          outcome: "denied",
          durationMs: Date.now() - startedAt,
          args,
          error: guardCheck.message,
        });
        return success(id!, {
          content: [{ type: "text", text: `${guardCheck.code}: ${guardCheck.message}` }],
          isError: true,
        });
      }
      try {
        const result = await tool.handler(args, toolCtx);
        auditMcp(honoCtx, wiring.env, {
          tool: canonicalName,
          kind,
          mode: wiring.mode,
          // A tool that reports `isError` ran but failed — that's an `mcp.error`
          // row, not a successful call, even though the RPC layer returns 200.
          outcome: result.isError ? "error" : "ok",
          durationMs: Date.now() - startedAt,
          args,
          ...(result.isError ? { error: firstText(result) } : {}),
        });
        return success(id!, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        auditMcp(honoCtx, wiring.env, {
          tool: canonicalName,
          kind,
          mode: wiring.mode,
          outcome: "error",
          durationMs: Date.now() - startedAt,
          args,
          error: message,
        });
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
      try {
        return success(id!, await listResources(toolCtx));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return error(id ?? null, RPC_ERR.INTERNAL, message);
      }
    }

    case "resources/templates/list":
      return success(id!, listResourceTemplates());

    case "resources/read": {
      const params = (body.params ?? {}) as { uri?: unknown };
      if (typeof params.uri !== "string") {
        return error(id ?? null, RPC_ERR.INVALID_PARAMS, "params.uri must be a string");
      }
      const startedAt = Date.now();
      try {
        const result = await readResource(toolCtx, params.uri);
        auditMcpResource(honoCtx, wiring.env, {
          uri: params.uri,
          mode: wiring.mode,
          durationMs: Date.now() - startedAt,
        });
        return success(id!, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        auditMcpResource(honoCtx, wiring.env, {
          uri: params.uri,
          mode: wiring.mode,
          durationMs: Date.now() - startedAt,
          error: message,
        });
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
      try {
        return success(id!, await getPrompt(toolCtx, params.name, args));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return error(id ?? null, RPC_ERR.INTERNAL, message);
      }
    }

    case "completion/complete": {
      const params = (body.params ?? {}) as { ref?: unknown; argument?: unknown };
      try {
        return success(
          id!,
          await complete(
            toolCtx,
            params.ref as Parameters<typeof complete>[1],
            params.argument as Parameters<typeof complete>[2],
          ),
        );
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
