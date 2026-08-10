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
  type SourcePullPage,
  type IntegrationEvent,
  type IntegrationProvider,
  columnsForSettings,
  OAUTH_CONFIG_KEYS,
  secretKeysOf,
} from "./provider";
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
  RateLimit,
  SourceChildRecord,
  SourcePullContext,
  SourcePullPage,
  SourceRecord,
} from "./provider";
export { isRateLimited, parseRetryAfter, RateLimitedError, resetThrottleState, takeToken, throttled } from "./throttle";
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

/** Per-sync settings each source provider asks for, keyed by kind. */
export const SOURCE_SETTING_FIELDS = Object.fromEntries(
  entries.filter(([, p]) => p.source).map(([id, p]) => [id, [...p.source!.settingFields]]),
) as Record<string, IntegrationConfigField[]>;

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
