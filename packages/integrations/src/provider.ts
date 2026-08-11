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

/**
 * What a provider declares about the pace it will accept.
 *
 * Lives here rather than in `./throttle` so the descriptor type stays free of
 * a dependency on the implementation that consumes it — throttle imports this,
 * not the other way round.
 */
export interface RateLimit {
  /** Sustained requests per second. Must be > 0. */
  rps: number;
  /**
   * How many requests may go at once before pacing kicks in.
   *
   * Defaults to one second's worth. Raising it buys a faster start on a
   * provider that tolerates a burst; lowering it to 1 makes every request wait
   * its full interval, which is what a strict per-second quota wants.
   */
  burst?: number;
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
  | "crm"
  | "marketing"
  /** A sales channel a seller's orders arrive from and their stock goes out to. */
  | "marketplace"
  /**
   * Something that moves a parcel: a courier, or an aggregator fronting many.
   *
   * The category is the CONTRACT — book a shipment, get a tracking number and a
   * label; ask where it is; cancel it — rather than a company. An aggregator and
   * a single courier are the same shape from here, which is what lets a national
   * carrier arrive later as one more file.
   */
  | "carrier";

/**
 * What a provider can do. Today every provider is a `sink` (receives events
 * fanned out from backlex). `action` (callable from a flow) and `source`
 * (inbound webhook / scheduled pull that writes back into a collection) are
 * declared here so the catalog and the routes can branch on capability before
 * the first provider implements them.
 */
export type IntegrationCapability = "sink" | "action" | "source" | "destination" | "task";

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

/**
 * One row belonging to a {@link SourceRecord} — an order's line, say.
 *
 * `externalId` only has to be unique WITHIN its parent. The engine qualifies it
 * with the parent's id before it becomes a primary key, which is what lets a
 * provider hand back line numbers starting at 1 on every order without two
 * orders' first lines colliding.
 */
export interface SourceChildRecord {
  externalId: string;
  data: Record<string, unknown>;
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
  /**
   * Rows that belong to this one, grouped by a name the provider chooses
   * (`"items"`, `"discounts"`). Absent for the flat sources — a spreadsheet row
   * has no children.
   *
   * The group name is what the sync's `childMappings` is keyed by, so it is
   * part of the provider's contract: renaming a group orphans an existing
   * sync's mapping the same way renaming an external field would.
   *
   * **Children are upserted, never reconciled.** A line removed at the provider
   * stays in the collection, exactly as a deleted row does everywhere else in
   * this engine — a page walk only ever sees what still exists. Marketplace
   * orders cancel rather than lose lines, so the trade is stated here rather
   * than paid for with a delete-then-insert that would churn ids on every pull.
   */
  children?: Record<string, SourceChildRecord[]>;
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
   * The child groups this source can hand back, for the providers that have any.
   *
   * The same argument as {@link IntegrationDestination.columns}, in the other
   * direction. A group name is already part of a provider's contract — the
   * sync's `childMappings` is keyed by it — but until it is DECLARED, the only
   * way to learn one is to read the provider's source, and a picker has nothing
   * to offer. Undeclared, a mistyped group is not an error either: it simply
   * matches nothing, and the sync imports orders without their lines while
   * reporting a clean run.
   *
   * Absent for the flat sources, and it stays absent rather than becoming an
   * empty list — a spreadsheet row has no children, and "declares none" and
   * "declares nothing" are the same thing to every consumer.
   */
  childGroups?: readonly { key: string; label: string }[];
  /**
   * Fetch one page. Throwing marks the run failed and it is retried with
   * backoff; the cursor is only advanced once a page lands.
   */
  pull(ctx: SourcePullContext): Promise<SourcePullPage>;
}

/** One row on its way OUT, already mapped to the destination's column names. */
export type DestinationRow = Record<string, unknown>;

/**
 * One target a row may be mapped onto, in a destination's closed column set.
 *
 * `when` exists because a provider's columns are not always fixed for the whole
 * provider. An accounting destination writes a customer OR an invoice depending
 * on a setting, and those have nothing in common: offering `dueDate` on a
 * customer sync is a trap the operator only discovers when the column is
 * silently dropped. Declaring the dependency keeps ONE list as the source of
 * truth — the admin picker and the server's save-time check narrow it the same
 * way, through {@link columnsForSettings}, rather than each having its own idea.
 *
 * A column with no `when` always applies.
 */
export interface DestinationColumn {
  value: string;
  label: string;
  /** Setting key → the values that make this column available. */
  when?: Readonly<Record<string, readonly string[]>>;
}

/** Narrow a destination's columns to the ones this sync's settings allow. */
export const columnsForSettings = (
  columns: readonly DestinationColumn[],
  settings: Record<string, unknown>,
): DestinationColumn[] =>
  columns.filter((c) =>
    Object.entries(c.when ?? {}).every(([key, values]) => {
      const v = settings[key];
      return typeof v === "string" && values.includes(v);
    }),
  );

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
  /**
   * A stable, opaque identifier for THIS sync.
   *
   * A warehouse never needs it — the row's own primary key is the whole key.
   * A destination that has to MINT an id in someone else's namespace does:
   * Google Calendar events are addressed by a caller-chosen id, so two syncs
   * mirroring two different collections into one calendar would derive the
   * same event id from two unrelated rows that happen to share a primary key,
   * and each run would overwrite the other's events.
   *
   * Only ever hash it. It is not a secret, but it is not meant to be shown.
   */
  syncKey: string;
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
  /**
   * The closed set of column names a row may be mapped onto.
   *
   * A warehouse leaves this unset: its columns are whatever the operator's DDL
   * declared, and the provider has no list. A provider writing into a
   * structured object — a calendar event has a `summary` and a `start`, not
   * arbitrary columns — declares it, and then an unknown target is refused at
   * the form instead of being dropped on the floor by the provider while the
   * run reports success.
   *
   * Where the set depends on a setting, say so per column with
   * {@link DestinationColumn.when}; this stays the full list.
   */
  columns?: readonly DestinationColumn[];
  /**
   * Rows per `push` call, when the engine's default batch is too big.
   *
   * Warehouses take a batch in one request, so they want it large. A provider
   * with no bulk endpoint issues one or two HTTP calls PER ROW, and a
   * 200-row batch there is 400 subrequests — past what a Worker invocation is
   * allowed. Clamped by the engine; it never enlarges the batch.
   */
  batchSize?: number;
  /**
   * An OAuth scope this direction needs that merely *connecting* does not imply.
   *
   * A provider that gains a capability after people have already connected it
   * leaves those connections holding a narrower grant than the new direction
   * needs — reading a calendar is not permission to write to it. The provider's
   * refusal for that is a 403 at the far end of a scheduled job, which reaches
   * an operator as a paused sync hours later.
   *
   * Declared here, the mismatch is caught when the sync is SAVED, against the
   * scope list the token exchange recorded. Absence of a recorded scope is not
   * treated as denial: some providers return none, and refusing on silence
   * would block connections that are perfectly able to do the work.
   *
   * A list means EVERY one is needed. Xero splits write access per record type
   * (`accounting.contacts` and `accounting.transactions` are separate grants),
   * and a connection reauthorized for this direction receives them together —
   * so requiring both catches exactly the connections that predate it.
   *
   * Not every provider needs one: QuickBooks' single accounting scope is read
   * AND write, so connections made before the write-back existed can already
   * push.
   */
  requiredScope?: string | readonly string[];
  /** Send one batch. Throwing retries it; returning marks it delivered. */
  push(ctx: DestinationPushContext): Promise<void>;
}

// ── Tasks ────────────────────────────────────────────────────────────────────

/**
 * One field a task writes back onto the row it acted on.
 *
 * A closed set, for the same reason a destination declares its columns: the
 * engine refuses an output the provider never declared, so a typo in a provider
 * fails loudly instead of writing a column nobody reads.
 */
export interface TaskOutput {
  key: string;
  label: string;
   /**
   * This output receives the STORED ARTIFACT's storage key rather than a value
   * the provider returned. Exactly one output may claim it, and the task must
   * return an `artifact` when it does.
   *
   * A key rather than a URL, matching how every other stored file in the
   * platform is held: a signed URL expires, and a column full of dead links is
   * worse than one the reader signs on demand.
   */
  artifact?: boolean;
}

/** What a task's `run` receives. */
export interface TaskRunContext {
  /** Connection config — credentials, already decrypted. */
  config: Record<string, unknown>;
  /** Per-invocation settings (which service, which warehouse). Never secret. */
  settings: Record<string, unknown>;
  /**
   * The row this task acts on, as stored. Read-only — a task reports what it
   * did through {@link TaskResult.outputs} and never writes directly, so the
   * engine stays the only thing that touches a collection.
   */
  row: Readonly<Record<string, unknown>>;
  /**
   * Stable for this (integration, task, row) triple, and the same across every
   * retry of it.
   *
   * Pass it to providers that accept an idempotency key. The engine's own
   * once-only guard is the task-run row, which is what protects providers that
   * do not — but a carrier that honours the header refuses the duplicate at
   * its end, which is strictly better than us noticing afterwards.
   */
  idempotencyKey: string;
  fetch: FetchLike;
  str(key: string): string | null;
  setting(key: string): string | null;
}

/** A file a task produced — a carrier's shipping label, typically. */
export interface TaskArtifact {
  /** Which declared output receives the storage key. Must be `artifact: true`. */
  outputKey: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** What a task hands back. */
export interface TaskResult {
  /**
   * Declared output key → value, written onto the row through the caller's
   * mapping. An undeclared key is refused rather than dropped.
   */
  outputs: Record<string, unknown>;
  /** Present when the task produced a file. Stored before anything is written. */
  artifact?: TaskArtifact;
}

/**
 * One thing a provider can be asked to do TO a row.
 *
 * The fourth shape, and the one the first three could not express. A `sink` is
 * told a row changed and answers nothing. A `source` reads rows in on a
 * schedule. A `destination` mirrors a collection out on a watermark. None of
 * them can do "take THIS row, act on it at the provider, and write what came
 * back onto it" — which is what booking a shipment is: one row in, a tracking
 * number and a label PDF out, both belonging on the row that asked.
 *
 * A task is invoked deliberately (from a flow, an admin action, the API), never
 * on a schedule, and runs at most once per row unless it is explicitly re-run.
 */
export interface IntegrationTask {
  id: string;
  label: string;
  /** Per-invocation config the caller supplies. */
  settingFields?: readonly IntegrationConfigField[];
  /** The closed set of fields this task may write back. */
  outputs: readonly TaskOutput[];
  /**
   * Asking again is asking, not doing again.
   *
   * The once-only guard exists because booking a shipment twice costs money and
   * confuses a courier. "Where is this parcel" costs neither: it is a read whose
   * whole point is that the answer changes, and running it under the guard would
   * mean the first poll's `pre_transit` was the last word the row ever heard.
   *
   * So `repeatable` says this task has NO side effect at the provider. The
   * engine still records every run — the history of what a carrier said and
   * when is worth as much as the current value — but it stops short-circuiting
   * to the first run's answer, and a caller that loses the claim race runs
   * anyway rather than reading somebody else's result.
   *
   * Default is false, because the default has to be the safe one: a provider
   * author who does not think about this gets the guard.
   */
  repeatable?: boolean;
  /**
   * Do the thing. Throwing fails the run and the queue retries it with backoff;
   * the engine's task-run row is what stops a retry booking a second shipment.
   */
  run(ctx: TaskRunContext): Promise<TaskResult>;
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
   * The pace this provider will accept, when it publishes one.
   *
   * Declared rather than hand-rolled per provider so the engine can space
   * requests out at the one place every provider's `fetch` comes from. Absent
   * for the providers whose quotas are generous enough that a page walk never
   * approaches them — those still get 429 classification, just no pacing.
   */
  limits?: RateLimit;
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
  /** Present only on providers that act on a single row. Implies `task` in
   *  `capabilities`; the registry test enforces the two agree. */
  tasks?: readonly IntegrationTask[];
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
