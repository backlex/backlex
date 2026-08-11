import { AppError } from "@backlex/core";
import { INTEGRATION_CATALOG, isIntegrationKind } from "@backlex/integrations";
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
import { beginOAuth } from "../integrations-oauth";
import {
  createSync,
  deleteSync,
  listSyncs,
  runSync,
  updateSync,
  type CreateSyncInput,
} from "../integration-syncs";
import { listTaskRuns, runTask } from "../integration-tasks";
import {
  disableWebhook,
  enableWebhook,
  listDeliveries,
  updateWebhookEvents,
} from "../integration-webhooks";
import {
  connectIntegration,
  disconnectIntegration,
  listIntegrationDeliveries,
  listIntegrations,
  resumeIntegration,
} from "../integrations";
import { recordActivity } from "../activity";

// ── Third-party integrations ─────────────────────────────────────────────────
// Admin-scoped surface mirroring REST `/api/admin/integrations`. Every call
// funnels through services/integrations.ts, so the tenant guards, the
// encryption-at-rest of secret config, and the circuit breaker are shared
// rather than re-implemented here — re-writing a guard per surface is exactly
// how one of them ends up missing it.

const IntegrationType = new GraphQLObjectType({
  name: "Integration",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    kind: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    events: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    /** Secret fields arrive masked — the service never returns plaintext. */
    config: { type: JSONScalar },
    lastEventAt: { type: JSONScalar },
    createdAt: { type: JSONScalar },
    consecutiveFailures: { type: GraphQLInt },
    lastFailureAt: { type: JSONScalar },
    disabledReason: { type: GraphQLString },
  },
});

const IntegrationDeliveryType = new GraphQLObjectType({
  name: "IntegrationDelivery",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    integrationId: { type: new GraphQLNonNull(GraphQLString) },
    event: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(GraphQLInt) },
    ms: { type: new GraphQLNonNull(GraphQLInt) },
    error: { type: GraphQLString },
    attempts: { type: new GraphQLNonNull(GraphQLInt) },
    deliveredAt: { type: JSONScalar },
  },
});

const IntegrationProviderType = new GraphQLObjectType({
  name: "IntegrationProvider",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    category: { type: new GraphQLNonNull(GraphQLString) },
    capabilities: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    fields: { type: JSONScalar },
    /** Connected by redirect rather than by pasting a key — see `startIntegrationOAuth`. */
    oauth: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const SyncType = new GraphQLObjectType({
  name: "IntegrationSync",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    integrationId: { type: new GraphQLNonNull(GraphQLString) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    /** Which way the rows travel: `pull` in, `push` out, `inbound` received. */
    direction: { type: new GraphQLNonNull(GraphQLString) },
    settings: { type: JSONScalar },
    mapping: { type: JSONScalar },
    /** Pull only: where a record's child rows land, keyed by provider group. */
    childMappings: { type: JSONScalar },
    intervalMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
    /** Whether more pages are pending — never the provider's resume token. */
    resuming: { type: new GraphQLNonNull(GraphQLBoolean) },
    lastRunAt: { type: JSONScalar },
    lastRowCount: { type: new GraphQLNonNull(GraphQLInt) },
    lastError: { type: GraphQLString },
    consecutiveFailures: { type: new GraphQLNonNull(GraphQLInt) },
    disabledReason: { type: GraphQLString },
    /** The collection field a patching delivery is matched on, if any. */
    matchField: { type: GraphQLString },
    /** `{ path, events, registered }`, or null when this sync receives nothing.
     *  Never the secret — that is returned once, by `enableIntegrationWebhook`. */
    webhook: { type: JSONScalar },
    createdAt: { type: JSONScalar },
  },
});

const WebhookEndpointType = new GraphQLObjectType({
  name: "IntegrationWebhookEndpoint",
  fields: {
    /** Give this to the provider. */
    url: { type: new GraphQLNonNull(GraphQLString) },
    /** Present ONLY here, on the call that minted it. Lost means rotate. */
    secret: { type: GraphQLString },
    events: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    registered: { type: new GraphQLNonNull(GraphQLBoolean) },
    /** The endpoint is live and the provider was not told. */
    registrationError: { type: GraphQLString },
  },
});

const InboundDeliveryType = new GraphQLObjectType({
  name: "IntegrationInboundDelivery",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    syncId: { type: new GraphQLNonNull(GraphQLString) },
    event: { type: new GraphQLNonNull(GraphQLString) },
    /** `applied` | `unmatched` | `filtered` | `ignored` | `duplicate` | `rejected` | `failed`. */
    status: { type: new GraphQLNonNull(GraphQLString) },
    rowsWritten: { type: new GraphQLNonNull(GraphQLInt) },
    error: { type: GraphQLString },
    createdAt: { type: JSONScalar },
  },
});

const SyncInputType = new GraphQLInputObjectType({
  name: "IntegrationSyncInput",
  fields: {
    integrationId: { type: GraphQLString },
    collection: { type: GraphQLString },
    /** `pull` (default) brings rows in; `push` mirrors the collection out;
     *  `inbound` has nothing to poll and receives the provider's deliveries. */
    direction: { type: GraphQLString },
    /** The collection field a patching delivery is matched on. Required for a
     *  provider whose webhook updates rows it did not create. */
    matchField: { type: GraphQLString },
    settings: { type: JSONScalar },
    mapping: { type: JSONScalar },
    /** Pull only: `{ group: { collection, parentField, mapping } }`. */
    childMappings: { type: JSONScalar },
    intervalMinutes: { type: GraphQLInt },
    enabled: { type: GraphQLBoolean },
  },
});

const TaskRunResultType = new GraphQLObjectType({
  name: "IntegrationTaskRunResult",
  fields: {
    /** `skipped` means a previous run's answer, not a fresh call. */
    status: { type: new GraphQLNonNull(GraphQLString) },
    outputs: { type: JSONScalar },
    /** Storage key of the file the task produced, if it produced one. */
    artifactKey: { type: GraphQLString },
    reused: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const TaskRunType = new GraphQLObjectType({
  name: "IntegrationTaskRunRecord",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    integrationId: { type: new GraphQLNonNull(GraphQLString) },
    task: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    outputs: { type: JSONScalar },
    artifactKey: { type: GraphQLString },
    error: { type: GraphQLString },
    attempts: { type: new GraphQLNonNull(GraphQLInt) },
    updatedAt: { type: JSONScalar },
  },
});

const SyncRunType = new GraphQLObjectType({
  name: "IntegrationSyncRun",
  fields: {
    written: { type: new GraphQLNonNull(GraphQLInt) },
    pages: { type: new GraphQLNonNull(GraphQLInt) },
    complete: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const OAuthStartType = new GraphQLObjectType({
  name: "IntegrationOAuthStart",
  fields: {
    /** Open this in a browser. Single-use, expires in 10 minutes. */
    url: { type: new GraphQLNonNull(GraphQLString) },
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

export const integrationQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  integrationCatalog: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(IntegrationProviderType))),
    description: "Available integration providers and their config fields (admin-only).",
    resolve: (_src, _args, gqlCtx) => {
      requireFlowAdmin(gqlCtx);
      return INTEGRATION_CATALOG;
    },
  },
  integrations: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(IntegrationType))),
    description: "List connected integrations in the active workspace, secrets masked (admin-only).",
    resolve: (_src, _args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        return listIntegrations(gqlCtx.ctx, tenantId);
      }),
  },
  integrationTaskRuns: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TaskRunType))),
    description: "What has already been done to one row, and what it produced (admin-only).",
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      itemId: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { collection: string; itemId: string };
        return listTaskRuns(gqlCtx.ctx, tenantId, a);
      }),
  },
  integrationSyncs: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SyncType))),
    description: "Scheduled pulls from source integrations into collections (admin-only).",
    args: { integrationId: { type: GraphQLString } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        return listSyncs(gqlCtx.ctx, tenantId, (args as { integrationId?: string }).integrationId);
      }),
  },
  integrationInboundDeliveries: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(InboundDeliveryType))),
    description:
      "What a provider delivered to one sync's endpoint, newest first (admin-only). An endpoint's whole " +
      "health story: `applied` wrote rows, `unmatched` found no row holding the id the delivery named, " +
      "`filtered` was an event this endpoint is not subscribed to, `ignored` was a ping, `duplicate` was a " +
      "retry of something already applied, `rejected` did not present the secret, and `failed` was ours.",
    args: { syncId: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        return listDeliveries(gqlCtx.ctx, tenantId, (args as { syncId: string }).syncId);
      }),
  },
  integrationDeliveries: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(IntegrationDeliveryType))),
    description: "Recent delivery attempts for one integration, newest first (admin-only).",
    args: {
      integrationId: { type: new GraphQLNonNull(GraphQLString) },
      limit: { type: GraphQLInt },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { integrationId: string; limit?: number | null };
        return listIntegrationDeliveries(gqlCtx.ctx, tenantId, a.integrationId, a.limit ?? 50);
      }),
  },
};

export const integrationMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  connectIntegration: {
    type: new GraphQLNonNull(IntegrationType),
    description: "Connect (or update) an integration; secret config is encrypted at rest (admin-only).",
    args: {
      kind: { type: new GraphQLNonNull(GraphQLString) },
      config: { type: JSONScalar },
      events: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { kind: string; config?: Record<string, unknown> | null; events?: string[] | null };
        if (!isIntegrationKind(a.kind)) invalid(`Unknown integration kind: ${a.kind}`);
        const data = await connectIntegration(
          gqlCtx.ctx,
          { tenantId, kind: a.kind, config: a.config ?? {}, events: a.events ?? null },
          gqlCtx.ctx.env.AUTH_SECRET,
        );
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_integrations",
          itemId: data.id,
          payload: { kind: a.kind },
        });
        return data;
      }),
  },
  disconnectIntegration: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Disconnect an integration and drop its delivery log (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const { id } = args as { id: string };
        await disconnectIntegration(gqlCtx.ctx, tenantId, id);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "delete",
          collection: "system_integrations",
          itemId: id,
        });
        return { ok: true };
      }),
  },
  resumeIntegration: {
    type: new GraphQLNonNull(IntegrationType),
    description: "Clear the failure counter and re-enable an auto-disabled integration (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const { id } = args as { id: string };
        const data = await resumeIntegration(gqlCtx.ctx, tenantId, id);
        if (!data) throw new AppError("NOT_FOUND", "Integration not found");
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_integrations",
          itemId: id,
          payload: { resumed: true },
        });
        return data;
      }),
  },
  createIntegrationSync: {
    type: new GraphQLNonNull(SyncType),
    description:
      "Create a scheduled sync between an integration and a collection (admin-only). `direction` is `pull` " +
      "(rows in, the default) or `push` (the collection mirrored out); the provider must declare that " +
      "capability. The collection must be managed, and a pull's mapping targets must be writable fields.",
    args: { data: { type: new GraphQLNonNull(SyncInputType) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const d = (args as { data: Record<string, unknown> }).data;
        if (typeof d.integrationId !== "string" || !d.integrationId) invalid("integrationId is required");
        if (typeof d.collection !== "string" || !d.collection) invalid("collection is required");
        const created = await createSync(gqlCtx.ctx, tenantId, {
          integrationId: d.integrationId as string,
          collection: d.collection as string,
          // Left undefined when absent so the service applies its own default
          // rather than this surface inventing a second one.
          direction: d.direction as "pull" | "push" | "inbound" | undefined,
          settings: (d.settings ?? {}) as Record<string, unknown>,
          mapping: (d.mapping ?? {}) as Record<string, string>,
          childMappings: d.childMappings as CreateSyncInput["childMappings"],
          intervalMinutes: d.intervalMinutes as number | undefined,
          enabled: d.enabled as boolean | undefined,
          // Type-guarded rather than cast: this surface hands the service raw
          // input, so a number here would reach a field-name check as a number.
          matchField: typeof d.matchField === "string" ? d.matchField : undefined,
        });
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_integration_syncs",
          itemId: created.id,
        });
        return created;
      }),
  },
  updateIntegrationSync: {
    type: new GraphQLNonNull(SyncType),
    description: "Patch a sync (admin-only). Changing `settings` resets the resume cursor.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(SyncInputType) },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { id: string; data: Record<string, unknown> };
        return updateSync(gqlCtx.ctx, tenantId, a.id, {
          settings: a.data.settings as Record<string, unknown> | undefined,
          mapping: a.data.mapping as Record<string, string> | undefined,
          childMappings: a.data.childMappings as CreateSyncInput["childMappings"],
          intervalMinutes: a.data.intervalMinutes as number | undefined,
          enabled: a.data.enabled as boolean | undefined,
          matchField: typeof a.data.matchField === "string" ? a.data.matchField : undefined,
        });
      }),
  },
  deleteIntegrationSync: {
    type: new GraphQLNonNull(JSONScalar),
    description: "Delete a sync (admin-only). Rows already pulled stay in the collection.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        await deleteSync(gqlCtx.ctx, tenantId, (args as { id: string }).id);
        return { ok: true };
      }),
  },
  runIntegrationSync: {
    type: new GraphQLNonNull(SyncRunType),
    description:
      "Run one sync now and report what landed (admin-only). Bounded to 20 pages / 2000 rows; a longer " +
      "import resumes on the schedule.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () =>
        runSync(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id),
      ),
  },
  enableIntegrationWebhook: {
    type: new GraphQLNonNull(WebhookEndpointType),
    description:
      "Turn on the endpoint a sync receives deliveries on, and register it at the provider where that is " +
      "possible (admin-only). The secret is returned ONCE and never again — it is a bearer credential a third " +
      "party also holds. Call this again to rotate it; the URL stays the same. A failed registration does not " +
      "roll the endpoint back: `registrationError` says what to retry.",
    args: {
      syncId: { type: new GraphQLNonNull(GraphQLString) },
      events: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { syncId: string; events?: unknown };
        // Guarded, not cast: GraphQL hands the service raw input, and a list
        // holding a number would reach the event check as a number.
        const events = Array.isArray(a.events)
          ? a.events.filter((e): e is string => typeof e === "string")
          : undefined;
        const data = await enableWebhook(gqlCtx.ctx, tenantId, a.syncId, { events });
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_integration_syncs",
          itemId: a.syncId,
          // The secret is deliberately not recorded. It travels to the caller
          // once; an activity row is the last place it should come to rest.
          payload: { webhook: "enabled", registered: data.registered },
        });
        return data;
      }),
  },
  updateIntegrationWebhookEvents: {
    type: new GraphQLNonNull(SyncType),
    description:
      "Change which events an endpoint accepts (admin-only). Empty means every event the provider declares. " +
      "Where the provider filters server-side this re-registers the endpoint, which rotates the secret.",
    args: {
      syncId: { type: new GraphQLNonNull(GraphQLString) },
      events: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { syncId: string; events: unknown };
        const events = Array.isArray(a.events)
          ? a.events.filter((e): e is string => typeof e === "string")
          : invalid("events must be a list of strings");
        return updateWebhookEvents(gqlCtx.ctx, tenantId, a.syncId, events);
      }),
  },
  disableIntegrationWebhook: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Tear an endpoint down (admin-only). The provider is asked to stop first, but cannot block it — " +
      "deliveries to the old URL then resolve to nothing.",
    args: { syncId: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        await disableWebhook(gqlCtx.ctx, tenantId, (args as { syncId: string }).syncId);
        return { ok: true };
      }),
  },
  runIntegrationTask: {
    type: new GraphQLNonNull(TaskRunResultType),
    description:
      "Run a task against one row (admin-only). Runs at most ONCE per row: a second call returns the " +
      "first run's outputs rather than acting again, because the effect at the provider costs money. " +
      "`force: true` deliberately re-runs one that succeeded.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      task: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(JSONScalar) },
    },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { id: string; task: string; data: Record<string, unknown> };
        const d = a.data ?? {};
        if (typeof d.collection !== "string" || !d.collection) invalid("collection is required");
        if (typeof d.itemId !== "string" || !d.itemId) invalid("itemId is required");
        return runTask(gqlCtx.ctx, tenantId, {
          integrationId: a.id,
          task: a.task,
          collection: d.collection as string,
          itemId: d.itemId as string,
          settings: d.settings as Record<string, unknown> | undefined,
          outputMapping: d.outputMapping as Record<string, string> | undefined,
          force: d.force as boolean | undefined,
        });
      }),
  },
  startIntegrationOAuth: {
    type: new GraphQLNonNull(OAuthStartType),
    description:
      "Begin an OAuth connect flow and return the provider URL to open (admin-only). Save the integration's " +
      "`clientId` and `clientSecret` first. The redirect lands back in the admin UI, so the browser that opens " +
      "the link must be signed in as the same admin — a link opened elsewhere is refused.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const userId = gqlCtx.auth.userId;
        // The flow is pinned to a person, so a token-authenticated caller with
        // no user behind it has nobody to pin it to.
        if (!userId) throw new AppError("FORBIDDEN", "A signed-in admin is required to start an OAuth flow");
        return beginOAuth(gqlCtx.ctx, { tenantId, userId, integrationId: (args as { id: string }).id });
      }),
  },
};
