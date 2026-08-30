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
  type KeyGuards,
} from "./guards";
import { resolveCallerMcpGuards } from "../services/roles/mcp-guards";
import { auditMcp, auditMcpResource } from "./audit";
import { resolveKind } from "./kind";
import {
  listResources,
  listResourceTemplates,
  readResource,
  UnknownResourceError,
} from "./resources";
import { getPrompt, listPrompts } from "./prompts";
import { complete } from "./completions";
import { resolveToolAlias } from "./tool-aliases";
import { fromWireToolName, toWireToolName } from "./wire-names";
import { TASKS_EXTENSION, cancelTask, getTask } from "./tasks";
import {
  CACHE,
  decorateResult,
  LEGACY_PROTOCOL_VERSION,
  MODERN_ERA,
  PROTOCOL_VERSION,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSION_LIST,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CacheHint,
  type McpEra,
} from "./protocol";

/** What the server tells an LLM it is for. Shared by the legacy `initialize`
 *  result and the modern `server/discover` one so the two can never drift. */
const SERVER_INSTRUCTIONS =
  "backlex MCP server — schema discovery, collection CRUD, storage, " +
  "vector / graphql / functions, role + permission management, plus " +
  "workspace resources and prompt templates. Permissions are enforced " +
  "by the caller's identity (API key or session); per-key allowlist + " +
  "read-only guards may further narrow what the agent can do.";

/** Server capabilities, identical in both eras.
 *
 *  `subscribe: false` is honest rather than lazy: `2026-07-28` replaced
 *  `resources/subscribe` with a long-lived `subscriptions/listen` stream, and
 *  we serve neither — a Worker isolate is the wrong place to hold a stream
 *  open per client, and the reactive SSE surface already covers the use case
 *  through its own endpoint. */
const serverCapabilities = () => ({
  tools: { listChanged: false },
  // Resources expose every collection as `backlex://collection/<slug>` so MCP
  // clients with attach pickers (Claude Desktop) can browse and pull
  // collection schema + sample rows into a chat.
  resources: { listChanged: false, subscribe: false },
  // Prompts ship starter templates: describe_collection, generate_queries,
  // permission_rule, generate_sdk_code.
  prompts: { listChanged: false },
  // Argument autocompletion for prompt / resource-template args (collection
  // slugs, generate_sdk_code language).
  completions: {},
});

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
  "server/discover",
  // Tasks read tenant-scoped run/job rows and can never reach a tool, so the
  // role-guard join buys nothing here. Tenant scope still applies inside.
  "tasks/get",
  "tasks/update",
  "tasks/cancel",
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
): Promise<KeyGuards> =>
  resolveCallerMcpGuards(
    honoCtx.get("ctx") as { db: unknown; dialect: "pg" | "sqlite" } | undefined,
    auth,
  );

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
 *  Cookie / session callers carry no guards and the checks become no-ops.
 *
 *  Every result leaves through `ok()` rather than `success()` so the era's
 *  obligations are applied in one place instead of at twelve return sites. */
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
  /** Which revision this request declared — see `mcp/protocol.ts`. Decides
   *  whether the result carries `resultType`, `_meta.serverInfo` and the cache
   *  hints, or the pre-2026 shape a handshake-era client expects. */
  era: McpEra,
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

  /** Success, shaped for the caller's era. `cache` is passed only by the five
   *  methods `2026-07-28` defines as cacheable; everything else omits it and
   *  the hint fields simply don't appear. */
  const ok = (rpcId: JsonRpcRequest["id"], result: unknown, cache?: CacheHint): JsonRpcResponse =>
    success(rpcId, decorateResult(result, era, cache));

  // Stateless transport: every request stands alone, so `initialize` is
  // always idempotent and `notifications/initialized` is a no-op we accept.
  switch (body.method) {
    case "initialize": {
      // Version negotiation: echo the client's requested version when we
      // support it, otherwise answer with our preferred one (per the lifecycle
      // spec). The client then sends this back in the MCP-Protocol-Version
      // header on subsequent HTTP requests.
      // `initialize` exists only in the handshake era, so the fallback is the
      // newest revision that HAS a handshake — never `PROTOCOL_VERSION`.
      // Answering `2026-07-28` here would tell the client to follow up with
      // `notifications/initialized` on a revision that deleted the concept.
      const requested = (body.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const negotiated =
        typeof requested === "string" &&
        SUPPORTED_PROTOCOL_VERSIONS.has(requested) &&
        requested !== PROTOCOL_VERSION
          ? requested
          : LEGACY_PROTOCOL_VERSION;
      return ok(id!, {
        protocolVersion: negotiated,
        serverInfo: SERVER_INFO,
        capabilities: serverCapabilities(),
        instructions: SERVER_INSTRUCTIONS,
      });
    }

    // `2026-07-28` replaced the handshake with this: one optional RPC that
    // reports what the server is and which revisions it speaks. Servers MUST
    // implement it, and a dual-era client uses it as the probe that tells a
    // modern server from a legacy one — so it answers in the modern shape
    // regardless of what the request itself declared.
    case "server/discover":
      return success(
        id!,
        decorateResult(
          {
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSION_LIST],
            capabilities: {
              ...serverCapabilities(),
              // Declared empty for anything we do not implement, so a client
              // can tell "supports none" from "predates the field".
              extensions: { [TASKS_EXTENSION]: {} },
            },
            instructions: SERVER_INSTRUCTIONS,
          },
          MODERN_ERA,
          CACHE.discover,
        ),
      );

    // ---- Tasks extension (`io.modelcontextprotocol/tasks`) ------------------
    // A durable handle for work that outlives a connection. No task table: the
    // ids address `agent_runs` and the job queue, both of which are already
    // durable and tenant-scoped. See `mcp/tasks.ts`.
    case "tasks/get": {
      const taskId = (body.params as { taskId?: unknown } | undefined)?.taskId;
      if (typeof taskId !== "string") {
        return error(id ?? null, RPC_ERR.INVALID_PARAMS, "params.taskId must be a string");
      }
      const dbCtx = honoCtx.get("ctx") as Parameters<typeof getTask>[0] | undefined;
      const task = dbCtx ? await getTask(dbCtx, auth.tenantId ?? null, taskId) : null;
      if (!task) {
        // An unknown id and another workspace's id answer the same, so a task
        // id cannot be used to probe for existence.
        return error(id ?? null, RPC_ERR.INVALID_PARAMS, `unknown task: ${taskId}`);
      }
      return ok(id!, task);
    }

    case "tasks/update": {
      // We surface no `inputRequests`, so there is nothing outstanding to
      // answer. The spec's instruction for exactly this case is to acknowledge
      // with an empty result and ignore responses for unknown keys — refusing
      // would strand a conforming client that always sends them.
      const taskId = (body.params as { taskId?: unknown } | undefined)?.taskId;
      if (typeof taskId !== "string") {
        return error(id ?? null, RPC_ERR.INVALID_PARAMS, "params.taskId must be a string");
      }
      return ok(id!, {});
    }

    case "tasks/cancel": {
      // Cooperative by contract: acknowledge the intent, honour it where the
      // store can. An agent turn is deliberately not cancellable — its tool
      // calls have already happened.
      const taskId = (body.params as { taskId?: unknown } | undefined)?.taskId;
      if (typeof taskId !== "string") {
        return error(id ?? null, RPC_ERR.INVALID_PARAMS, "params.taskId must be a string");
      }
      const dbCtx = honoCtx.get("ctx") as Parameters<typeof cancelTask>[0] | undefined;
      if (dbCtx) await cancelTask(dbCtx, auth.tenantId ?? null, taskId);
      return ok(id!, {});
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      // No-op acknowledgements. Stateless transport doesn't need to remember
      // the initialize handshake, but well-behaved clients send these anyway.
      return null;

    case "ping":
      return ok(id!, {});

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
      return ok(
        id!,
        {
          // Sorted by the name the client actually sees (wire name on the
          // tenant mount, dotted id on admin). `2026-07-28` asks for a
          // deterministic order because the catalog is large and a stable
          // order is what lets a client cache it — and, downstream, what keeps
          // an LLM provider's prompt cache from missing on every reconnect
          // because two tools swapped places.
          tools: wiring.tools
            .filter((t) => allowedNames.has(t.name))
            .map((t) => toolDescriptor(t, wiring.mode))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        },
        CACHE.toolsList,
      );
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
        return ok(id!, {
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
        return ok(id!, result);
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
        return ok(id!, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }

    case "resources/list": {
      try {
        return ok(id!, await listResources(toolCtx), CACHE.resourcesList);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return error(id ?? null, RPC_ERR.INTERNAL, message);
      }
    }

    case "resources/templates/list":
      return ok(id!, listResourceTemplates(), CACHE.resourceTemplates);

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
        return ok(id!, result, CACHE.resourceRead);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        auditMcpResource(honoCtx, wiring.env, {
          uri: params.uri,
          mode: wiring.mode,
          durationMs: Date.now() - startedAt,
          error: message,
        });
        // A URI that names no resource is a bad parameter, not a server
        // fault. `2026-07-28` renumbered this case from the
        // implementation-defined `-32002` to plain JSON-RPC `-32602`; we
        // never used `-32002`, but we did report it as INTERNAL, which told
        // a client to retry something that will never succeed.
        return error(
          id ?? null,
          e instanceof UnknownResourceError ? RPC_ERR.INVALID_PARAMS : RPC_ERR.INTERNAL,
          message,
        );
      }
    }

    case "prompts/list":
      return ok(id!, listPrompts(), CACHE.promptsList);

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
        return ok(id!, await getPrompt(toolCtx, params.name, args));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return error(id ?? null, RPC_ERR.INTERNAL, message);
      }
    }

    case "completion/complete": {
      const params = (body.params ?? {}) as { ref?: unknown; argument?: unknown };
      try {
        return ok(
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
