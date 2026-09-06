import { and, eq, sql, type SQL } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  compileCondition,
  type FieldDef,
} from "@backlex/db";
import type { Condition } from "@backlex/core";
import {
  AI_OP_DEFAULT_MAX_TOKENS,
  AI_OP_DEFAULT_TIMEOUT_MS,
  AI_OP_MAX_TIMEOUT_MS,
  AI_OP_MAX_TOKENS,
} from "@backlex/core";
import { resolvePermission } from "../permissions";
import { sendPushToUsers } from "../push";
import { fetchOutbound } from "../storage/hosts";
import { resolveAiRuntime } from "../ai-config";
import { aiMeterForTenant, assertAiQuota } from "../usage";
import { aiAvailable, callClaude } from "../../mcp/ai-client";
import type { Ctx } from "../../context";
import type { RpcOp, SandboxBindings } from "./types";
import { deserialize, deserializeField } from "../items/serialize";

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

interface CollectionShape {
  slug: string;
  physicalTable: string;
  fields: FieldDef[];
  ownerScoped: boolean | number;
}

const loadCollection = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  slug: string,
): Promise<CollectionShape | null> => {
  if (!tenantId) return null;
  const t = collectionsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    slug: r.slug,
    physicalTable: r.physicalTable ?? r.physical_table,
    fields: r.fields,
    ownerScoped: r.ownerScoped ?? r.owner_scoped,
  };
};

const queryAll = async <T>(ctx: Ctx, q: SQL): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = (await (ctx.db as any).execute(q)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r)
      return (r as { rows: T[] }).rows;
    return r as T[];
  }
  return (await (ctx.db as any).all(q)) as T[];
};

const camel = (s: string): string =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

// Row shaping delegates to the items read path rather than repeating it. The
// copy that used to live here had already fallen behind: it knew nothing of
// `geo`, `relation_many` or `hash`, so a sandboxed function reading a
// collection with any of those got a different value than the REST API would
// hand back for the same row.

const renderRow = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  dialect: "pg" | "sqlite",
  ownerScoped: boolean,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: row.id,
    createdAt: deserialize(row.created_at, "timestamp", dialect),
    updatedAt: deserialize(row.updated_at, "timestamp", dialect),
  };
  if (ownerScoped) out.ownerId = row.owner_id ?? null;
  for (const f of fields) {
    out[camel(f.name)] = deserializeField(row[f.name], f, dialect, row, fields);
  }
  return out;
};

/**
 * Is a sandboxed function allowed to fetch this URL?
 *
 * The SCHEME is checked first, and before the `*` short-circuit, because the
 * allow-list is about hosts and a scheme is not a host. `new URL(
 * "file://api.example.com/etc/passwd").host` is `api.example.com`, so an
 * operator who set the documented `FUNCTIONS_FETCH_ALLOW=api.example.com` was
 * one four-letter scheme away from handing a workspace admin `.env`,
 * `/proc/self/environ` and `./.data/backlex.sqlite` — the whole multi-tenant
 * database — as `{status, ok, text}` in their own function's return value. Bun
 * ignores the host on a `file:` URL and reads the path.
 *
 * The guarded path already refused this (`assertPublicHttpUrl` rejects
 * non-http(s)), which is exactly why it had to move here: it must not depend on
 * `ssrfGuardEnabled`, and `ssrfGuardEnabled` is FALSE on the self-host default
 * this option is documented for.
 *
 * Exported only so a spec can assert it directly. A guard reachable solely
 * through a live sandbox invocation is a guard nobody writes the negative case
 * for, which is how the scheme hole survived.
 */
export const isAllowedFetch = (rawUrl: string, allowlist: string[]): boolean => {
  if (allowlist.length === 0) return false;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (allowlist.includes("*")) return true;
  return allowlist.some((host) => u.host === host || u.host.endsWith(`.${host}`));
};

/**
 * The workspace an op is acting on, or a refusal.
 *
 * Every tenant-scoped op on this bridge answers "no workspace" the same way,
 * in the service rather than at one door, because the route is not the only
 * caller: `providers/bun-worker.ts` reaches `dispatchRpc` in-process and never
 * passes through `routes/sandbox-rpc.ts` at all. A clamp that lived on the
 * route would be exactly as wide as one of the two callers.
 */
const requireWorkspace = (bindings: SandboxBindings, op: string): string => {
  const tenantId = bindings.auth.tenantId ?? null;
  if (!tenantId) throw new Error(`${op} requires a workspace-scoped run`);
  return tenantId;
};

/**
 * Single dispatcher used by every provider's host-side RPC handler. Translates
 * an `RpcOp` from the sandbox into a permission-checked operation on the live
 * Ctx. Callers (provider implementations) are responsible for serializing
 * arguments and the return value.
 *
 * `bindings.auth` is the subject the invocation runs as, and every caller is
 * responsible for it being real: the in-process providers pass the live
 * request's subject, and `routes/sandbox-rpc.ts` derives it from a signed
 * grant rather than from the executor's request body.
 */
export const dispatchRpc = async (
  bindings: SandboxBindings,
  op: RpcOp,
  rawArgs: unknown,
): Promise<unknown> => {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (op === "fetch") {
    const url = String(args.url ?? "");
    const init = args.init as RequestInit | undefined;
    const allowlist = (bindings.ctx.env.FUNCTIONS_FETCH_ALLOW ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!isAllowedFetch(url, allowlist)) {
      throw new Error(`URL not in fetch allow-list: ${url}`);
    }
    // Continue the trace on outbound calls — unless the function set its own
    // traceparent. Lets a function's HTTP hop (or a callback into this API)
    // stitch into the same trace as the request that invoked it.
    const fetchInit: RequestInit = { ...(init ?? {}) };
    if (bindings.traceparent) {
      const h = new Headers(fetchInit.headers);
      if (!h.has("traceparent")) h.set("traceparent", bindings.traceparent);
      fetchInit.headers = h;
    }
    // Route through the SSRF guard: when enabled (managed cloud /
    // BLOCK_PRIVATE_FETCH_HOSTS) this follows redirects MANUALLY and re-checks
    // the host on every hop, so an allow-listed external host can't 30x-redirect
    // into localhost / RFC1918. On self-host (guard off) it still walks the
    // chain and refuses the cloud metadata endpoints at every hop, which is the
    // one refusal that is not the operator's to configure away. The host
    // allow-list above still bounds the initial target, and now the scheme too.
    const res = await fetchOutbound(bindings.ctx.env, url, fetchInit);
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  }

  if (op === "db.list") {
    const slug = String(args.slug ?? "");
    const query = (args.query ?? {}) as {
      filter?: Condition;
      sort?: string;
      limit?: number;
      offset?: number;
    };
    const collection = await loadCollection(bindings.ctx, bindings.auth.tenantId, slug);
    if (!collection) throw new Error(`Collection "${slug}" not found`);
    const perm = await resolvePermission(
      bindings.ctx,
      bindings.auth,
      slug,
      "read",
    );
    if (!perm.allowed) throw new Error(`No read permission on "${slug}"`);
    const table = collection.physicalTable;
    const userWhere = query.filter
      ? compileCondition(query.filter, bindings.auth)
      : null;
    const wheres = [userWhere, perm.whereSql].filter(
      (x): x is SQL => x != null,
    );
    const whereClause = wheres.length
      ? sql`WHERE ${sql.join(wheres, sql` AND `)}`
      : sql``;
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const rows = await queryAll<Record<string, unknown>>(
      bindings.ctx,
      sql`SELECT * FROM ${sql.identifier(table)} ${whereClause} LIMIT ${limit} OFFSET ${offset}`,
    );
    return rows.map((r) =>
      renderRow(
        r,
        collection.fields,
        bindings.ctx.dialect,
        !!collection.ownerScoped,
      ),
    );
  }

  if (op === "db.one") {
    const slug = String(args.slug ?? "");
    const id = String(args.id ?? "");
    const collection = await loadCollection(bindings.ctx, bindings.auth.tenantId, slug);
    if (!collection) throw new Error(`Collection "${slug}" not found`);
    const perm = await resolvePermission(
      bindings.ctx,
      bindings.auth,
      slug,
      "read",
    );
    if (!perm.allowed) throw new Error(`No read permission on "${slug}"`);
    const table = collection.physicalTable;
    const wheres: SQL[] = [sql`${sql.identifier("id")} = ${id}`];
    if (perm.whereSql) wheres.push(perm.whereSql);
    const rows = await queryAll<Record<string, unknown>>(
      bindings.ctx,
      sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`,
    );
    if (!rows[0]) return null;
    return renderRow(
      rows[0],
      collection.fields,
      bindings.ctx.dialect,
      !!collection.ownerScoped,
    );
  }

  if (op === "email.send") {
    // Same clamp `ai.generate` has carried since it shipped, and for the same
    // reason: a workspace-less subject must not fall through to the
    // DEPLOYMENT's transport. `emailFor(null)` resolves the operator's own
    // configured sender, so without this an invocation that named no workspace
    // sent mail from the instance itself — arbitrary content, over the
    // operator's verified domain and reputation.
    const tenantId = requireWorkspace(bindings, "ctx.email.send");
    const transport = await bindings.ctx.emailFor(tenantId);
    await transport.send(
      args as { to: string; subject: string; text: string; html?: string },
    );
    return true;
  }

  if (op === "push.send") {
    const a = args as {
      userId?: string;
      userIds?: string[];
      title: string;
      body: string;
      url?: string;
      data?: Record<string, string>;
    };
    const tenantId = requireWorkspace(bindings, "ctx.push.send");
    const userIds = a.userIds ?? (a.userId ? [a.userId] : []);
    return sendPushToUsers(bindings.ctx, tenantId, {
      userIds,
      title: a.title,
      body: a.body,
      url: a.url,
      data: a.data,
    });
  }

  if (op === "ai.generate") {
    // Nothing validates `args` anywhere on this path — `RpcRequest.args` is
    // `unknown`, the callback route's zod says `z.unknown()`, and the dispatcher
    // does one blanket cast. The guest shim's TypeScript signature is not a
    // check; user code never sees it. So every field is read defensively here,
    // and the two numeric bounds are applied rather than forwarded.
    const a = (args ?? {}) as {
      prompt?: unknown;
      system?: unknown;
      model?: unknown;
      maxTokens?: unknown;
      timeoutMs?: unknown;
    };
    const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
    if (!prompt) throw new Error("ctx.ai.generate needs a non-empty prompt");

    // Fail closed exactly like the db ops do on this bridge: "no workspace"
    // must never fall back to the deployment's own key. This was the only op
    // that did it; `email.send` and `push.send` now share the helper.
    const tenantId = requireWorkspace(bindings, "ctx.ai.generate");
    // The workspace's Settings · AI key, overlaid onto the deployment env. Using
    // `bindings.ctx.env` directly would bill the operator for a tenant that
    // brought its own key, and ignore the model that tenant chose.
    const runtime = await resolveAiRuntime(bindings.ctx, tenantId);
    // "Can this deployment generate at all", not "whose key pays" — the second
    // question is false on every managed-cloud project, where generation needs
    // no setup at all.
    if (!aiAvailable(runtime.env)) {
      throw new Error(
        "ctx.ai.generate: no AI provider is configured — set a key under Settings · AI, or run on managed cloud where generation is included",
      );
    }
    // Same reason as the flow ops: a cron- or event-triggered function
    // generates with nobody watching, so the budget is checked before the
    // spend rather than reported after it.
    await assertAiQuota(bindings.ctx, bindings.ctx.env, tenantId);

    const clamp = (v: unknown, fallback: number, max: number): number =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : fallback;
    // The function's own `timeoutMs` bounds the GUEST, not this host call: a
    // bun-worker timeout terminates the worker thread and leaves the promise
    // here running. So the generation carries its own deadline, the same one
    // the AI flow ops use.
    const controller = new AbortController();
    let timedOut = false;
    const ms = clamp(a.timeoutMs, AI_OP_DEFAULT_TIMEOUT_MS, AI_OP_MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    try {
      const reply = await callClaude(
        runtime.env,
        {
          user: prompt,
          ...(typeof a.system === "string" && a.system.trim() ? { system: a.system.trim() } : {}),
          ...(typeof a.model === "string" && a.model.trim()
            ? { model: a.model.trim() }
            : runtime.model
              ? { model: runtime.model }
              : {}),
          maxTokens: clamp(a.maxTokens, AI_OP_DEFAULT_MAX_TOKENS, AI_OP_MAX_TOKENS),
          signal: controller.signal,
        },
        aiMeterForTenant(bindings.ctx, tenantId),
      );
      // A plain serializable object: this crosses the boundary as JSON on the
      // remote executor and as a structured clone on bun. `usage` is passed
      // through unchanged — tokens on a direct key, neurons on the managed
      // gateway, and absent when the provider reported nothing.
      return reply.usage ? { text: reply.text, usage: reply.usage } : { text: reply.text };
    } catch (e) {
      // An AppError's code does not survive this boundary — the guest receives
      // `new Error(message)` — so the message has to be actionable on its own.
      if (timedOut) throw new Error(`ctx.ai.generate: the model did not answer within ${ms}ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`unknown rpc op: ${op}`);
};
