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
  /**
   * A closed set of acceptable values. Present when the field is a choice
   * rather than free text — the UI renders a picker and the server refuses
   * anything outside the list, so a typo fails at the form instead of at the
   * first run with a provider error nobody can act on.
   */
  options?: readonly { value: string; label: string }[];
}

/** Grouping for the connect UI's catalog. */
export type IntegrationCategory =
  | "chat"
  | "observability"
  | "analytics"
  | "issue-tracking"
  | "search"
  | "productivity"
  | "accounting"
  | "warehouse"
  | "crm";

/**
 * What a provider can do. Today every provider is a `sink` (receives events
 * fanned out from backlex). `action` (callable from a flow) and `source`
 * (inbound webhook / scheduled pull that writes back into a collection) are
 * declared here so the catalog and the routes can branch on capability before
 * the first provider implements them.
 */
export type IntegrationCapability = "sink" | "action" | "source" | "destination";

/** An event to fan out: machine name, one-line human text, and a machine payload. */
export interface IntegrationEvent {
  /** e.g. "item.created" (admin) or "alarm.fired" (cloud) */
  event: string;
  /** one-line message for chat sinks (Slack/Discord) */
  text: string;
  /** machine body for GitHub client_payload / structured sinks */
  payload: Record<string, unknown>;
  /**
   * The record itself, present ONLY for providers that declared
   * {@link IntegrationProvider.recordPayload}.
   *
   * Kept out of `payload` deliberately. Most sinks want to know that something
   * changed, not what it said, and quietly handing every connected chat channel
   * the contents of every row is not a default anyone would choose.
   */
  record?: Record<string, unknown> | null;
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
   * Extra top-level keys from the token response worth keeping — e.g. Notion's
   * `workspace_name`. Copied verbatim into config under the same key; never
   * secrets.
   */
  keepFromTokenResponse?: readonly string[];
  /**
   * Query parameters on the redirect worth keeping. QuickBooks returns the
   * company id as `?realmId=…` on the callback and nowhere else — without this
   * an admin would have to go and find it by hand, and every API call needs it.
   *
   * These come from a third party's redirect, so they are stored as opaque
   * strings, length-capped, and only kept when the provider asked for them by
   * name. Never secrets.
   */
  keepFromCallbackQuery?: readonly string[];
}

/** One external record, as a source provider hands it over. */
export interface SourceRecord {
  /**
   * The provider's own id for this row. Stable across pulls — it is what makes
   * a re-pull an update rather than a duplicate. The engine namespaces it, so a
   * provider must NOT try to make it globally unique itself.
   */
  externalId: string;
  /** Raw external field names → values. Mapped to collection fields by config. */
  data: Record<string, unknown>;
}

/** One page of a pull. */
export interface SourcePullPage {
  records: SourceRecord[];
  /**
   * More pages in THIS run. `null` ends it.
   *
   * Opaque, echoed back on the next call. It round-trips through the database
   * and back into a request, so it must be short and must never be
   * interpolated into a URL path by the provider.
   */
  cursor: string | null;
  /**
   * Where the NEXT run should start, once this one is finished.
   *
   * Most providers have no such thing: a page walk ends, and the next run reads
   * the source from the top again to pick up edits. A few — Google Calendar's
   * sync token is the example — hand back a marker that makes the next run
   * incremental, and crucially lets it see deletions a page walk never would.
   *
   * Distinct from `cursor` because the engine treats them differently: a
   * cursor means "keep going now", a resume token means "stop, and begin here
   * next time". Conflating them would either loop forever or discard the token.
   */
  resumeToken?: string;
}

/** What a source provider's `pull` receives. */
export interface SourcePullContext {
  /** Connection config — credentials, already decrypted. */
  config: Record<string, unknown>;
  /** Per-sync settings (which spreadsheet, which table). Never secret. */
  settings: Record<string, unknown>;
  /** Resume token from the previous page, or `null` on the first. */
  cursor: string | null;
  /** Upper bound on records this page may return. */
  limit: number;
  fetch: FetchLike;
  /** Non-empty string from `config`, else `null`. */
  str(key: string): string | null;
  /** Non-empty string from `settings`, else `null`. */
  setting(key: string): string | null;
}

/**
 * A provider that pulls external rows into a collection.
 *
 * `pull` must treat everything it reads — settings and the cursor alike — as
 * untrusted: they reach it from an admin form and from the provider's own
 * previous answer. Build URLs with `encodeURIComponent`, and keep the cursor in
 * a query parameter rather than a path segment.
 */
export interface IntegrationSource {
  /** Per-sync config the admin fills in when pointing a sync at a collection. */
  settingFields: readonly IntegrationConfigField[];
  /**
   * Fetch one page. Throwing marks the run failed and it is retried with
   * backoff; the cursor is only advanced once a page lands.
   */
  pull(ctx: SourcePullContext): Promise<SourcePullPage>;
}

/** One row on its way OUT, already mapped to the destination's column names. */
export type DestinationRow = Record<string, unknown>;

/** What a destination provider's `push` receives. */
export interface DestinationPushContext {
  /** Connection config — credentials, already decrypted. */
  config: Record<string, unknown>;
  /** Per-sync settings (which dataset, which table). Never secret. */
  settings: Record<string, unknown>;
  /** The batch. Never empty — the engine skips the call when there is nothing. */
  rows: readonly DestinationRow[];
  /**
   * Destination column name → the source field's type, for providers that have
   * to declare a schema before they can accept a row. Types are backlex field
   * types (`text`, `number`, `boolean`, `timestamp`, `json`, …).
   */
  columns: Readonly<Record<string, string>>;
  fetch: FetchLike;
  str(key: string): string | null;
  setting(key: string): string | null;
}

/**
 * A provider that receives rows from a collection.
 *
 * The mirror image of {@link IntegrationSource}. `push` must be IDEMPOTENT on
 * the row's primary key: the engine re-sends the last batch after a crash, and
 * a warehouse that appends blindly would double-count. Throwing marks the run
 * failed and holds the watermark, so the batch is retried rather than skipped.
 */
export interface IntegrationDestination {
  /** Per-sync config the admin fills in when pointing a collection at it. */
  settingFields: readonly IntegrationConfigField[];
  /** Send one batch. Throwing retries it; returning marks it delivered. */
  push(ctx: DestinationPushContext): Promise<void>;
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
  /**
   * This provider needs the ROW, not just the fact that it changed.
   *
   * A CRM cannot upsert a contact from `{collection, event, id}`. Opting in
   * puts the record on {@link IntegrationEvent.record} — and because that means
   * row contents leave the instance, the connect UI says so before an admin
   * connects it, and the event filter is the way to scope which collections.
   */
  recordPayload?: boolean;
  /** Present only on providers connected via OAuth rather than a pasted key. */
  oauth?: IntegrationOAuth;
  /** Present only on providers that can pull rows in. Implies `source` in
   *  `capabilities`; the registry test enforces the two agree. */
  source?: IntegrationSource;
  /** Present only on providers that can receive rows. Implies `destination`
   *  in `capabilities`; the registry test enforces the two agree. */
  destination?: IntegrationDestination;
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
