import type { ClientCore } from "../core";

/**
 * Payment providers (admin-scoped). Mirrors `/api/admin/payments`.
 *
 * Connecting a provider provisions four collections — `payment_customers`,
 * `payment_subscriptions`, `payment_invoices`, `payments` — and everything the
 * provider pushes lands there, so you query billing data with the same
 * `client.from(...)` you use for the rest of the workspace.
 */
/** One connected third-party integration, secrets masked. */
export interface Integration {
  id: string;
  kind: string;
  status: string;
  events: string[] | null;
  config: Record<string, unknown>;
  lastEventAt?: number | string | null;
  createdAt?: number | string | null;
  consecutiveFailures?: number;
  lastFailureAt?: number | string | null;
  disabledReason?: string | null;
}

/** One delivery attempt against an integration. */
export interface IntegrationDelivery {
  id: string;
  integrationId: string;
  event: string;
  /** HTTP status; 0 when the provider was misconfigured or unreachable. */
  status: number;
  ms: number;
  error: string | null;
  attempts: number;
  deliveredAt: number | string;
}

/** A provider the instance can connect, and the config fields it needs. */
export interface IntegrationProvider {
  id: string;
  label: string;
  category: string;
  capabilities: string[];
  fields: {
    key: string;
    label: string;
    placeholder?: string;
    secret?: boolean;
    /** A closed set — the server refuses anything outside it. */
    options?: { value: string; label: string }[];
  }[];
  /** Connected by redirect rather than by pasting a key — use `oauthAuthorize`. */
  oauth: boolean;
}

/**
 * Where one group of a source record's children lands.
 *
 * A marketplace order is a header plus its lines, and a flat mapping can only
 * describe the header. `parentField` is the relation column on the child
 * collection pointing back at the header — filled from the parent's own id,
 * never from provider data.
 */
export interface IntegrationChildMapping {
  /** Managed collection the child rows land in (e.g. `order_items`). */
  collection: string;
  /** Relation column on the child collection pointing at the header. */
  parentField: string;
  /** External field name → child collection field name. */
  mapping: Record<string, string>;
}

/** A scheduled sync between an integration and a collection, either way. */
export interface IntegrationSync {
  id: string;
  integrationId: string;
  collection: string;
  /**
   * `pull` brings rows in; `push` mirrors the collection out; `inbound` has
   * nothing to poll and exists to receive the provider's webhook deliveries.
   *
   * A `pull` sync may ALSO have an endpoint — the normal case for a marketplace.
   * Both land through this sync's mapping and id namespace, which is what makes
   * a delivery about an order the poll already imported update that row instead
   * of creating a second one.
   */
  direction: "pull" | "push" | "inbound" | "listing";
  /** Which spreadsheet / base / database. Non-secret by contract. */
  settings: Record<string, unknown>;
  /** External field name → collection field name. */
  mapping: Record<string, string>;
  /** Pull only. Where child rows land, keyed by the provider's group name. */
  childMappings: Record<string, IntegrationChildMapping>;
  /** 0 = manual only. */
  intervalMinutes: number;
  enabled: boolean;
  /** A run is part-way through more pages. The token itself is not exposed. */
  resuming: boolean;
  lastRunAt: number | string | null;
  lastRowCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  /** The collection field a patching delivery is matched on, if any. */
  matchField: string | null;
  /** Listing only. The product column naming the local category. */
  categoryField: string | null;
  /** Listing only. Provider output key → the column a verdict is written to. */
  outputsMapping: Record<string, string>;
  /** The endpoint, described. Never the secret — that is returned once, by
   *  `enableWebhook`. Null when this sync receives nothing. */
  webhook: { path: string; events: string[]; registered: boolean } | null;
  createdAt: number | string | null;
}

/** What a provider that CALLS US needs a form to know. From the catalog. */
export interface IntegrationWebhookInfo {
  /** `hmac` signs the body; `header` and `basic` present the secret as-is. */
  auth: "hmac" | "header" | "basic";
  /** The header the secret or its signature arrives in. */
  header: string | null;
  events: { key: string; label: string }[];
  /** `upsert` — the delivery IS the record. `patch` — it is about a row you
   *  already have, found through the sync's `matchField`. */
  landing: "upsert" | "patch";
  /** What the match field holds, for a form to label. `patch` only. */
  matchLabel: string | null;
  /** We can register the endpoint at the provider — nothing to paste. */
  selfRegistering: boolean;
}

/** A live endpoint. `secret` is present ONLY on the call that minted it. */
export interface IntegrationWebhookEndpoint {
  url: string;
  secret: string | null;
  events: string[];
  registered: boolean;
  /** The endpoint is live and the provider was not told. Retry by enabling again. */
  registrationError?: string;
}

/** One delivery a provider made, and what became of it. */
export interface IntegrationInboundDelivery {
  id: string;
  syncId: string;
  event: string;
  /** `applied` | `unmatched` | `filtered` | `ignored` | `duplicate` | `rejected` | `failed`. */
  status: string;
  rowsWritten: number;
  error: string | null;
  createdAt: number | string | null;
}

export interface IntegrationSyncInput {
  integrationId: string;
  /** Managed collection slug. Adopted tables are refused. */
  collection: string;
  /**
   * Which way the rows travel. Defaults to `pull`.
   *
   * The provider has to declare the capability: a source-only provider cannot
   * be a `push` target and vice versa, and the mapping is read in the direction
   * of travel — external → field on a pull, field → external on a push.
   */
  direction?: "pull" | "push" | "inbound" | "listing";
  settings?: Record<string, unknown>;
  /** At least one entry; every target must be a writable field. */
  mapping: Record<string, string>;
  /**
   * Pull only. Where a record's CHILD rows land, keyed by the group name the
   * provider returns (`items` for an order's lines).
   *
   * Children are upserted, never reconciled — a line removed at the provider
   * stays in the collection, exactly as a deleted row does everywhere else.
   */
  childMappings?: Record<string, IntegrationChildMapping>;
  intervalMinutes?: number;
  enabled?: boolean;
  /**
   * The collection field a delivery is matched on.
   *
   * Required for a provider whose webhook updates rows it did not create — a
   * carrier's tracking events name a shipment id, and this says which column
   * holds it. Refused for a provider that sends whole records, where a record is
   * addressed by its namespaced id.
   */
  matchField?: string | null;
  /**
   * Listing only. The product column naming the local category.
   *
   * The mapping itself is one row per local value — see `mapListingCategory`.
   * This says which column those values are read from, because a workspace's
   * idea of a category is a column of its own choosing.
   */
  categoryField?: string | null;
  /**
   * Listing only, and read the OTHER way from `mapping`: provider output key →
   * the column a marketplace's verdict is written to. At least one entry, or a
   * batch would be published and every answer discarded.
   */
  outputsMapping?: Record<string, string>;
}

/** One node of a marketplace's category tree, flattened. */
export interface ListingCategory {
  id: string;
  name: string;
  parentId: string | null;
  /** A product may only be listed against a leaf. */
  leaf: boolean;
}

/** What one leaf category demands of a product. */
export interface ListingAttribute {
  id: string;
  name: string;
  /** The listing is refused without it. */
  required: boolean;
  /** Free text is accepted instead of, or as well as, a listed value. */
  allowCustom: boolean;
  /** Two products differing only here are one product with two variants. */
  variant: boolean;
  multiple: boolean;
  /** The closed set. Empty when the attribute is free text only. */
  values: { id: string; name: string }[];
}

/**
 * One answer to what a category demands. Exactly one of the three is set: a
 * value from the closed set, free text, or the product column to read it from —
 * the last being what makes a size or a colour describe every unit without an
 * operator typing each one.
 */
export interface ListingBinding {
  valueId?: string;
  custom?: string;
  field?: string;
}

/** How one of a workspace's categories maps onto a marketplace's. */
export interface ListingMap {
  id: string;
  syncId: string;
  localValue: string;
  categoryId: string;
  attributes: Record<string, ListingBinding>;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

/** One batch handed to a marketplace, and how much of it is still unanswered. */
export interface ListingBatch {
  id: string;
  batchId: string;
  /** `open` while anything is pending; then `settled` or `failed`. */
  status: string;
  unitCount: number;
  pendingCount: number;
  error: string | null;
  createdAt: number | string | null;
  resolvedAt: number | string | null;
}

/** What a publish did. A push reports rows written; a publish reports units. */
export interface ListingRunResult {
  sent: number;
  rejected: number;
  /** Products skipped because their local category is not mapped yet. */
  unmapped: number;
  batchId: string | null;
}

/** One thing a provider can be asked to do TO a row. */
export interface IntegrationTaskRunInput {
  /** Managed collection the row lives in. */
  collection: string;
  /** Primary key of the row to act on. */
  itemId: string;
  /** Per-invocation settings. Keys come from the task's declared fields. */
  settings?: Record<string, unknown>;
  /** Task output key → collection field. Undeclared outputs are refused. */
  outputMapping?: Record<string, string>;
  /**
   * Re-run a task that already succeeded.
   *
   * Off by default. A task has a real effect at the provider — booking a
   * shipment twice costs money — so a repeat is an explicit decision.
   */
  force?: boolean;
}

export interface IntegrationTaskRunResult {
  /** `skipped` means a previous run's answer came back instead of a new call. */
  status: "succeeded" | "skipped";
  outputs: Record<string, unknown>;
  /** Storage key of the file the task produced, if it produced one. */
  artifactKey: string | null;
  reused: boolean;
}

export interface IntegrationTaskRun {
  id: string;
  integrationId: string;
  task: string;
  status: string;
  outputs: Record<string, unknown>;
  artifactKey: string | null;
  error: string | null;
  attempts: number;
  updatedAt: number | string | null;
}

export interface IntegrationsClient {
  /** Providers available to connect, with their config field schema. */
  catalog: () => Promise<{
    data: {
      kinds: string[];
      providers: IntegrationProvider[];
      /** Register this exact URI with each OAuth provider. Server-derived, so
       *  it stays right behind a proxy where the browser's origin would not. */
      oauthRedirectUri: string;
      /** Per-kind endpoint description, for the providers that call us. A kind
       *  that is absent sends no webhooks. */
      webhooks: Record<string, IntegrationWebhookInfo>;
    };
  }>;
  /** Connected integrations in the active workspace (secrets masked). */
  list: () => Promise<{ data: Integration[] }>;
  /** Connect or reconfigure one provider. Secret config is encrypted at rest. */
  connect: (input: {
    kind: string;
    config?: Record<string, unknown>;
    events?: string[] | null;
  }) => Promise<{ data: Integration }>;
  /** Disconnect by id; the delivery log goes with it. */
  disconnect: (id: string) => Promise<{ ok: boolean }>;
  /** Recent delivery attempts, newest first. */
  deliveries: (id: string, opts?: { limit?: number }) => Promise<{ data: IntegrationDelivery[] }>;
  /** Clear the failure counter and re-enable a breaker-paused integration. */
  resume: (id: string) => Promise<{ data: Integration }>;
  /**
   * Begin an OAuth connect flow and get the provider URL to open.
   *
   * Save `clientId` + `clientSecret` via `connect` first. The returned link is
   * single-use, expires in 10 minutes, and only completes in a browser signed
   * in as the same admin — so this returns the URL rather than following it.
   */
  oauthAuthorize: (id: string) => Promise<{ data: { url: string } }>;
  /** Scheduled pulls, optionally filtered to one connection. */
  syncs: (opts?: { integrationId?: string }) => Promise<{ data: IntegrationSync[] }>;
  /** Create a scheduled pull into a collection. */
  createSync: (input: IntegrationSyncInput) => Promise<{ data: IntegrationSync }>;
  /**
   * Run a task against one row. Runs at most ONCE per row: a second call
   * returns the first run's outputs rather than acting again.
   */
  runTask: (
    integrationId: string,
    task: string,
    input: IntegrationTaskRunInput,
  ) => Promise<{ data: IntegrationTaskRunResult }>;
  /** What has already been done to one row, and what it produced. */
  taskRuns: (collection: string, itemId: string) => Promise<{ data: IntegrationTaskRun[] }>;
  /** Patch a sync. Changing `settings` resets the resume cursor. */
  updateSync: (
    id: string,
    patch: Partial<Omit<IntegrationSyncInput, "integrationId" | "collection">>,
  ) => Promise<{ data: IntegrationSync }>;
  deleteSync: (id: string) => Promise<{ ok: boolean }>;
  /**
   * Run one sync now and report what landed. Bounded to 20 pages / 2000 rows;
   * a longer import resumes on the schedule.
   */
  runSync: (
    id: string,
  ) => Promise<{ data: { written: number; pages: number; complete: boolean } | ListingRunResult }>;
  /**
   * The marketplace's category tree, flattened, with `parentId` and `leaf`.
   *
   * Keyed on the CONNECTION rather than a sync: this is what an operator browses
   * while deciding whether to make one, and for a provider whose catalog is
   * public it answers before a credential has been pasted.
   */
  listingCategories: (integrationId: string) => Promise<{ data: ListingCategory[] }>;
  /** What one leaf category demands, with its closed value sets. */
  listingAttributes: (
    integrationId: string,
    categoryId: string,
  ) => Promise<{ data: ListingAttribute[] }>;
  /** Search a registry the provider declares — a brand list is too large to browse. */
  listingLookup: (
    integrationId: string,
    input: { lookup: string; query?: string; cursor?: string | null },
  ) => Promise<{ data: { items: { id: string; name: string }[]; cursor: string | null } }>;
  /** How this sync's local categories are mapped. */
  listingMaps: (syncId: string) => Promise<{ data: ListingMap[] }>;
  /**
   * Map one local category, or re-map it.
   *
   * An upsert keyed on the local value, so two operators mapping the same
   * category converge on one row rather than racing.
   */
  mapListingCategory: (
    syncId: string,
    input: { localValue: string; categoryId: string; attributes?: Record<string, ListingBinding> },
  ) => Promise<{ data: ListingMap }>;
  /** Unmap one. Products in it are skipped by the next run, and it says how many. */
  unmapListingCategory: (syncId: string, mapId: string) => Promise<{ ok: boolean }>;
  /** What this sync published, newest first, and how much is still unanswered. */
  listingBatches: (syncId: string) => Promise<{ data: ListingBatch[] }>;
  /**
   * Turn on the endpoint this sync receives deliveries on, and register it at
   * the provider where that is possible.
   *
   * The secret comes back EXACTLY ONCE. It is a bearer credential a third party
   * also holds, so nothing hands it back on a later read — call this again to
   * rotate, which keeps the same URL. A failed registration does not roll the
   * endpoint back: the URL works, and `registrationError` says what to retry.
   */
  enableWebhook: (
    id: string,
    input?: { events?: string[] },
  ) => Promise<{ data: IntegrationWebhookEndpoint }>;
  /** Change which events the endpoint accepts. Empty = every declared event. */
  updateWebhookEvents: (id: string, events: string[]) => Promise<{ data: IntegrationSync }>;
  /** Tear the endpoint down. The provider is asked to stop, but cannot block it. */
  disableWebhook: (id: string) => Promise<{ ok: boolean }>;
  /** What arrived on the endpoint, newest first — an endpoint's whole health. */
  inboundDeliveries: (id: string) => Promise<{ data: IntegrationInboundDelivery[] }>;
}

export const makeIntegrations = (core: ClientCore): IntegrationsClient => {
  // Third-party integrations. Admin-scoped over `/api/admin/integrations`.
  // Credentials only ever travel inbound: `list` returns them masked and there
  // is no read-back endpoint.
  const integ = (id: string) => `/api/admin/integrations/${encodeURIComponent(id)}`;
  const integrations: IntegrationsClient = {
    catalog: () =>
      core.request<{
        data: {
          kinds: string[];
          providers: IntegrationProvider[];
          oauthRedirectUri: string;
          webhooks: Record<string, IntegrationWebhookInfo>;
        };
      }>("GET", "/api/admin/integrations/catalog"),
    list: () => core.request<{ data: Integration[] }>("GET", "/api/admin/integrations"),
    connect: (input) => core.request<{ data: Integration }>("POST", "/api/admin/integrations", input),
    disconnect: (id) => core.request<{ ok: boolean }>("DELETE", integ(id)),
    deliveries: (id, opts) => {
      const qs = opts?.limit === undefined ? "" : `?limit=${opts.limit}`;
      return core.request<{ data: IntegrationDelivery[] }>("GET", `${integ(id)}/deliveries${qs}`);
    },
    resume: (id) => core.request<{ data: Integration }>("POST", `${integ(id)}/resume`, {}),
    oauthAuthorize: (id) => core.request<{ data: { url: string } }>("POST", `${integ(id)}/oauth/authorize`, {}),
    syncs: (opts) => {
      const qs = opts?.integrationId ? `?integrationId=${encodeURIComponent(opts.integrationId)}` : "";
      return core.request<{ data: IntegrationSync[] }>("GET", `/api/admin/integrations/syncs${qs}`);
    },
    runTask: (integrationId, task, input) =>
      core.request(
        "POST",
        `${integ(integrationId)}/tasks/${encodeURIComponent(task)}`,
        input,
      ),
    taskRuns: (collection, itemId) =>
      core.request(
        "GET",
        `/api/admin/integrations/task-runs?collection=${encodeURIComponent(collection)}&itemId=${encodeURIComponent(itemId)}`,
      ),
    createSync: (input) =>
      core.request<{ data: IntegrationSync }>("POST", "/api/admin/integrations/syncs", input),
    updateSync: (id, patch) =>
      core.request<{ data: IntegrationSync }>(
        "PATCH",
        `/api/admin/integrations/syncs/${encodeURIComponent(id)}`,
        patch,
      ),
    deleteSync: (id) =>
      core.request<{ ok: boolean }>("DELETE", `/api/admin/integrations/syncs/${encodeURIComponent(id)}`),
    listingCategories: (integrationId) =>
      core.request<{ data: ListingCategory[] }>(
        "GET",
        `/api/admin/integrations/${encodeURIComponent(integrationId)}/listing/categories`,
      ),
    listingAttributes: (integrationId, categoryId) =>
      core.request<{ data: ListingAttribute[] }>(
        "GET",
        `/api/admin/integrations/${encodeURIComponent(integrationId)}/listing/attributes?categoryId=${encodeURIComponent(categoryId)}`,
      ),
    listingLookup: (integrationId, input) => {
      const qs = new URLSearchParams({ lookup: input.lookup });
      if (input.query) qs.set("query", input.query);
      if (input.cursor) qs.set("cursor", input.cursor);
      return core.request<{ data: { items: { id: string; name: string }[]; cursor: string | null } }>(
        "GET",
        `/api/admin/integrations/${encodeURIComponent(integrationId)}/listing/lookup?${qs}`,
      );
    },
    listingMaps: (syncId) =>
      core.request<{ data: ListingMap[] }>(
        "GET",
        `/api/admin/integrations/syncs/${encodeURIComponent(syncId)}/listing/maps`,
      ),
    mapListingCategory: (syncId, input) =>
      core.request<{ data: ListingMap }>(
        "PUT",
        `/api/admin/integrations/syncs/${encodeURIComponent(syncId)}/listing/maps`,
        input,
      ),
    unmapListingCategory: (syncId, mapId) =>
      core.request<{ ok: boolean }>(
        "DELETE",
        `/api/admin/integrations/syncs/${encodeURIComponent(syncId)}/listing/maps/${encodeURIComponent(mapId)}`,
      ),
    listingBatches: (syncId) =>
      core.request<{ data: ListingBatch[] }>(
        "GET",
        `/api/admin/integrations/syncs/${encodeURIComponent(syncId)}/listing/batches`,
      ),
    runSync: (id) =>
      core.request<{ data: { written: number; pages: number; complete: boolean } }>(
        "POST",
        `/api/admin/integrations/syncs/${encodeURIComponent(id)}/run`,
        {},
      ),
    enableWebhook: (id, input) =>
      core.request<{ data: IntegrationWebhookEndpoint }>(
        "POST",
        `/api/admin/integrations/syncs/${encodeURIComponent(id)}/webhook`,
        input ?? {},
      ),
    updateWebhookEvents: (id, events) =>
      core.request<{ data: IntegrationSync }>(
        "PATCH",
        `/api/admin/integrations/syncs/${encodeURIComponent(id)}/webhook`,
        { events },
      ),
    disableWebhook: (id) =>
      core.request<{ ok: boolean }>(
        "DELETE",
        `/api/admin/integrations/syncs/${encodeURIComponent(id)}/webhook`,
      ),
    inboundDeliveries: (id) =>
      core.request<{ data: IntegrationInboundDelivery[] }>(
        "GET",
        `/api/admin/integrations/syncs/${encodeURIComponent(id)}/deliveries`,
      ),
  };

  return integrations;
};
