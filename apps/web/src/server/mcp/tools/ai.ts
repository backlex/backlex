/**
 * AI-native MCP tools. Each delegates to Claude (via `callClaude`) and
 * then wires the structured reply back into backlex sub-fetches:
 *
 *   ai.query           — NL question → Directus `filter` JSON → executed
 *                        against `/api/items/<collection>`.
 *   ai.suggest_schema  — Prose description → proposed `fields` array
 *                        (the agent reviews + chooses whether to apply via
 *                        `schema.create_collection`).
 *   ai.import_csv      — Inline CSV → schema inference + bulk-insert via
 *                        the existing collection.
 *
 * Trade-off: these tools spend Anthropic tokens. They surface that cost
 * transparently in `structuredContent.usage` so callers can budget. None
 * of them auto-apply destructive changes — every mutation is a follow-up
 * tool call the agent must make explicitly.
 */
import { AppError } from "@backlex/core";
import type { McpTool, ToolResult, ToolCtx } from "../types";
import { callClaude, extractJson } from "../ai-client";
import { readJson } from "../internal-fetch";

/** Fail fast when the workspace has no AI credential — every `ai.*` tool
 *  checks this BEFORE any other sub-fetch so missing-key errors don't hide
 *  behind upstream 404s (`ai.query` on a non-existent collection used to
 *  report "Collection not found" before this guard was added). Either the
 *  preferred `AI_GATEWAY_API_KEY` or the legacy `ANTHROPIC_API_KEY`
 *  satisfies the check — `callClaude` picks the provider per-call. */
const requireAiKey = (ctx: ToolCtx): void => {
  const gw = ctx.env.AI_GATEWAY_API_KEY?.trim();
  const anth = ctx.env.ANTHROPIC_API_KEY?.trim();
  if (!gw && !anth) {
    throw new AppError(
      "UNAVAILABLE",
      "No AI provider configured for this workspace — set AI_GATEWAY_API_KEY (recommended, multi-provider) or the legacy ANTHROPIC_API_KEY on the backlex deployment.",
    );
  }
};

const textResult = (value: unknown, usage?: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: { ...(value as object), ...(usage ? { usage } : {}) },
});

interface CollectionMeta {
  slug: string;
  fields: Array<{ name: string; type: string; required?: boolean; to?: string }>;
}

const loadCollectionMeta = async (
  ctx: ToolCtx,
  slug: string,
): Promise<CollectionMeta> => {
  const res = await ctx.fetchInternal(`/api/collections/${encodeURIComponent(slug)}`);
  const body = await readJson<{ data: CollectionMeta }>(res);
  return body.data;
};

const renderSchemaContext = (meta: CollectionMeta): string => {
  const fields = (meta.fields ?? [])
    .map(
      (f) =>
        `  - ${f.name}: ${f.type}${f.required ? " (required)" : ""}${f.to ? ` → ${f.to}` : ""}`,
    )
    .join("\n");
  return `Collection: ${meta.slug}\nFields:\n${fields}`;
};

export const aiQuery: McpTool = {
  name: "ai.query",
  description:
    "Translate a natural-language question about a collection into a " +
    "Directus-shaped `filter` (with optional `sort` and `limit`) and run " +
    "it. Returns the executed query plan + the result rows. Use this when " +
    "the agent has a fuzzy intent (`top customers last month`) and needs " +
    "the structured query an analyst would write by hand.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Target collection slug." },
      prompt: {
        type: "string",
        description: "Free-text question (`active products under $50`, `users who signed up this week`).",
      },
      limit: {
        type: "number",
        description: "Hard cap on returned rows after the model picks a soft limit (default 25).",
      },
    },
    required: ["collection", "prompt"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const collection = String(args.collection ?? "");
    const prompt = String(args.prompt ?? "");
    if (!collection || !prompt) {
      throw new Error("VALIDATION: collection and prompt are required");
    }
    requireAiKey(ctx);
    const hardLimit = typeof args.limit === "number" ? Math.min(200, args.limit) : 200;

    const meta = await loadCollectionMeta(ctx, collection);
    const system =
      "You translate plain-English questions about a single backlex " +
      "collection into a JSON query object. Output EXACTLY one fenced " +
      "JSON block (```json ... ```). The JSON has shape: " +
      "{filter?: object, sort?: string, limit?: number}. The `filter` uses " +
      "Directus operators: _eq, _neq, _in, _nin, _lt, _gt, _lte, _gte, " +
      "_contains, _starts_with, _ends_with, _and, _or, _not, and the " +
      "variables $user.id, $user.email, $user.roles, $tenant.id, $now. " +
      "Sort is comma-separated, `-` prefix for DESC. Use only fields that " +
      "actually exist in the schema. If the question can't be expressed, " +
      "return {} (empty filter).";
    const user =
      `${renderSchemaContext(meta)}\n\nUser question: "${prompt}"\n\n` +
      `Return the JSON query object only.`;

    const reply = await callClaude(ctx.env, { system, user, maxTokens: 1024 });
    let query: { filter?: unknown; sort?: string; limit?: number };
    try {
      query = extractJson(reply.text);
    } catch (e) {
      throw new Error(`ai.query: ${(e as Error).message}`);
    }

    const qs = new URLSearchParams();
    if (query.filter && typeof query.filter === "object") {
      qs.set("filter", JSON.stringify(query.filter));
    }
    if (typeof query.sort === "string") qs.set("sort", query.sort);
    const effectiveLimit =
      typeof query.limit === "number"
        ? Math.min(query.limit, hardLimit)
        : Math.min(25, hardLimit);
    qs.set("limit", String(effectiveLimit));
    const path =
      `/api/items/${encodeURIComponent(collection)}` +
      (qs.toString() ? `?${qs.toString()}` : "");
    const res = await ctx.fetchInternal(path);
    const body = await readJson<{ data: unknown[]; meta?: unknown }>(res);

    return textResult(
      {
        query,
        appliedLimit: effectiveLimit,
        rowCount: Array.isArray(body.data) ? body.data.length : 0,
        rows: body.data,
        meta: body.meta ?? null,
      },
      reply.usage,
    );
  },
};

export const aiSuggestSchema: McpTool = {
  name: "ai.suggest_schema",
  description:
    "Draft a collection schema from a prose description. Returns a `fields` " +
    "array suitable for `schema.create_collection` plus a one-line note " +
    "per field explaining the choice. Does NOT auto-apply — the agent " +
    "must call `schema.create_collection` explicitly.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description:
          "What the collection should store (`CRM for a freelance designer`, `inventory of a coffee shop`, …).",
      },
      slug: {
        type: "string",
        description:
          "Optional suggested slug — if omitted, the model proposes one based on the description.",
      },
    },
    required: ["description"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const description = String(args.description ?? "");
    if (!description) throw new Error("VALIDATION: description is required");
    requireAiKey(ctx);
    const slugHint = typeof args.slug === "string" ? args.slug : null;

    const system =
      "You design backlex collection schemas. Output EXACTLY one fenced " +
      "JSON block (```json ... ```) with shape: " +
      "{slug: string, singular?: string, plural?: string, fields: Array<" +
      "{name: string, type: 'text'|'longtext'|'integer'|'number'|'boolean'|" +
      "'json'|'timestamp'|'uuid'|'relation'|'relation_many', required?: " +
      "boolean, unique?: boolean, to?: string, note?: string}>}. " +
      "Use snake_case for slug + field names. Add a `note` per field " +
      "explaining the choice — those notes are NOT stored; they help the " +
      "user review. Keep the schema minimal — 5-12 fields, no over-design.";
    const user =
      `Description: "${description}"\n` +
      (slugHint ? `Suggested slug: "${slugHint}"\n` : "") +
      `Return the JSON schema only.`;

    const reply = await callClaude(ctx.env, {
      system,
      user,
      model: "claude-sonnet-4-6",
      maxTokens: 2048,
    });
    let schema: { slug?: string; fields?: Array<{ name: string; type: string }> };
    try {
      schema = extractJson(reply.text);
    } catch (e) {
      throw new Error(`ai.suggest_schema: ${(e as Error).message}`);
    }

    return textResult(
      {
        suggestion: schema,
        howToApply:
          `Review the schema then call \`schema.create_collection\` with the same shape (minus the per-field \`note\` field).`,
      },
      reply.usage,
    );
  },
};

const parseCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"' && cur === "") {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
};

const parseCsv = (csv: string): { headers: string[]; rows: string[][] } => {
  const lines = csv
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]!).map((h) => h.trim());
  const rows = lines.slice(1).map(parseCsvLine);
  return { headers, rows };
};

export const aiImportCsv: McpTool = {
  name: "ai.import_csv",
  description:
    "Infer a schema from inline CSV text (first row = headers) and either " +
    "return the suggested schema (default) or insert the rows into an " +
    "existing collection. To create + populate in one go: call " +
    "`ai.import_csv` to get the schema, then `schema.create_collection`, " +
    "then `ai.import_csv` again with `collection` set to bulk-insert. " +
    "CSV is read entirely in-memory — 10k row / 5MB cap.",
  inputSchema: {
    type: "object",
    properties: {
      csv: { type: "string", description: "CSV text (first row is headers)." },
      collection: {
        type: "string",
        description:
          "When set, the parsed rows are inserted into this existing collection. Headers must match the collection's fields.",
      },
      sampleSize: {
        type: "number",
        description: "Rows shown to Claude for schema inference (default 10).",
      },
    },
    required: ["csv"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const csv = String(args.csv ?? "");
    if (!csv) throw new Error("VALIDATION: csv is required");
    if (csv.length > 5_000_000) {
      throw new Error("VALIDATION: csv exceeds 5 MB cap");
    }
    const { headers, rows } = parseCsv(csv);
    if (headers.length === 0) {
      throw new Error("VALIDATION: csv is empty or has no header row");
    }
    if (rows.length > 10_000) {
      throw new Error("VALIDATION: csv exceeds 10 000-row cap");
    }
    const collection = typeof args.collection === "string" ? args.collection : null;
    const sampleSize =
      typeof args.sampleSize === "number" ? Math.max(1, Math.min(50, args.sampleSize)) : 10;

    if (collection) {
      // Insert path — bulk-insert via collections.bulk_insert (the same
      // bounded-concurrency loop, but here we shortcut directly to the
      // sub-fetch so the agent gets per-row results without an extra
      // tool hop).
      const records = rows.map((cells) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
          obj[headers[i]!] = cells[i] ?? "";
        }
        return obj;
      });
      const succeeded: unknown[] = [];
      const failed: Array<{ index: number; error: string }> = [];
      for (let i = 0; i < records.length; i++) {
        const res = await ctx.fetchInternal(
          `/api/items/${encodeURIComponent(collection)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(records[i]),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as { data?: unknown };
          succeeded.push(body.data);
        } else {
          let msg = `HTTP ${res.status}`;
          try {
            const err = (await res.json()) as { error?: { message?: string } };
            msg = err.error?.message ?? msg;
          } catch {
            /* leave msg */
          }
          failed.push({ index: i, error: msg });
        }
      }
      return textResult({
        mode: "insert",
        collection,
        total: records.length,
        succeeded: succeeded.length,
        failed: failed.length,
        failures: failed.slice(0, 20),
      });
    }

    // Inference path requires an AI provider. Check the key first so the
    // user gets a clear "set AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY" error
    // rather than a downstream auth failure. The insert path above does
    // NOT need any model, so it has no such requirement — callers can
    // bulk-insert pre-parsed CSV into an existing collection without one.
    requireAiKey(ctx);
    // Inference path — ask Claude to propose a schema based on headers + a
    // sample. Return the schema; agent applies via schema.create_collection.
    const sampleRows = rows.slice(0, sampleSize).map((cells) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) obj[headers[i]!] = cells[i] ?? "";
      return obj;
    });
    const system =
      "You infer backlex collection schemas from CSV data. Output EXACTLY " +
      "one fenced JSON block (```json ... ```) with shape: " +
      "{slug: string, fields: Array<{name, type, required?, unique?}>}. " +
      "Field types: text, longtext, integer, number, boolean, json, " +
      "timestamp, uuid. Snake_case slugs + field names. Use the header " +
      "names verbatim (snake_case them only if needed). Mark `unique: " +
      "true` only when the sampled column values are clearly identifiers.";
    const user =
      `CSV headers: ${JSON.stringify(headers)}\n\n` +
      `Sample rows (first ${sampleRows.length}):\n${JSON.stringify(sampleRows, null, 2)}\n\n` +
      `Return the JSON schema only.`;

    const reply = await callClaude(ctx.env, {
      system,
      user,
      model: "claude-sonnet-4-6",
      maxTokens: 2048,
    });
    let schema: unknown;
    try {
      schema = extractJson(reply.text);
    } catch (e) {
      throw new Error(`ai.import_csv: ${(e as Error).message}`);
    }
    return textResult(
      {
        mode: "infer",
        rowCount: rows.length,
        sampleSize: sampleRows.length,
        schema,
        howToApply:
          `Review the schema, call \`schema.create_collection\` with it, then call \`ai.import_csv\` again with \`collection\` set to bulk-insert the rows.`,
      },
      reply.usage,
    );
  },
};

export const aiTools: McpTool[] = [aiQuery, aiSuggestSchema, aiImportCsv];
