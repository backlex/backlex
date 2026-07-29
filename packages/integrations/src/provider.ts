/**
 * The provider descriptor every integration is defined with.
 *
 * One file per provider, one `defineProvider` call each. The registry
 * (`./providers`) collects them and `../index` derives the package's public
 * constants from that — so a provider's id, label, config fields, secrets and
 * delivery behaviour all live together instead of being spread across four
 * parallel lookup tables that can silently drift.
 *
 * Pure + dependency-free (Workers + Node): no DB, no crypto, no env coupling.
 */

/** Describes one config field a UI should collect for a provider. */
export interface IntegrationConfigField {
  key: string;
  label: string;
  placeholder?: string;
  /** Secret fields are encrypted at rest and masked when read back. */
  secret?: boolean;
}

/** Grouping for the connect UI's catalog. */
export type IntegrationCategory =
  | "chat"
  | "observability"
  | "analytics"
  | "issue-tracking"
  | "search";

/**
 * What a provider can do. Today every provider is a `sink` (receives events
 * fanned out from backlex). `action` (callable from a flow) and `source`
 * (inbound webhook / scheduled pull that writes back into a collection) are
 * declared here so the catalog and the routes can branch on capability before
 * the first provider implements them.
 */
export type IntegrationCapability = "sink" | "action" | "source";

/** An event to fan out: machine name, one-line human text, and a machine payload. */
export interface IntegrationEvent {
  /** e.g. "item.created" (admin) or "alarm.fired" (cloud) */
  event: string;
  /** one-line message for chat sinks (Slack/Discord) */
  text: string;
  /** machine body for GitHub client_payload / structured sinks */
  payload: Record<string, unknown>;
}

export interface DeliveryOutcome {
  ok: boolean;
  status: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * What a provider's `deliver` receives. `config` is already DECRYPTED by the
 * caller. `post` is the JSON-POST shortcut every current sink uses; drop to
 * `fetch` for anything else.
 */
export interface DeliverContext {
  config: Record<string, unknown>;
  event: IntegrationEvent;
  fetch: FetchLike;
  /** POST a JSON body and map the response to a {@link DeliveryOutcome}. */
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<DeliveryOutcome>;
  /**
   * Read a non-empty string config value, or `null` when it is missing or of
   * the wrong type. Returning `null` from `deliver` marks the integration
   * misconfigured, so the usual shape is `const k = ctx.str("apiKey"); if (!k) return null;`.
   */
  str(key: string): string | null;
}

/**
 * A single integration provider. `deliver` returns `null` when the stored
 * config is missing/invalid; the dispatcher turns that (and any thrown error)
 * into `{ ok: false, status: 0 }` so a misconfigured integration never breaks
 * the write path that triggered the event.
 */
export interface IntegrationProvider<Id extends string = string> {
  id: Id;
  label: string;
  category: IntegrationCategory;
  capabilities: readonly IntegrationCapability[];
  configFields: readonly IntegrationConfigField[];
  deliver?(ctx: DeliverContext): Promise<DeliveryOutcome | null>;
}

/** Identity helper — exists so each provider file gets full type checking. */
export function defineProvider<Id extends string>(p: IntegrationProvider<Id>): IntegrationProvider<Id> {
  return p;
}

/** The config keys this provider stores as secrets, derived from its fields. */
export const secretKeysOf = (p: IntegrationProvider): string[] =>
  p.configFields.filter((f) => f.secret).map((f) => f.key);
