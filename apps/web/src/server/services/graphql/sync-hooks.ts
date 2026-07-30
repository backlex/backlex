import { AppError } from "@backlex/core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  createSyncHook,
  deleteSyncHook,
  listSyncHooks,
  testSyncHook,
  updateSyncHook,
  type OnHookError,
} from "../sync-hooks";
import { recordActivity } from "../activity";

// ── Sync hooks ───────────────────────────────────────────────────────────────
// Admin-scoped mirror of REST `/api/admin/sync-hooks`. Everything funnels
// through services/sync-hooks.ts, so the tenant scoping, the write-only secret
// and the "instance-wide is unrepresentable" rule are shared rather than
// restated — restating a guard per surface is how one of them ends up missing.

const HookType = new GraphQLObjectType({
  name: "SyncHook",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
    events: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    headers: { type: JSONScalar },
    timeoutMs: { type: new GraphQLNonNull(GraphQLInt) },
    onError: { type: new GraphQLNonNull(GraphQLString) },
    canMutate: { type: new GraphQLNonNull(GraphQLBoolean) },
    priority: { type: new GraphQLNonNull(GraphQLInt) },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
    /** Presence only — the signing secret has no read-back path. */
    hasSecret: { type: new GraphQLNonNull(GraphQLBoolean) },
    consecutiveFailures: { type: new GraphQLNonNull(GraphQLInt) },
    lastFailureAt: { type: JSONScalar },
    disabledReason: { type: GraphQLString },
    createdAt: { type: JSONScalar },
    updatedAt: { type: JSONScalar },
  },
});

const HookInputType = new GraphQLInputObjectType({
  name: "SyncHookInput",
  fields: {
    name: { type: GraphQLString },
    url: { type: GraphQLString },
    events: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    // Not defaulted, mirroring REST: neither answer is safe to assume.
    onError: { type: GraphQLString },
    secret: { type: GraphQLString },
    headers: { type: JSONScalar },
    timeoutMs: { type: GraphQLInt },
    canMutate: { type: GraphQLBoolean },
    priority: { type: GraphQLInt },
    enabled: { type: GraphQLBoolean },
  },
});

const TestResultType = new GraphQLObjectType({
  name: "SyncHookTestResult",
  fields: {
    ok: { type: new GraphQLNonNull(GraphQLBoolean) },
    ms: { type: new GraphQLNonNull(GraphQLInt) },
    error: { type: GraphQLString },
    verdict: { type: JSONScalar },
  },
});

/** yoga masks non-GraphQLError throws — surface AppErrors with their code. */
const surfacing = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

const invalid = (message: string): never => {
  throw new GraphQLError(message, { extensions: { code: "VALIDATION" } });
};

/** Mirror the REST zod contract. Kept here rather than trusted from the input
 *  type, because GraphQL cannot express "one of two strings" without an enum
 *  and an enum would silently rename the values on the wire. */
const validate = (
  data: Record<string, unknown>,
  { partial }: { partial: boolean },
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const req = (k: string) => {
    const v = data[k];
    if (typeof v !== "string" || !v.trim()) invalid(`${k} is required`);
    out[k] = (v as string).trim();
  };
  if (data.name !== undefined || !partial) req("name");
  if (data.url !== undefined || !partial) {
    req("url");
    try {
      new URL(out.url as string);
    } catch {
      invalid("url must be a valid URL");
    }
  }
  if (data.events !== undefined || !partial) {
    const events = data.events as unknown[];
    if (!Array.isArray(events) || events.length === 0) {
      invalid("events must be a non-empty list of patterns");
    }
    out.events = events;
  }
  if (data.onError !== undefined || !partial) {
    if (data.onError !== "allow" && data.onError !== "deny") {
      invalid('onError must be "allow" or "deny" — there is no safe default');
    }
    out.onError = data.onError as OnHookError;
  }
  if (data.timeoutMs !== undefined) {
    const n = Number(data.timeoutMs);
    // Refused rather than clamped: clamping would let a caller believe they
    // got a longer budget than they did.
    if (!Number.isFinite(n) || n < 50 || n > 10_000) invalid("timeoutMs must be 50..10000");
    out.timeoutMs = n;
  }
  for (const k of ["secret", "headers", "canMutate", "priority", "enabled"] as const) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  return out;
};

export const syncHookQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  syncHooks: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(HookType))),
    description: "List sync hooks in the active workspace, signing secrets excluded (admin-only).",
    resolve: (_s, _a, gqlCtx) =>
      surfacing(async () => listSyncHooks(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
};

export const syncHookMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createSyncHook: {
    type: new GraphQLNonNull(HookType),
    description:
      "Create a sync hook (admin-only). Scoped to the active workspace — an instance-wide hook " +
      "cannot be created through any API surface.",
    args: { data: { type: new GraphQLNonNull(HookInputType) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const input = validate((args as { data: Record<string, unknown> }).data, { partial: false });
        const created = await createSyncHook(gqlCtx.ctx, tenantId, input as never);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_sync_hooks",
          itemId: created.id,
          payload: { name: created.name, onError: created.onError },
        });
        return created;
      }),
  },
  updateSyncHook: {
    type: new GraphQLNonNull(HookType),
    description: "Update a sync hook (admin-only). Omit `secret` to keep the stored one.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(HookInputType) },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { id: string; data: Record<string, unknown> };
        const patch = validate(a.data, { partial: true });
        const updated = await updateSyncHook(gqlCtx.ctx, tenantId, a.id, patch as never);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_sync_hooks",
          itemId: a.id,
        });
        return updated;
      }),
  },
  deleteSyncHook: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Delete a sync hook (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const { id } = args as { id: string };
        await deleteSyncHook(gqlCtx.ctx, tenantId, id);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "delete",
          collection: "system_sync_hooks",
          itemId: id,
        });
        return { ok: true };
      }),
  },
  testSyncHook: {
    type: new GraphQLNonNull(TestResultType),
    description:
      "Fire one synthetic call and report the verdict (admin-only). Does not touch the failure counter.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () =>
        testSyncHook(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id),
      ),
  },
};
