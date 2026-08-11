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
  direction: "pull" | "push" | "inbound";
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
  direction?: "pull" | "push" | "inbound";
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
  runSync: (id: string) => Promise<{ data: { written: number; pages: number; complete: boolean } }>;
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
