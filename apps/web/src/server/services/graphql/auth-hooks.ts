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
  AUTH_HOOK_EVENTS,
  MAX_AUTH_HOOK_TIMEOUT_MS,
  createAuthHook,
  deleteAuthHook,
  isAuthHookEvent,
  listAuthHooks,
  testAuthHook,
  updateAuthHook,
  type OnAuthHookError,
} from "../auth-hooks";
import { recordActivity } from "../activity";

// ── Auth hooks ───────────────────────────────────────────────────────────────
// Admin-scoped mirror of REST `/api/admin/auth-hooks`. Everything funnels
// through services/auth-hooks.ts, so the tenant scoping, the write-only secret,
// the one-hook-per-event rule and the url/function target check are shared
// rather than restated — restating a guard per surface is how one of them ends
// up missing.

const HookType = new GraphQLObjectType({
  name: "AuthHook",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    event: { type: new GraphQLNonNull(GraphQLString) },
    targetType: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: GraphQLString },
    functionName: { type: GraphQLString },
    headers: { type: JSONScalar },
    timeoutMs: { type: new GraphQLNonNull(GraphQLInt) },
    onError: { type: new GraphQLNonNull(GraphQLString) },
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
  name: "AuthHookInput",
  fields: {
    event: { type: GraphQLString },
    targetType: { type: GraphQLString },
    url: { type: GraphQLString },
    functionName: { type: GraphQLString },
    // Not defaulted, mirroring REST: neither answer is safe to assume.
    onError: { type: GraphQLString },
    secret: { type: GraphQLString },
    headers: { type: JSONScalar },
    timeoutMs: { type: GraphQLInt },
    enabled: { type: GraphQLBoolean },
  },
});

const TestResultType = new GraphQLObjectType({
  name: "AuthHookTestResult",
  fields: {
    ok: { type: new GraphQLNonNull(GraphQLBoolean) },
    ms: { type: new GraphQLNonNull(GraphQLInt) },
    error: { type: GraphQLString },
    droppedClaims: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
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
 *  type, because GraphQL cannot express "one of these strings" without an enum
 *  and an enum would silently rename the values on the wire. */
const validate = (
  data: Record<string, unknown>,
  { partial }: { partial: boolean },
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (data.event !== undefined || !partial) {
    if (!isAuthHookEvent(data.event)) {
      invalid(`event must be one of: ${AUTH_HOOK_EVENTS.join(", ")}`);
    }
    out.event = data.event;
  }
  if (data.targetType !== undefined || !partial) {
    if (data.targetType !== "url" && data.targetType !== "function") {
      invalid('targetType must be "url" or "function"');
    }
    out.targetType = data.targetType;
  }
  if (data.url !== undefined) {
    if (typeof data.url !== "string" || !data.url.trim()) invalid("url must be a non-empty string");
    try {
      new URL((data.url as string).trim());
    } catch {
      invalid("url must be a valid URL");
    }
    out.url = (data.url as string).trim();
  }
  if (data.functionName !== undefined) {
    if (typeof data.functionName !== "string" || !data.functionName.trim()) {
      invalid("functionName must be a non-empty string");
    }
    out.functionName = (data.functionName as string).trim();
  }
  if (data.onError !== undefined || !partial) {
    if (data.onError !== "allow" && data.onError !== "deny") {
      invalid('onError must be "allow" or "deny" — there is no safe default');
    }
    out.onError = data.onError as OnAuthHookError;
  }
  if (data.timeoutMs !== undefined) {
    const n = Number(data.timeoutMs);
    // Refused rather than clamped: clamping would let a caller believe they
    // got a longer budget than they did.
    if (!Number.isFinite(n) || n < 50 || n > MAX_AUTH_HOOK_TIMEOUT_MS) {
      invalid(`timeoutMs must be 50..${MAX_AUTH_HOOK_TIMEOUT_MS}`);
    }
    out.timeoutMs = n;
  }
  for (const k of ["secret", "headers", "enabled"] as const) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  return out;
};

export const authHookQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  authHooks: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(HookType))),
    description:
      "List this workspace's end-user auth hooks, signing secrets excluded (admin-only).",
    resolve: (_s, _a, gqlCtx) =>
      surfacing(async () => listAuthHooks(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
};

export const authHookMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createAuthHook: {
    type: new GraphQLNonNull(HookType),
    description:
      "Create an auth hook (admin-only). Fires for this workspace's END-USER auth plane only — " +
      "never for the platform operators who administer backlex itself.",
    args: { data: { type: new GraphQLNonNull(HookInputType) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const input = validate((args as { data: Record<string, unknown> }).data, { partial: false });
        const created = await createAuthHook(gqlCtx.ctx, tenantId, input as never);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_auth_hooks",
          itemId: created.id,
          payload: { event: created.event, onError: created.onError },
        });
        return created;
      }),
  },
  updateAuthHook: {
    type: new GraphQLNonNull(HookType),
    description: "Update an auth hook (admin-only). Omit `secret` to keep the stored one.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(HookInputType) },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { id: string; data: Record<string, unknown> };
        const patch = validate(a.data, { partial: true });
        const updated = await updateAuthHook(gqlCtx.ctx, tenantId, a.id, patch as never);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_auth_hooks",
          itemId: a.id,
        });
        return updated;
      }),
  },
  deleteAuthHook: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Delete an auth hook (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const { id } = args as { id: string };
        await deleteAuthHook(gqlCtx.ctx, tenantId, id);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "delete",
          collection: "system_auth_hooks",
          itemId: id,
        });
        return { ok: true };
      }),
  },
  testAuthHook: {
    type: new GraphQLNonNull(TestResultType),
    description:
      "Fire one representative call for this hook's event and report the verdict (admin-only). " +
      "Does not touch the failure counter.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () =>
        testAuthHook(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id),
      ),
  },
};
