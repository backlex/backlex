/**
 * Tool-level audit for the MCP surface.
 *
 * Every `tools/call` fans out into an internal sub-fetch, so the *underlying*
 * REST route may log its own `item.create` row — but nothing recorded which
 * TOOL an agent reached for, whether a guard refused it, or how long it took.
 * That's the trail an operator actually needs when an agent misbehaves: the
 * REST rows tell you a row was written, not that `collections.insert` was
 * called by a specific key through a specific mount.
 *
 * Rows land in the same `activity` table as everything else, under a dedicated
 * `mcp.` namespace so the admin Logs page can chip-filter them and the daily
 * cron can prune them on their own (shorter) clock:
 *
 *   - `mcp.call`     — a tool ran and returned a result
 *   - `mcp.error`    — a tool ran and reported an error (or threw)
 *   - `mcp.denied`   — a guard refused the call before the tool ran
 *   - `mcp.resource` — a `resources/read` served workspace data
 *
 * Volume is the reason for {@link resolveAuditLevel}: an agent loop can burn
 * the full 120 req/min budget on reads, and a read that returned nothing
 * interesting is rarely worth a row. Denials and errors are ALWAYS recorded
 * regardless of level — those are the security-relevant events, and they're
 * rare by construction.
 */
import type { Env } from "../env";
import { keepAlive, recordActivity, requestMeta } from "../services/activity";
import type { ToolKind } from "./kind";
import type { McpMode } from "./types";

/** How much of the MCP surface gets an audit row.
 *  - `all`    — every call and every resource read
 *  - `writes` — write/destruct calls only (plus errors + denials); the default
 *  - `off`    — nothing except denials, which stay on as a security floor */
export type McpAuditLevel = "all" | "writes" | "off";

export const DEFAULT_MCP_AUDIT_LEVEL: McpAuditLevel = "writes";

export const resolveAuditLevel = (env: Env): McpAuditLevel => {
  const raw = (env.MCP_AUDIT_LEVEL ?? "").trim().toLowerCase();
  if (raw === "all" || raw === "writes" || raw === "off") return raw;
  return DEFAULT_MCP_AUDIT_LEVEL;
};

export type McpAuditOutcome = "ok" | "error" | "denied";

export interface McpAuditEntry {
  /** Canonical dotted tool id (never the hyphenated wire name) — the admin
   *  filter, the per-key allowlist, and this row all key on the same string.
   *  For a resource read it's the `backlex://…` URI instead. */
  tool: string;
  kind: ToolKind;
  mode: McpMode;
  outcome: McpAuditOutcome;
  durationMs: number;
  args?: Record<string, unknown>;
  /** Guard rejection reason, or the tool's error text. */
  error?: string;
  /** Which MCP surface produced the row — `tool` for `tools/call`, `resource`
   *  for `resources/read`. Drives the `mcp.call` vs `mcp.resource` action. */
  surface?: "tool" | "resource";
}

/** Whether an entry earns a row at the active level. Denials and errors are
 *  unconditional — an audit that drops the refusals is worse than none. */
export const shouldAudit = (
  level: McpAuditLevel,
  outcome: McpAuditOutcome,
  kind: ToolKind,
): boolean => {
  if (outcome !== "ok") return true;
  if (level === "off") return false;
  if (level === "all") return true;
  return kind !== "read";
};

const MAX_STRING = 512;
const MAX_ARRAY = 20;
const MAX_DEPTH = 6;
/** Hard ceiling on the serialized argument blob. Past this the payload is
 *  replaced wholesale — a 5 MB `collections.bulk_insert` must not be copied
 *  into the audit log just because someone called it through MCP. */
const MAX_ARGS_BYTES = 8_192;

/** Shrink a tool's arguments into something an audit row can carry: long
 *  strings clipped, long arrays cut with a count marker, deep nesting stopped.
 *  Secret-looking keys are NOT handled here — `recordActivity` redacts those on
 *  write, so the redactor stays in one place. */
const shrink = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string")
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)`
      : value;
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => shrink(v, depth + 1));
    return value.length > MAX_ARRAY
      ? [...head, `… ${value.length - MAX_ARRAY} more`]
      : head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = shrink(v, depth + 1);
  }
  return out;
};

export const summariseArgs = (
  args: Record<string, unknown> | undefined,
): unknown => {
  if (!args) return null;
  const shrunk = shrink(args);
  try {
    const json = JSON.stringify(shrunk);
    if (json && json.length > MAX_ARGS_BYTES) {
      return { _truncated: true, bytes: json.length, keys: Object.keys(args) };
    }
  } catch {
    // Circular / non-serializable arguments can't come off the JSON-RPC wire,
    // but a tool could hand us anything — degrade to the key list.
    return { _unserializable: true, keys: Object.keys(args) };
  }
  return shrunk;
};

/** Minimal shape the audit needs off the Hono context. Kept structural so the
 *  dispatcher can pass its narrowly-typed context without a cast dance. */
interface AuditHost {
  get: (key: string) => unknown;
  req: { raw: Request };
  executionCtx?: { waitUntil?: (p: Promise<unknown>) => void };
}

/**
 * Record one MCP audit row. Fire-and-forget: registered with `waitUntil` where
 * the runtime exposes it, and never allowed to fail a tool call — an audit that
 * can break the request it audits is a liability.
 */
export const auditMcp = (
  c: AuditHost,
  env: Env,
  entry: McpAuditEntry,
): void => {
  if (!shouldAudit(resolveAuditLevel(env), entry.outcome, entry.kind)) return;
  let dbCtx: { db: unknown; dialect: "pg" | "sqlite" } | undefined;
  let auth: { userId?: string | null; tenantId?: string | null; apiKeyId?: string | null } | undefined;
  try {
    dbCtx = c.get("ctx") as typeof dbCtx;
    auth = c.get("auth") as typeof auth;
  } catch {
    return;
  }
  if (!dbCtx?.db) return;

  const action =
    entry.outcome === "denied"
      ? "mcp.denied"
      : entry.outcome === "error"
        ? "mcp.error"
        : entry.surface === "resource"
          ? "mcp.resource"
          : "mcp.call";

  const p = recordActivity(
    { db: dbCtx.db as never, dialect: dbCtx.dialect },
    {
      userId: auth?.userId ?? null,
      tenantId: auth?.tenantId ?? null,
      action,
      // A synthetic collection so the row groups with the other system
      // surfaces in the admin filter without colliding with a user slug.
      collection: "system_mcp",
      itemId: entry.tool,
      ...requestMeta(c.req.raw),
      payload: {
        tool: entry.tool,
        kind: entry.kind,
        mount: entry.mode,
        // Deliberately NOT named `apiKeyId`: the shared redactor matches
        // /api[-_]?key/i and would blank it out. A key *id* is not a secret —
        // it's the attribution that makes the row useful — so the field is
        // named around the redactor rather than the redactor loosened for it.
        viaKeyId: auth?.apiKeyId ?? null,
        args: summariseArgs(entry.args),
      },
      response: {
        outcome: entry.outcome,
        ...(entry.error ? { error: entry.error } : {}),
      },
      durationMs: entry.durationMs,
    },
  );
  keepAlive(c, p);
};

/** `resources/read` audit — the other path by which MCP hands workspace data
 *  to an agent. Recorded under the same namespace with the URI as the item so a
 *  "who read what" query is one filter, not two. */
export const auditMcpResource = (
  c: AuditHost,
  env: Env,
  input: { uri: string; mode: McpMode; durationMs: number; error?: string },
): void => {
  auditMcp(c, env, {
    tool: input.uri,
    kind: "read",
    mode: input.mode,
    outcome: input.error ? "error" : "ok",
    durationMs: input.durationMs,
    error: input.error,
    surface: "resource",
  });
};
