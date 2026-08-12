/**
 * @backlex/integrations — runtime-agnostic third-party integration adapters.
 *
 * The single source of truth for connecting an org/workspace to Slack, Discord,
 * Datadog, GitHub (and the rest of `INTEGRATION_KINDS`) and fanning events out
 * to it. Pure + dependency-free (Workers + Node): no DB, no crypto, no env
 * coupling. The CONSUMER owns:
 *   - persistence (the `integrations` row + its `config`),
 *   - secret encryption at rest (encrypt the SECRET_KEYS before store, decrypt
 *     before `deliverToIntegration`) and masking on read (`maskConfig`),
 *   - the event source (data events in the project admin; ops events in cloud).
 *
 * This lets the cloud control plane and the self-hostable project admin share
 * one adapter implementation instead of each maintaining its own.
 *
 * Each provider lives in `./providers/<id>.ts` as a `defineProvider` descriptor
 * that owns its label, category, config fields and delivery behaviour; the
 * lookup tables below are DERIVED from that registry, so the four of them can
 * no longer drift apart.
 */

import {
  type DeliveryOutcome,
  type DestinationColumn,
  type FetchLike,
  type IntegrationConfigField,
  type IntegrationListing,
  type IntegrationTask,
  type ListingAttribute,
  type ListingBatch,
  type ListingCategory,
  type ListingOption,
  type ListingProduct,
  type ListingVerdict,
  type SourcePullPage,
  type IntegrationEvent,
  type IntegrationProvider,
  type TaskOutput,
  type TaskResult,
  type IntegrationWebhook,
  type WebhookAuthKind,
  type WebhookDelivery,
  columnsForSettings,
  OAUTH_CONFIG_KEYS,
  secretKeysOf,
} from "./provider";
import { enc, hmac, timingSafeEqual, toHex } from "./payment-crypto";
import { INTEGRATION_KINDS, type IntegrationKind, PROVIDERS, providerFor } from "./providers";
import { isRateLimited, throttled } from "./throttle";

/**
 * Wrap the caller's fetch (or the global one) with this provider's pacing and
 * 429 classification.
 *
 * `connectionKey` namespaces the bucket per connected account, because two
 * workspaces holding two sellers' credentials have two independent quotas at
 * the provider — pacing them against each other would halve the throughput each
 * of them is entitled to. It falls back to the kind when a caller has no
 * connection in hand, which is the safe direction: over-pacing costs latency,
 * under-pacing costs 429s.
 */
const engineFetch = (kind: string, connectionKey: string | undefined, fetchImpl?: FetchLike): FetchLike =>
  throttled(
    `${kind}:${connectionKey ?? "-"}`,
    providerFor(kind)?.limits,
    fetchImpl ?? ((i, init) => fetch(i, init)),
    providerFor(kind)?.label ?? kind,
  );

export type {
  DeliverContext,
  DeliveryOutcome,
  DestinationColumn,
  FetchLike,
  IntegrationCapability,
  IntegrationCategory,
  IntegrationConfigField,
  IntegrationEvent,
  IntegrationOAuth,
  IntegrationProvider,
  IntegrationDestination,
  IntegrationSource,
  DestinationPushContext,
  DestinationRow,
  IntegrationTask,
  IntegrationListing,
  ListingAttribute,
  ListingAttributeBinding,
  ListingAttributeValue,
  ListingBatch,
  ListingCatalogContext,
  ListingCategory,
  ListingOption,
  ListingPollContext,
  ListingProduct,
  ListingPublishContext,
  ListingVariant,
  ListingVerdict,
  RateLimit,
  SourceChildRecord,
  SourcePullContext,
  SourcePullPage,
  SourceRecord,
  TaskArtifact,
  TaskOutput,
  TaskResult,
  TaskRunContext,
  IntegrationWebhook,
  WebhookAuthKind,
  WebhookDelivery,
  WebhookParseContext,
  WebhookRecord,
  WebhookRegisterContext,
  WebhookVerifyContext,
} from "./provider";
export { isRateLimited, parseRetryAfter, RateLimitedError, resetThrottleState, takeToken, throttled } from "./throttle";
/**
 * UPS is the one provider that mints and caches its own bearer token — the
 * client-credentials grant has no user to redirect, so `IntegrationOAuth`
 * cannot drive it. Its cache is per-isolate and would otherwise leak a token
 * between specs, so the reset is exported for the tests exactly as the
 * throttle's is.
 */
export { resetUpsTokens } from "./providers/ups";
export {
  columnsForSettings,
  defineProvider,
  OAUTH_ACCESS_TOKEN_KEY,
  OAUTH_CONFIG_KEYS,
  OAUTH_CONNECTED_AT_KEY,
  OAUTH_EXPIRES_AT_KEY,
  OAUTH_REFRESH_TOKEN_KEY,
  OAUTH_SCOPE_KEY,
  OAUTH_SECRET_KEYS,
} from "./provider";
export { INTEGRATION_KINDS, PROVIDERS, providerFor };
export type { IntegrationKind };

export const isIntegrationKind = (k: string): k is IntegrationKind =>
  (INTEGRATION_KINDS as readonly string[]).includes(k);

const entries = Object.entries(PROVIDERS) as [IntegrationKind, IntegrationProvider<IntegrationKind>][];

const fromProviders = <V,>(pick: (p: IntegrationProvider<IntegrationKind>) => V): Record<IntegrationKind, V> =>
  Object.fromEntries(entries.map(([k, p]) => [k, pick(p)])) as Record<IntegrationKind, V>;

/** Per-provider config schema — drives the connect dialog in both UIs. */
export const INTEGRATION_FIELDS = fromProviders((p) => [...p.configFields]);

/** Config keys holding secrets, per kind — encrypt at rest, mask on read. */
export const SECRET_KEYS = fromProviders(secretKeysOf);

/** Catalog metadata for grouping the connect UI without loading `deliver`. */
export const INTEGRATION_CATALOG = entries.map(([id, p]) => ({
  id,
  label: p.label,
  category: p.category,
  capabilities: [...p.capabilities],
  fields: [...p.configFields],
  /** The UI shows "Connect with <provider>" instead of a paste-a-key form. */
  oauth: Boolean(p.oauth),
  /** The UI warns that row contents will leave the instance. */
  recordPayload: Boolean(p.recordPayload),
}));

/** Kinds that receive the row itself, not just the fact that it changed. */
export const RECORD_PAYLOAD_KINDS = entries.filter(([, p]) => p.recordPayload).map(([id]) => id);

/** Kinds connected through the OAuth flow rather than a pasted credential. */
export const OAUTH_KINDS = entries.filter(([, p]) => p.oauth).map(([id]) => id);

/** Kinds that can pull rows into a collection. Derived, like OAUTH_KINDS. */
export const SOURCE_KINDS = entries.filter(([, p]) => p.source).map(([id]) => id);

/** Kinds that can receive rows from a collection. */
export const DESTINATION_KINDS = entries.filter(([, p]) => p.destination).map(([id]) => id);

/** Per-sync settings each destination provider asks for, keyed by kind. */
export const DESTINATION_SETTING_FIELDS = Object.fromEntries(
  entries.filter(([, p]) => p.destination).map(([id, p]) => [id, [...p.destination!.settingFields]]),
) as Record<string, IntegrationConfigField[]>;

/**
 * Destination columns a row may be mapped onto, for the providers that have a
 * closed set. Absent for a warehouse, whose columns are the operator's DDL —
 * the admin UI reads that absence as "free text" and the sync service as
 * "nothing to validate against".
 *
 * The FULL list, including columns that only apply under some settings. Both
 * consumers narrow it with {@link destinationColumnsFor}; sending the narrowed
 * list instead would mean the admin UI could not re-narrow it when the operator
 * changes the record type without another round trip.
 */
export const DESTINATION_COLUMNS = Object.fromEntries(
  entries
    .filter(([, p]) => p.destination?.columns)
    .map(([id, p]) => [id, [...p.destination!.columns!]]),
) as Record<string, DestinationColumn[]>;

/** This kind's destination columns, narrowed to what these settings allow.
 *  `undefined` (a warehouse) stays undefined — that means "free text". */
export const destinationColumnsFor = (
  kind: string,
  settings: Record<string, unknown>,
): DestinationColumn[] | undefined => {
  const all = DESTINATION_COLUMNS[kind];
  return all ? columnsForSettings(all, settings) : undefined;
};

/** Rows per push call where the provider asked for a smaller batch than the
 *  engine's default. The engine clamps DOWN to this; it never enlarges. */
export const DESTINATION_BATCH_SIZE = Object.fromEntries(
  entries
    .filter(([, p]) => typeof p.destination?.batchSize === "number")
    .map(([id, p]) => [id, p.destination!.batchSize!]),
) as Record<string, number>;

/**
 * Send one batch to a destination provider.
 *
 * Like `pullFromSource` and unlike `deliverToIntegration`, this does NOT swallow
 * errors: a failed push that reported success would advance the watermark past
 * rows the warehouse never received.
 */
export async function pushToDestination(
  kind: string,
  args: {
    config: Record<string, unknown>;
    settings: Record<string, unknown>;
    rows: readonly Record<string, unknown>[];
    columns: Record<string, string>;
    /** Identifies the sync, for a provider that has to mint ids elsewhere. */
    syncKey: string;
    /** The connected account, so pacing is per-credential. See `engineFetch`. */
    connectionKey?: string;
  },
  fetchImpl?: FetchLike,
): Promise<void> {
  const provider = providerFor(kind);
  if (!provider?.destination) throw new Error(`${kind} cannot be used as a destination`);
  if (args.rows.length === 0) return;
  const doFetch = engineFetch(kind, args.connectionKey, fetchImpl);
  const pick = (bag: Record<string, unknown>, key: string) => {
    const v = bag[key];
    return typeof v === "string" && v ? v : null;
  };
  await provider.destination.push({
    config: args.config,
    settings: args.settings,
    rows: args.rows,
    columns: args.columns,
    syncKey: args.syncKey,
    fetch: doFetch,
    str: (key) => pick(args.config, key),
    setting: (key) => pick(args.settings, key),
  });
}

/** Kinds that can act on a single row. Derived, like SOURCE_KINDS. */
export const TASK_KINDS = entries.filter(([, p]) => p.tasks?.length).map(([id]) => id);

/**
 * Every task a provider declares, flattened for the catalog.
 *
 * `outputs` travels with each one because a caller has to map them onto its own
 * columns before it can invoke anything — the admin form and the flow step both
 * build their pickers from this rather than from a second, hand-kept list.
 *
 * `repeatable` travels for a narrower reason: it is what tells a caller that
 * scheduling this task hourly is the intended use rather than an accident, and
 * that the "re-run" escape hatch has nothing to escape.
 */
export const INTEGRATION_TASKS = Object.fromEntries(
  entries
    .filter(([, p]) => p.tasks?.length)
    .map(([id, p]) => [
      id,
      p.tasks!.map((t) => ({
        id: t.id,
        label: t.label,
        settingFields: [...(t.settingFields ?? [])],
        outputs: [...t.outputs],
        repeatable: t.repeatable === true,
      })),
    ]),
) as Record<
  string,
  { id: string; label: string; settingFields: IntegrationConfigField[]; outputs: TaskOutput[]; repeatable: boolean }[]
>;

/** Look one task up. `undefined` for an unknown kind or an unknown task id. */
export const taskFor = (kind: string, taskId: string): IntegrationTask | undefined =>
  providerFor(kind)?.tasks?.find((t) => t.id === taskId);

/**
 * What is wrong with these per-invocation settings, described, or null.
 *
 * Registry-only and pure, so the two places that ask can share one answer. The
 * engine asks at RUN time, where this is the guard — an unrecognised key would
 * otherwise reach a provider's URLs and request bodies. A flow asks at SAVE
 * time, where it is the difference between the author hearing about a typo
 * while they are looking at the step and a run failing three weeks later.
 */
export const taskSettingsProblem = (
  kind: string,
  task: IntegrationTask,
  settings: Record<string, unknown>,
): string | null => {
  const declared = new Map((task.settingFields ?? []).map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(settings)) {
    const field = declared.get(key);
    if (!field) return `${kind}.${task.id} has no setting "${key}"`;
    if (field.options && !field.options.some((o) => o.value === value)) {
      return `"${key}" must be one of: ${field.options.map((o) => o.value).join(", ")}`;
    }
  }
  return null;
};

/**
 * What is wrong with mapping these output keys, described, or null.
 *
 * Only the half the registry can answer — that the provider declares each key.
 * Whether the TARGET column can be written to needs the collection, so the
 * engine checks that on top of this one. Both halves matter: an undeclared key
 * means a column that stays empty with nothing to say why.
 */
export const taskOutputsProblem = (
  kind: string,
  task: IntegrationTask,
  keys: Iterable<string>,
): string | null => {
  const declared = new Set(task.outputs.map((o) => o.key));
  for (const key of keys) {
    if (!declared.has(key)) return `${kind}.${task.id} has no output "${key}"`;
  }
  return null;
};

/**
 * Run one task against one row.
 *
 * Like `pullFromSource` and unlike `deliverToIntegration`, this does NOT swallow
 * errors: a task that reported success having failed would leave the engine
 * recording a shipment nobody booked, and the row would never be retried.
 *
 * The engine validates the result rather than trusting it — an output the
 * provider never declared is refused here, at the boundary, instead of being
 * written into a collection under a name no picker ever offered.
 */
export async function runIntegrationTask(
  kind: string,
  taskId: string,
  args: {
    config: Record<string, unknown>;
    settings: Record<string, unknown>;
    row: Record<string, unknown>;
    idempotencyKey: string;
    /** The connected account, so pacing is per-credential. See `engineFetch`. */
    connectionKey?: string;
  },
  fetchImpl?: FetchLike,
): Promise<TaskResult> {
  const task = taskFor(kind, taskId);
  if (!task) throw new Error(`${kind} has no task "${taskId}"`);
  const doFetch = engineFetch(kind, args.connectionKey, fetchImpl);
  const pick = (bag: Record<string, unknown>, key: string) => {
    const v = bag[key];
    return typeof v === "string" && v ? v : null;
  };

  const result = await task.run({
    config: args.config,
    settings: args.settings,
    row: args.row,
    idempotencyKey: args.idempotencyKey,
    fetch: doFetch,
    str: (key) => pick(args.config, key),
    setting: (key) => pick(args.settings, key),
  });

  const declared = new Set(task.outputs.map((o) => o.key));
  for (const key of Object.keys(result.outputs ?? {})) {
    if (!declared.has(key)) {
      throw new Error(`${kind}.${taskId} returned undeclared output "${key}"`);
    }
  }
  if (result.artifact) {
    const slot = task.outputs.find((o) => o.key === result.artifact!.outputKey);
    if (!slot?.artifact) {
      throw new Error(`${kind}.${taskId} returned an artifact for non-artifact output "${result.artifact.outputKey}"`);
    }
  }
  return result;
}

/** Per-sync settings each source provider asks for, keyed by kind. */
export const SOURCE_SETTING_FIELDS = Object.fromEntries(
  entries.filter(([, p]) => p.source).map(([id, p]) => [id, [...p.source!.settingFields]]),
) as Record<string, IntegrationConfigField[]>;

/**
 * Child groups each source can hand back, for the sources that have any.
 *
 * A kind missing from this map declares none, which the admin UI reads as "no
 * lines to map" and the sync service as "nothing to check a group name
 * against". Both are the right reading for a flat source, and neither needs a
 * second hand-kept list to say so.
 */
export const SOURCE_CHILD_GROUPS = Object.fromEntries(
  entries
    .filter(([, p]) => p.source?.childGroups?.length)
    .map(([id, p]) => [id, [...p.source!.childGroups!]]),
) as Record<string, { key: string; label: string }[]>;

/**
 * Pull one page from a source provider.
 *
 * Unlike `deliverToIntegration`, this deliberately does NOT swallow errors. A
 * failed delivery is one lost notification; a failed pull that reported success
 * would advance the cursor past rows nobody ever read.
 */
export async function pullFromSource(
  kind: string,
  args: {
    config: Record<string, unknown>;
    settings: Record<string, unknown>;
    cursor: string | null;
    limit: number;
    /** The connected account, so pacing is per-credential. See `engineFetch`. */
    connectionKey?: string;
  },
  fetchImpl?: FetchLike,
): Promise<SourcePullPage> {
  const provider = providerFor(kind);
  if (!provider?.source) throw new Error(`${kind} cannot be used as a source`);
  const doFetch = engineFetch(kind, args.connectionKey, fetchImpl);
  const pick = (bag: Record<string, unknown>, key: string) => {
    const v = bag[key];
    return typeof v === "string" && v ? v : null;
  };
  return provider.source.pull({
    config: args.config,
    settings: args.settings,
    cursor: args.cursor,
    limit: args.limit,
    fetch: doFetch,
    str: (key) => pick(args.config, key),
    setting: (key) => pick(args.settings, key),
  });
}

// ── Inbound webhooks ─────────────────────────────────────────────────────────

/** Kinds that call us. Derived, like SOURCE_KINDS. */
export const WEBHOOK_KINDS = entries.filter(([, p]) => p.webhook).map(([id]) => id);

/**
 * What each webhook provider needs an operator and a form to know.
 *
 * `verify`/`parse` are deliberately absent: this is what crosses the API to the
 * admin UI, and a function cannot. Everything a form has to render — how the
 * secret is used, which header carries it, which events exist, whether a
 * delivery replaces a row or patches one, and whether we can register the
 * endpoint ourselves — is here, so the UI never has to special-case a kind.
 */
export const INTEGRATION_WEBHOOKS = Object.fromEntries(
  entries
    .filter(([, p]) => p.webhook)
    .map(([id, p]) => [
      id,
      {
        auth: p.webhook!.auth,
        header: p.webhook!.header ?? null,
        events: [...p.webhook!.events],
        landing: p.webhook!.landing,
        matchLabel: p.webhook!.matchLabel ?? null,
        /** The operator gets an "activate at the provider" button instead of a
         *  URL to paste into an API that has no UI. */
        selfRegistering: typeof p.webhook!.register === "function",
      },
    ]),
) as Record<
  string,
  {
    auth: WebhookAuthKind;
    header: string | null;
    events: { key: string; label: string }[];
    landing: "upsert" | "patch";
    matchLabel: string | null;
    selfRegistering: boolean;
  }
>;

/** Look up a kind's webhook block. `undefined` when it has none. */
export const webhookFor = (kind: string): IntegrationWebhook | undefined => providerFor(kind)?.webhook;

/**
 * Is this delivery genuinely from the provider?
 *
 * Returns a verdict rather than throwing on rejection, because the two answers
 * mean opposite things to a caller: a forged or mis-signed delivery must be
 * refused with a 4xx and never retried, while an error thrown out of a verifier
 * is our own failure and has to read as a 5xx so the provider tries again.
 *
 * An unknown kind, or a kind with no webhook block, is `false` — there is no
 * secret to check against, so nothing can prove itself.
 */
export async function verifyWebhookDelivery(
  kind: string,
  args: {
    rawBody: string;
    headers: Headers | Record<string, string>;
    secret: string;
    config: Record<string, unknown>;
  },
): Promise<boolean> {
  const hook = webhookFor(kind);
  if (!hook) return false;
  return hook.verify({
    rawBody: args.rawBody,
    header: (name) => readHeader(args.headers, name),
    secret: args.secret,
    config: args.config,
    str: (key) => {
      const v = args.config[key];
      return typeof v === "string" && v ? v : null;
    },
    hmacSha256Hex: async (key, message) => toHex(await hmac(enc.encode(key), message)),
    safeEqual: timingSafeEqual,
  });
}

/**
 * Turn a verified delivery into records.
 *
 * `null` means "not something this provider recognises" — a ping, or an event
 * kind that arrived after this code was written. The engine records that as
 * ignored rather than failed: answering 5xx would make a provider retry a body
 * it will never send successfully, and answering 4xx would make it disable an
 * endpoint that is working perfectly.
 */
export function parseWebhookDelivery(
  kind: string,
  args: { rawBody: string; headers: Headers | Record<string, string>; config: Record<string, unknown> },
): WebhookDelivery | null {
  const hook = webhookFor(kind);
  if (!hook) return null;
  let json: unknown = null;
  try {
    json = JSON.parse(args.rawBody);
  } catch {
    // Not every provider sends JSON, and a parser that wants the raw text still
    // gets it. `null` here is a fact about the body, not a failure.
  }
  return hook.parse({
    rawBody: args.rawBody,
    header: (name) => readHeader(args.headers, name),
    json,
    config: args.config,
    str: (key) => {
      const v = args.config[key];
      return typeof v === "string" && v ? v : null;
    },
  });
}

/**
 * Ask the provider to start calling `url`.
 *
 * Throws on failure, like every other call that has an outside effect here: an
 * endpoint the operator believes is active but which was never registered is
 * silence that looks exactly like "nothing has happened yet".
 */
export async function registerWebhook(
  kind: string,
  args: {
    config: Record<string, unknown>;
    url: string;
    secret: string;
    events: readonly string[];
    connectionKey?: string;
  },
  fetchImpl?: FetchLike,
): Promise<{ id: string }> {
  const hook = webhookFor(kind);
  if (!hook?.register) throw new Error(`${kind} cannot register a webhook`);
  return hook.register({
    config: args.config,
    url: args.url,
    secret: args.secret,
    events: args.events,
    fetch: engineFetch(kind, args.connectionKey, fetchImpl),
    str: (key) => {
      const v = args.config[key];
      return typeof v === "string" && v ? v : null;
    },
  });
}

/**
 * Ask the provider to stop calling.
 *
 * Best-effort by contract: the caller removes its own subscription either way.
 * A registration left behind at the provider delivers to an endpoint whose
 * token no longer resolves, which is a 404 for them and nothing for us — worse
 * than the alternative only in noise, whereas refusing to disable a subscription
 * because the provider is unreachable would leave an operator unable to turn off
 * a firehose.
 */
export async function unregisterWebhook(
  kind: string,
  args: {
    config: Record<string, unknown>;
    url: string;
    secret: string;
    events: readonly string[];
    id: string;
    connectionKey?: string;
  },
  fetchImpl?: FetchLike,
): Promise<void> {
  const hook = webhookFor(kind);
  if (!hook?.unregister) return;
  await hook.unregister({
    config: args.config,
    url: args.url,
    secret: args.secret,
    events: args.events,
    id: args.id,
    fetch: engineFetch(kind, args.connectionKey, fetchImpl),
    str: (key) => {
      const v = args.config[key];
      return typeof v === "string" && v ? v : null;
    },
  });
}

// ── Listings ─────────────────────────────────────────────────────────────────

/** Kinds that can put a product on sale. Derived, like SOURCE_KINDS. */
export const LISTING_KINDS = entries.filter(([, p]) => p.listing).map(([id]) => id);

/**
 * What each listing provider needs a form to know, without loading its calls.
 *
 * The taxonomy itself is deliberately NOT here. It is fetched per connection
 * with the seller's own credentials, it is hundreds of kilobytes, and it
 * changes without us — three reasons a build-time constant would be wrong. What
 * travels is only the part that IS fixed per provider: the columns a row maps
 * onto, the fields written back, and which registries can be searched.
 */
export const INTEGRATION_LISTINGS = Object.fromEntries(
  entries
    .filter(([, p]) => p.listing)
    .map(([id, p]) => [
      id,
      {
        settingFields: [...(p.listing!.settingFields ?? [])],
        columns: [...p.listing!.columns],
        variantColumns: p.listing!.variantColumns ? [...p.listing!.variantColumns] : null,
        outputs: [...p.listing!.outputs],
        lookups: [...(p.listing!.lookups ?? [])],
      },
    ]),
) as Record<
  string,
  {
    settingFields: IntegrationConfigField[];
    columns: DestinationColumn[];
    variantColumns: DestinationColumn[] | null;
    outputs: TaskOutput[];
    lookups: { key: string; label: string }[];
  }
>;

/** Look up a kind's listing block. `undefined` when it has none. */
export const listingFor = (kind: string): IntegrationListing | undefined => providerFor(kind)?.listing;

/** This kind's listing columns, narrowed to what these settings allow. */
export const listingColumnsFor = (
  kind: string,
  settings: Record<string, unknown>,
  which: "product" | "variant" = "product",
): DestinationColumn[] | undefined => {
  const block = listingFor(kind);
  if (!block) return undefined;
  const all = which === "variant" ? block.variantColumns : block.columns;
  return all ? columnsForSettings(all, settings) : undefined;
};

/** The catalog reads share one context; only the arguments differ. */
const catalogContext = (kind: string, config: Record<string, unknown>, connectionKey?: string, fetchImpl?: FetchLike) => ({
  config,
  fetch: engineFetch(kind, connectionKey, fetchImpl),
  str: (key: string) => {
    const v = config[key];
    return typeof v === "string" && v ? v : null;
  },
});

/**
 * The whole category tree, flattened.
 *
 * Not cached here: this package holds no state that outlives a request, and a
 * tree cached per isolate would answer differently depending on which isolate
 * served the operator — the read-your-writes trap that has bitten this codebase
 * before. The caller caches, where it can key by connection and expire.
 */
export async function fetchListingCategories(
  kind: string,
  args: { config: Record<string, unknown>; connectionKey?: string },
  fetchImpl?: FetchLike,
): Promise<ListingCategory[]> {
  const block = listingFor(kind);
  if (!block) throw new Error(`${kind} cannot list products`);
  return block.categories(catalogContext(kind, args.config, args.connectionKey, fetchImpl));
}

/** What one leaf category demands of a product. */
export async function fetchListingAttributes(
  kind: string,
  args: { config: Record<string, unknown>; categoryId: string; connectionKey?: string },
  fetchImpl?: FetchLike,
): Promise<ListingAttribute[]> {
  const block = listingFor(kind);
  if (!block) throw new Error(`${kind} cannot list products`);
  return block.attributes({
    ...catalogContext(kind, args.config, args.connectionKey, fetchImpl),
    categoryId: args.categoryId,
  });
}

/**
 * Search one declared registry — a brand list.
 *
 * The lookup key is checked against the provider's declaration rather than
 * passed through, for the same reason a destination column is: it reaches the
 * provider's URLs, and an undeclared one is a typo that would otherwise surface
 * as an empty picker with nothing to say why.
 */
export async function searchListingLookup(
  kind: string,
  args: {
    config: Record<string, unknown>;
    lookup: string;
    query: string;
    cursor: string | null;
    connectionKey?: string;
  },
  fetchImpl?: FetchLike,
): Promise<{ items: ListingOption[]; cursor: string | null }> {
  const block = listingFor(kind);
  if (!block?.lookup) throw new Error(`${kind} has no searchable listing registries`);
  if (!block.lookups?.some((l) => l.key === args.lookup)) {
    throw new Error(`${kind} has no listing registry "${args.lookup}"`);
  }
  return block.lookup({
    ...catalogContext(kind, args.config, args.connectionKey, fetchImpl),
    lookup: args.lookup,
    query: args.query,
    cursor: args.cursor,
  });
}

/**
 * Send one batch of products to be listed.
 *
 * Does NOT swallow errors, like every other call with an outside effect: a
 * publish that reported success having failed would leave the engine polling a
 * batch id the marketplace never issued, and the products would sit `pending`
 * forever with nothing to retry them.
 */
export async function publishListings(
  kind: string,
  args: {
    config: Record<string, unknown>;
    settings: Record<string, unknown>;
    products: readonly ListingProduct[];
    connectionKey?: string;
  },
  fetchImpl?: FetchLike,
): Promise<ListingBatch> {
  const block = listingFor(kind);
  if (!block) throw new Error(`${kind} cannot list products`);
  if (args.products.length === 0) throw new Error(`${kind}: nothing to publish`);
  const pick = (bag: Record<string, unknown>, key: string) => {
    const v = bag[key];
    return typeof v === "string" && v ? v : null;
  };
  return block.publish({
    config: args.config,
    settings: args.settings,
    products: args.products,
    fetch: engineFetch(kind, args.connectionKey, fetchImpl),
    str: (key) => pick(args.config, key),
    setting: (key) => pick(args.settings, key),
  });
}

/**
 * Ask what became of a batch.
 *
 * Verdicts for references this batch never carried are dropped HERE rather than
 * by each provider, so a marketplace whose status endpoint reports a whole queue
 * can be implemented literally. `known` is the guard: without it, one sync's
 * poll could write another sync's rows.
 */
export async function pollListingBatch(
  kind: string,
  args: {
    config: Record<string, unknown>;
    settings: Record<string, unknown>;
    batchId: string;
    known: Iterable<string>;
    connectionKey?: string;
  },
  fetchImpl?: FetchLike,
): Promise<ListingVerdict[]> {
  const block = listingFor(kind);
  if (!block) throw new Error(`${kind} cannot list products`);
  const pick = (bag: Record<string, unknown>, key: string) => {
    const v = bag[key];
    return typeof v === "string" && v ? v : null;
  };
  const verdicts = await block.poll({
    config: args.config,
    settings: args.settings,
    batchId: args.batchId,
    fetch: engineFetch(kind, args.connectionKey, fetchImpl),
    str: (key) => pick(args.config, key),
    setting: (key) => pick(args.settings, key),
  });
  const known = new Set(args.known);
  return verdicts.filter((v) => known.has(v.reference));
}

/** Case-insensitive header read across both shapes a caller may hold. */
const readHeader = (headers: Headers | Record<string, string>, name: string): string | null => {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? null;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return typeof v === "string" ? v : null;
  }
  return null;
};

/**
 * Strip the OAuth-owned keys from caller-supplied config.
 *
 * Applied to every admin write. Two reasons: a pasted `_oauthAccessToken` would
 * be indistinguishable from one the provider issued, and an admin editing an
 * unrelated field would otherwise silently drop the tokens by omitting them.
 */
export function stripOAuthKeys(config: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set<string>(OAUTH_CONFIG_KEYS);
  return Object.fromEntries(Object.entries(config).filter(([k]) => !reserved.has(k)));
}

const maskValue = (v: string): string => (v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`);

/** Return a copy of `config` with this kind's secret fields masked for display. */
export function maskConfig(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  const secrets = new Set(SECRET_KEYS[kind as IntegrationKind] ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = secrets.has(k) && typeof v === "string" && v ? maskValue(v) : v;
  }
  return out;
}

/**
 * Should a connected integration receive `event`? A `null`/empty subscription
 * means "all events". Supports exact names, `*`, and `prefix.*` wildcards.
 */
export function matchesEventFilter(subscribed: readonly string[] | null | undefined, event: string): boolean {
  if (!subscribed || subscribed.length === 0) return true;
  return subscribed.some(
    (e) => e === event || e === "*" || (e.endsWith(".*") && event.startsWith(e.slice(0, -1))),
  );
}

/**
 * Deliver one event to one connected integration. `config` must already be
 * DECRYPTED by the caller. Best-effort: an unknown kind, a misconfigured
 * provider, or any thrown error returns `{ ok: false, status: 0 }` and never
 * throws — a broken integration must not break the write path that fired the
 * event.
 *
 * The one error given its own answer is a 429, which comes back as
 * `{ ok: false, status: 429 }` rather than the catch-all `0`. The distinction
 * is what lets the caller keep a throttled provider out of the breaker: `0`
 * means "misconfigured or unreachable", and pausing a connection for being
 * busy is the opposite of what an operator wants.
 */
export async function deliverToIntegration(
  kind: string,
  config: Record<string, unknown>,
  evt: IntegrationEvent,
  fetchImpl?: FetchLike,
  connectionKey?: string,
): Promise<DeliveryOutcome> {
  const fail: DeliveryOutcome = { ok: false, status: 0 };
  const provider = providerFor(kind);
  if (!provider?.deliver) return fail;

  const doFetch = engineFetch(kind, connectionKey, fetchImpl);
  try {
    const outcome = await provider.deliver({
      config,
      event: evt,
      fetch: doFetch,
      async post(url, body, headers = {}) {
        const r = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        return { ok: r.ok, status: r.status };
      },
      str(key) {
        const v = config[key];
        return typeof v === "string" && v ? v : null;
      },
    });
    return outcome ?? fail;
  } catch (e) {
    return isRateLimited(e) ? { ok: false, status: 429 } : fail;
  }
}
