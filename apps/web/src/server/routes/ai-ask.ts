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
import { AppError, EMBEDDING_MODEL_NAMES, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import type { Env } from "../env";
import { requireUser } from "../middleware/session";
import { callClaude, extractJson } from "../mcp/ai-client";
import { allTools } from "../mcp/tools";
import { makeInternalFetch, readJson } from "../mcp/internal-fetch";
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
  "collections.aggregate",
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
    "collections.aggregate":
      "{collection: string, agg: 'count'|'sum'|'avg'|'min'|'max', field?: string, " +
      "groupBy?: string, filter?: object, limit?: number} — analytics over a " +
      "collection. Use this (NOT collections.list) for totals/averages/counts " +
      "and \"top N by <metric>\" questions. `field` (sum/avg/min/max) and " +
      "`groupBy` MUST be EXACT field names from the schema — use a relation " +
      "field's own name as shown (e.g. `customer`), do NOT append `_id`. Group " +
      "by the relation FK column to bucket by the related record. Grouped " +
      "results come back ordered by value desc; single-table only.",
    "storage.list":
      "{prefix?: string, folder?: string, search?: string, limit?: number} — list files in object storage.",
    "vector.search":
      `{model: string, text: string, topK?: number, namespace?: string, filter?: object} — ` +
      `semantic search: embeds free-text \`text\` with \`model\` and returns nearest neighbors. ` +
      `\`model\` MUST be one of: ${EMBEDDING_MODEL_NAMES.join(", ")} (default bge-m3). ` +
      `\`topK\` is camelCase (1-100, default 10). \`namespace\` (NOT \`collection\`) scopes the search. ` +
      `\`filter\` is a provider-specific metadata map — NOT a Directus filter, and it is NOT used for ` +
      `date ranges or field comparisons. For structured queries (date ranges, field filters, "last month", ` +
      `counts) use \`collections.list\` with a Directus filter instead — \`text\` is for meaning, not predicates.`,
    "schema.list_collections":
      "{} — every collection visible to the workspace, with field counts.",
    "schema.describe_collection":
      "{collection: string} — full field schema for one collection.",
    "ai.suggest_schema":
      "{description: string, slug?: string} — draft a collection schema from prose.",
  };

/** Shape of the collection rows GET /api/collections returns — only the
 *  slice the digest needs. */
interface CollectionMeta {
  slug: string;
  note?: string | null;
  fields?: Array<{ name: string; type?: string; to?: string }>;
}

/** System columns every collection can be filtered/sorted on regardless of
 *  its declared fields — mirrors `SYSTEM_COLUMNS` in server/lib/query.ts. */
const SYSTEM_FIELDS = "id (uuid), created_at (timestamp), updated_at (timestamp)";

/** Soft cap so a workspace with hundreds of collections can't blow the
 *  planner's context window. Past this many chars we keep slugs + field
 *  names but drop types/notes; that's still enough to stop hallucinated
 *  field names, which is the whole point. */
const DIGEST_CHAR_BUDGET = 12_000;

/** Render one collection as `slug: f1 (type), f2 (relation→target), …`. */
const describeOne = (c: CollectionMeta, withTypes: boolean): string => {
  const fields = Array.isArray(c.fields) ? c.fields : [];
  const cols = fields.map((f) => {
    if (!withTypes) return f.name;
    if (f.to) return `${f.name} (relation→${f.to})`;
    return f.type ? `${f.name} (${f.type})` : f.name;
  });
  const note = withTypes && c.note ? ` — ${c.note}` : "";
  return `  - ${c.slug}: ${cols.join(", ")}${note}`;
};

/** Build the schema block the planner sees so it only filters/sorts on
 *  fields that actually exist. Returns "" when there are no collections.
 *  Exported for unit tests — not part of the route surface. */
export const buildSchemaDigest = (collections: CollectionMeta[]): string => {
  if (!collections.length) return "";
  let lines = collections.map((c) => describeOne(c, true));
  let body = lines.join("\n");
  if (body.length > DIGEST_CHAR_BUDGET) {
    // Second pass: drop types/notes to fit more collections in budget.
    lines = collections.map((c) => describeOne(c, false));
    body = lines.join("\n");
  }
  return (
    "\n\nWorkspace schema — filter, sort, and `fields` may ONLY reference " +
    "field names that appear here (plus the system fields " +
    `${SYSTEM_FIELDS}, present on every collection). If a question asks ` +
    "about something with no matching field, pick the closest real field " +
    "and say so in `rationale` — NEVER invent a field name:\n" +
    body
  );
};

const buildPlanSystem = (schemaDigest: string, todayIso: string): string => {
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
    "\n\nFilter shape: a filter is `{ fieldName: { _op: value } }`. " +
    "Field comparison operators (underscore-prefixed): _eq, _neq, _in, " +
    "_nin, _lt, _gt, _lte, _gte, _null, _contains, _starts_with, _ends_with. " +
    "Logical combinators are DOLLAR-prefixed and take an array (or, for " +
    "$not, a single condition): $and, $or, $not — e.g. " +
    '{ "$and": [{ "status": { "_eq": "active" } }, { "age": { "_gte": 18 } }] }. ' +
    "`$and`/`$or`/`$not` are canonical; `_and`/`_or`/`_not` are also accepted. " +
    "Combinators may ONLY appear as the key of a condition object, NEVER inside " +
    'a field\'s operator object: { "age": { "$not": {...} } } is INVALID; wrap ' +
    'with a top-level { "$not": { "age": {...} } } instead.\n\n' +
    "RELATIONS: filter, sort, AND `fields` can traverse a relation via a " +
    "DOT-PATH whose first segment is a relation field shown in the schema — e.g. " +
    'filter { "customer_id.name": { "_eq": "Alice" } }, sort ' +
    '"customer_id.name", fields ["customer_id.name"] (or "customer_id.*" for ' +
    "the whole related row, which returns a nested object). The nested-object " +
    'filter form { "customer_id": { "name": { "_eq": "Alice" } } } is also ' +
    "accepted and means the same thing. belongs-to chains allow up to 2 hops in " +
    "filter (a.b.c); has-many (relation_many) is single-hop, not sortable, and " +
    "not projectable via fields.\n\n" +
    "Variables (substituted server-side): $user.id, $user.email, $user.roles, " +
    "$tenant.id, and $now. For relative ranges use the relative-date value " +
    '{ "$now": { "sub"|"add": { years?, months?, weeks?, days?, hours?, ' +
    "minutes?, seconds? } } } anywhere a value is expected — e.g. " +
    '"in the last month" → ' +
    '{ "placed_at": { "_gte": { "$now": { "sub": { "months": 1 } } } } }. ' +
    `(Today is ${todayIso} if you prefer an absolute ISO date.) ` +
    "Extra operators: _between [lo,hi]; case-insensitive _icontains / " +
    "_istarts_with / _iends_with; _empty / _nempty.\n\n" +
    "AGGREGATION: collections.list has NO grouping or aggregate functions — it " +
    "only lists rows. For totals, averages, counts, or \"top N by <metric>\" " +
    "questions use the `collections.aggregate` tool instead (agg + optional " +
    "groupBy). Do NOT invent $group / $sum / $count / $having inside a filter — " +
    "they are rejected. `field` and `groupBy` MUST be EXACT field names from the " +
    "schema below — use a relation field's own name verbatim (do NOT append " +
    "`_id`). \"Top customers by spend last month\" (orders has relation field " +
    "`customer` + numeric `total`) → collections.aggregate { agg: 'sum', field: " +
    "'total', groupBy: 'customer', filter: { placed_at: { _gte: { $now: { sub: " +
    "{ months: 1 } } } } }, limit: 10 }." +
    schemaDigest
  );
};

type FetchInternal = (path: string, init?: RequestInit) => Promise<Response>;

/** Best-effort fetch of the workspace's collections for the planner's
 *  schema digest. Reuses the in-process Hono app so tenant resolution and
 *  read permissions apply exactly as for a direct call. Never throws — a
 *  failed lookup just yields a schema-less prompt (prior behavior). */
const loadSchemaDigest = async (fetchInternal: FetchInternal): Promise<string> => {
  try {
    const res = await fetchInternal("/api/collections");
    const body = await readJson<{ data: CollectionMeta[] }>(res);
    return buildSchemaDigest(Array.isArray(body.data) ? body.data : []);
  } catch {
    return "";
  }
};

/** Read a non-OK Response and return the upstream error string only for the
 *  deterministic, model-fixable failures (VALIDATION / FORBIDDEN / NOT_FOUND);
 *  null for OK or an unrelated 5xx we shouldn't try to "correct". */
const modelFixableError = async (res: Response): Promise<string | null> => {
  if (res.ok) return null;
  const body = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  const err = body?.error;
  if (
    err?.message &&
    (err.code === "VALIDATION" || err.code === "FORBIDDEN" || err.code === "NOT_FOUND")
  ) {
    return `${err.code}: ${err.message}`;
  }
  return null;
};

/**
 * Dry-run a structured plan against the REAL endpoint so the SAME
 * parser/validator/permission gate the `/run` path uses decides if it is
 * well-formed — including relation hops a re-implemented validator couldn't
 * reach. `collections.list` runs with limit=1; `collections.aggregate` POSTs
 * its config. Returns the upstream error string on a model-fixable 4xx, else
 * null. Other tools aren't dry-run (return null).
 *
 * Exported for tests — it's the core of the planner self-correction loop.
 */
export const dryRunPlan = async (
  fetchInternal: FetchInternal,
  tool: string,
  args: Record<string, unknown>,
): Promise<string | null> => {
  const slug = typeof args.collection === "string" ? args.collection : "";
  if (!slug) return null;
  try {
    if (tool === "collections.aggregate") {
      const { collection: _c, ...body } = args;
      const res = await fetchInternal(
        `/api/items/${encodeURIComponent(slug)}/aggregate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return await modelFixableError(res);
    }
    if (tool === "collections.list") {
      const params = new URLSearchParams();
      if (args.filter && typeof args.filter === "object") {
        params.set("filter", JSON.stringify(args.filter));
      }
      if (args.sort !== undefined) {
        params.set("sort", Array.isArray(args.sort) ? args.sort.join(",") : String(args.sort));
      }
      if (args.fields !== undefined) {
        params.set("fields", Array.isArray(args.fields) ? args.fields.join(",") : String(args.fields));
      }
      params.set("limit", "1");
      const res = await fetchInternal(`/api/items/${encodeURIComponent(slug)}?${params}`);
      return await modelFixableError(res);
    }
  } catch {
    return null; // transport hiccup — don't trigger a correction
  }
  return null;
};

/** @deprecated kept as a thin alias for existing tests. */
export const dryRunListQuery = (
  fetchInternal: FetchInternal,
  args: Record<string, unknown>,
): Promise<string | null> => dryRunPlan(fetchInternal, "collections.list", args);

interface PlanResult {
  rationale: string;
  tool: string;
  args: Record<string, unknown>;
  model: string;
  usage?: unknown;
  /** Set when the plan still fails validation after one corrective retry, so
   *  the UI can warn before the operator clicks Run (instead of a 422). */
  validationError?: string;
}

/** Coerce a raw extractJson result into {rationale, tool, args}. Throws on the
 *  shape errors the route surfaces as 422. */
const coercePlan = (parsed: {
  rationale?: unknown;
  tool?: unknown;
  args?: unknown;
}): { rationale: string; tool: string; args: Record<string, unknown> } => {
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
  return { rationale: parsed.rationale, tool: parsed.tool, args };
};

const planHandler = async (
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
  app: Hono<AppBindings>,
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

  const fetchInternal = makeInternalFetch(app as unknown as Hono, c.req.raw, env);
  const schemaDigest = await loadSchemaDigest(fetchInternal);
  const todayIso = new Date().toISOString().slice(0, 10);
  const system = buildPlanSystem(schemaDigest, todayIso);

  const reply = await callClaude(env, {
    system,
    user: prompt,
    model,
    maxTokens: 1024,
  });

  const parse = (
    text: string,
  ): { rationale?: unknown; tool?: unknown; args?: unknown } => {
    try {
      return extractJson(text) as {
        rationale?: unknown;
        tool?: unknown;
        args?: unknown;
      };
    } catch (e) {
      throw new AppError(
        "VALIDATION",
        `Could not parse model reply as JSON: ${(e as Error).message}`,
      );
    }
  };

  let plan = coercePlan(parse(reply.text));
  let usage: unknown = reply.usage;
  let validationError: string | undefined;

  // Self-correction: dry-run a structured plan (list or aggregate) against the
  // real endpoint and, if it fails validation, hand the model the exact error
  // for ONE corrective retry. Caps cost/latency at a single extra call; a
  // still-bad plan is returned annotated so the UI can warn before Run.
  const err = await dryRunPlan(fetchInternal, plan.tool, plan.args);
  if (err) {
    const retry = await callClaude(env, {
      system,
      user:
        `${prompt}\n\nYour previous answer was:\n` +
        `\`\`\`json\n${JSON.stringify({ tool: plan.tool, args: plan.args })}\n\`\`\`\n` +
        `but it failed validation with:\n${err}\n` +
        "Return ONE corrected JSON block. Use only fields that exist in the " +
        "schema; relation paths use dotted keys in filter/sort; `fields` " +
        "takes plain column names; for totals/counts/top-N use " +
        "collections.aggregate (agg + groupBy), not $group/$sum in a filter.",
      model,
      maxTokens: 1024,
    });
    try {
      const corrected = coercePlan(parse(retry.text));
      plan = corrected;
      usage = retry.usage;
      // Re-validate the corrected plan; surface a lingering failure.
      validationError =
        (await dryRunPlan(fetchInternal, corrected.tool, corrected.args)) ?? undefined;
    } catch {
      // Retry produced unparseable JSON — keep the first plan, annotate.
      validationError = err;
    }
  }

  const result: PlanResult = {
    rationale: plan.rationale,
    tool: plan.tool,
    args: plan.args,
    model,
    usage,
    ...(validationError ? { validationError } : {}),
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
    .post("/plan", requireUser, requireAdmin, (c) => planHandler(c, app, env))
    .post("/run", requireUser, requireAdmin, (c) => runHandler(c, app, env));
