/**
 * Admin "Ask AI" routes — the backend the admin SPA's Ask tab calls.
 *
 * The design's `planForPrompt` is a one-shot client mock; real workflows
 * want a review-args step between intent and execution. We split that into
 * two POST endpoints so the UI can render the plan, let the operator edit
 * the args, then confirm:
 *
 *   POST /plan  →  {prompt, model?} → {rationale, tool, args, model, usage}
 *   POST /run   →  {tool, args}     → {ok, result, rowCount, durationMs}
 *
 * Both routes require an admin role. `/plan` calls Claude directly via
 * `callClaude` (no MCP round-trip) so the system prompt can constrain the
 * model to the read-leaning whitelist. `/run` invokes a single tool out of
 * `allTools` and writes one row to the `activity` table on success AND
 * failure so the Recent Runs panel has a canonical source — see
 * docs/ask-ai.md for why logging stays here instead of in the dispatcher.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import type { Env } from "../env";
import { requireUser } from "../middleware/session";
import { callClaude, extractJson } from "../mcp/ai-client";
import { allTools } from "../mcp/tools";
import { makeInternalFetch } from "../mcp/internal-fetch";
import type { ToolCtx } from "../mcp/types";
import { recordActivity, requestMeta } from "../services/activity";

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

// Gateway-prefixed default. `callClaude` auto-strips the prefix when the
// workspace is on the legacy `ANTHROPIC_API_KEY` fallback, so this value
// works for both providers.
const DEFAULT_PLAN_MODEL = "anthropic/claude-haiku-4-5";

/** Read-leaning tools the planner is allowed to propose. Anything outside
 *  this list still works from the admin's hand-edit path, but the model
 *  shouldn't auto-suggest a destructive mutation. Matches the Ask tab's
 *  `autoRun` regex on the client. */
const PLAN_TOOL_WHITELIST = [
  "collections.list",
  "collections.read",
  "storage.list",
  "vector.search",
  "schema.list_collections",
  "schema.describe_collection",
  "ai.suggest_schema",
] as const;

const PLAN_TOOL_DESCRIPTIONS: Record<(typeof PLAN_TOOL_WHITELIST)[number], string> =
  {
    "collections.list":
      "{collection: string, filter?: object, sort?: string|string[], limit?: number, fields?: string[]} — list items with a Directus-shaped filter.",
    "collections.read":
      "{collection: string, id: string, fields?: string[]} — read one item by id.",
    "storage.list":
      "{prefix?: string, folder?: string, search?: string, limit?: number} — list files in object storage.",
    "vector.search":
      "{collection: string, query: string, top_k?: number} — semantic search over an embedded collection.",
    "schema.list_collections":
      "{} — every collection visible to the workspace, with field counts.",
    "schema.describe_collection":
      "{collection: string} — full field schema for one collection.",
    "ai.suggest_schema":
      "{description: string, slug?: string} — draft a collection schema from prose.",
  };

const buildPlanSystem = (): string => {
  const catalog = PLAN_TOOL_WHITELIST.map(
    (name) => `  - ${name}: ${PLAN_TOOL_DESCRIPTIONS[name]}`,
  ).join("\n");
  return (
    "You translate a single natural-language question from a backlex admin " +
    "into ONE MCP tool call. Output EXACTLY one fenced JSON block " +
    "(```json ... ```) with shape: {rationale: string, tool: string, args: object}. " +
    "`rationale` is one or two short sentences that justify the choice. " +
    "`tool` MUST be one of the allowed names below. `args` MUST match that " +
    "tool's argument shape. Do not invent fields. Pick the tool that needs " +
    "the least follow-up. If the question can't be expressed with the " +
    "allowed tools, still pick the closest read tool and explain the gap " +
    "in `rationale`.\n\nAllowed tools:\n" +
    catalog +
    "\n\nDirectus filter operators: _eq, _neq, _in, _nin, _lt, _gt, _lte, " +
    "_gte, _contains, _starts_with, _ends_with, _and, _or, _not. Variables: " +
    "$user.id, $user.email, $user.roles, $tenant.id, $now."
  );
};

interface PlanResult {
  rationale: string;
  tool: string;
  args: Record<string, unknown>;
  model: string;
  usage?: unknown;
}

const planHandler = async (
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
  env: Env,
) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    prompt?: unknown;
    model?: unknown;
  };
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    throw new AppError("VALIDATION", "prompt is required");
  }
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : DEFAULT_PLAN_MODEL;

  const reply = await callClaude(env, {
    system: buildPlanSystem(),
    user: prompt,
    model,
    maxTokens: 1024,
  });

  let parsed: { rationale?: unknown; tool?: unknown; args?: unknown };
  try {
    parsed = extractJson(reply.text);
  } catch (e) {
    throw new AppError(
      "VALIDATION",
      `Could not parse model reply as JSON: ${(e as Error).message}`,
    );
  }
  if (typeof parsed.tool !== "string" || !parsed.tool) {
    throw new AppError("VALIDATION", "Model reply missing `tool`");
  }
  if (typeof parsed.rationale !== "string") {
    throw new AppError("VALIDATION", "Model reply missing `rationale`");
  }
  const args =
    parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
      ? (parsed.args as Record<string, unknown>)
      : {};

  const result: PlanResult = {
    rationale: parsed.rationale,
    tool: parsed.tool,
    args,
    model,
    usage: reply.usage,
  };
  return c.json({ data: result });
};

const runHandler = async (
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
  app: Hono<AppBindings>,
  env: Env,
) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    tool?: unknown;
    args?: unknown;
  };
  const toolName = typeof body.tool === "string" ? body.tool : "";
  if (!toolName) {
    throw new AppError("VALIDATION", "tool is required");
  }
  const tool = allTools.find((t) => t.name === toolName);
  if (!tool) {
    throw new AppError("NOT_FOUND", `Unknown MCP tool: ${toolName}`);
  }
  const args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};

  const toolCtx: ToolCtx = {
    fetchInternal: makeInternalFetch(
      app as unknown as Hono,
      c.req.raw,
      env,
    ),
    mode: "admin",
    env,
  };

  const start = Date.now();
  let ok = true;
  let errorMessage: string | null = null;
  let toolResult: unknown = null;
  try {
    toolResult = await tool.handler(args, toolCtx);
  } catch (e) {
    ok = false;
    errorMessage = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Date.now() - start;

  // Best-effort row count for the structuredContent shapes we know about.
  const structured =
    (toolResult as { structuredContent?: unknown } | null)
      ?.structuredContent ?? null;
  const rowCount = (() => {
    if (!structured || typeof structured !== "object") return null;
    const s = structured as Record<string, unknown>;
    if (Array.isArray(s.data)) return s.data.length;
    if (typeof s.rowCount === "number") return s.rowCount;
    if (Array.isArray((s as { rows?: unknown[] }).rows))
      return ((s as { rows: unknown[] }).rows).length;
    if (Array.isArray((s as { collections?: unknown[] }).collections))
      return ((s as { collections: unknown[] }).collections).length;
    if (Array.isArray((s as { fields?: unknown[] }).fields))
      return ((s as { fields: unknown[] }).fields).length;
    return null;
  })();

  const auth = c.get("auth");
  const ctx = c.get("ctx");
  const meta = requestMeta(c.req.raw);
  // Action carries the dot prefix so the activity service's category-mapper
  // short-circuits and stores `mcp.<tool>` verbatim — the Recent Runs panel
  // filters via `?action=mcp.` so the namespacing has to be stable.
  await recordActivity(
    { db: ctx.db, dialect: ctx.dialect },
    {
      userId: auth?.userId ?? null,
      tenantId: auth?.tenantId ?? null,
      action: `mcp.${toolName}`,
      collection: "mcp",
      itemId: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      payload: { tool: toolName, args },
      response: ok
        ? { ok: true, rowCount }
        : { ok: false, error: errorMessage },
      durationMs,
    },
  );

  if (!ok) {
    return c.json(
      {
        ok: false,
        tool: toolName,
        error: errorMessage,
        durationMs,
      },
      200,
    );
  }
  return c.json({
    ok: true,
    tool: toolName,
    result: toolResult,
    rowCount,
    durationMs,
  });
};

/** Admin-only Ask AI surface. Mounted at `/api/admin/ai` so the same admin-
 *  role gate that protects MCP applies here too. The parent app + env are
 *  closed over so the /run handler can issue in-process sub-fetches against
 *  the same Hono instance (identical pattern to `mcp.ts`). */
export const aiAskRoutes = (app: Hono<AppBindings>, env: Env) =>
  new Hono<AppBindings>()
    .post("/plan", requireUser, requireAdmin, (c) => planHandler(c, env))
    .post("/run", requireUser, requireAdmin, (c) => runHandler(c, app, env));
