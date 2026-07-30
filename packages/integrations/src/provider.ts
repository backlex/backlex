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
  | "search"
  | "productivity"
  | "accounting";

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
 * How a provider is connected with OAuth 2.0 (authorization-code grant).
 *
 * backlex is self-hostable, so there is no platform-wide OAuth client to fall
 * back on: the workspace admin registers their own app with the provider and
 * supplies `clientId` / `clientSecret` as ordinary config fields. That is why
 * this block carries only the provider's fixed endpoints and never a credential.
 */
export interface IntegrationOAuth {
  /** Provider's authorization endpoint. Fixed per provider, never caller-supplied. */
  authorizeUrl: string;
  /** Provider's token endpoint, used for both the initial exchange and refresh. */
  tokenUrl: string;
  /** Scopes requested at authorize time. */
  scopes: readonly string[];
  /**
   * Extra authorize-time query params, e.g. Google's `access_type=offline` +
   * `prompt=consent`, without which no refresh token is ever issued.
   */
  authorizeParams?: Record<string, string>;
  /** Send PKCE (S256). Harmless where unsupported, so default it on per provider. */
  pkce?: boolean;
  /**
   * How the client credentials reach the token endpoint. Notion rejects the
   * body form and requires HTTP Basic; Google and Airtable accept either. This
   * is a real protocol difference, not a preference — getting it wrong fails
   * the exchange with an opaque 401.
   */
  tokenAuth?: "basic" | "body";
  /**
   * Some providers (Notion) issue tokens that never expire and return no
   * refresh token. Setting this skips the refresh path instead of treating a
   * missing refresh token as a broken connection.
   */
  nonExpiring?: boolean;
  /**
   * Extra top-level keys from the token response worth keeping — e.g.
   * QuickBooks' `realmId`, Notion's `workspace_name`. Copied verbatim into
   * config under the same key; never secrets.
   */
  keepFromTokenResponse?: readonly string[];
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
  /** Present only on providers connected via OAuth rather than a pasted key. */
  oauth?: IntegrationOAuth;
  deliver?(ctx: DeliverContext): Promise<DeliveryOutcome | null>;
}

/** Identity helper — exists so each provider file gets full type checking. */
export function defineProvider<Id extends string>(p: IntegrationProvider<Id>): IntegrationProvider<Id> {
  return p;
}

/**
 * Config keys the OAuth flow owns.
 *
 * They live in the same `config` blob as the provider's own fields, so the
 * prefix has to be one no provider would choose. Nothing outside
 * services/integrations-oauth.ts may write them: they are stripped from admin
 * input and carried over untouched when an admin edits the rest of the config,
 * so "this token came from the provider" stays true.
 */
export const OAUTH_ACCESS_TOKEN_KEY = "_oauthAccessToken";
export const OAUTH_REFRESH_TOKEN_KEY = "_oauthRefreshToken";
export const OAUTH_EXPIRES_AT_KEY = "_oauthExpiresAt";
export const OAUTH_SCOPE_KEY = "_oauthScope";
export const OAUTH_CONNECTED_AT_KEY = "_oauthConnectedAt";

/** Every reserved key, in the order a reader would expect to see them. */
export const OAUTH_CONFIG_KEYS = [
  OAUTH_ACCESS_TOKEN_KEY,
  OAUTH_REFRESH_TOKEN_KEY,
  OAUTH_EXPIRES_AT_KEY,
  OAUTH_SCOPE_KEY,
  OAUTH_CONNECTED_AT_KEY,
] as const;

/** The two that are bearer credentials and must be encrypted + masked. */
export const OAUTH_SECRET_KEYS = [OAUTH_ACCESS_TOKEN_KEY, OAUTH_REFRESH_TOKEN_KEY] as const;

/**
 * The config keys this provider stores as secrets.
 *
 * Derived from the declared fields, plus the OAuth tokens for any provider with
 * an `oauth` block — a provider author never lists those, so deriving them here
 * is what stops an access token being returned in cleartext by the admin API.
 */
export const secretKeysOf = (p: IntegrationProvider): string[] => [
  ...p.configFields.filter((f) => f.secret).map((f) => f.key),
  ...(p.oauth ? OAUTH_SECRET_KEYS : []),
];
