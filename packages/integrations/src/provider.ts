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
 * fanned out from backlex). `action` (callable from a flow) is declared here so
 * the catalog and the routes can branch on capability before the first provider
 * implements it.
 *
 * `webhook` is the one capability that is not something backlex DOES: it says
 * the provider will call us. It is declared alongside the rest because every
 * consumer — the catalog, the connect UI, the sync form — has to branch on it
 * the same way it branches on the others.
 */
export type IntegrationCapability =
  | "sink"
  | "action"
  | "source"
  | "destination"
  | "task"
  | "webhook"
  /** The provider can put a product on sale — see {@link IntegrationListing}. */
  | "listing";

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
   * A config key whose value REPLACES the redirect URI.
   *
   * eBay's authorization-code flow does not take a URL at all: it takes an
   * "RuName", an opaque handle eBay mints for the application, and the real
   * callback URL is registered against that handle in eBay's own portal. So the
   * value that travels as `redirect_uri` is a credential the admin pastes,
   * not something this instance can derive.
   *
   * The redirect this instance actually serves is unchanged, and it is still
   * what the admin registers at the provider — the catalog reports it. Only the
   * parameter differs. Whatever leg 1 sent is stored on the state row and
   * replayed at exchange time, so the two legs cannot disagree.
   */
  redirectUriFrom?: string;
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

// ── Inbound webhooks ─────────────────────────────────────────────────────────

/**
 * How a delivery proves it came from the provider.
 *
 * Declared rather than inferred because the operator has to be told what to do
 * with the secret, and the three answers need three different sentences: sign
 * with it, send it in a header, send it as a password. Getting that wrong is not
 * a subtle failure — every delivery is rejected — but the reason is invisible
 * from our side, which is exactly the kind of thing worth naming in the UI.
 *
 * The verdict itself is always {@link IntegrationWebhook.verify}: the shape here
 * is what an operator reads, not what the engine trusts.
 */
export type WebhookAuthKind =
  /** HMAC over the raw body, in a header. EasyPost. */
  | "hmac"
  /** The secret itself, in a header the provider lets you name. Trendyol. */
  | "header"
  /** HTTP Basic, with the secret as the password. */
  | "basic";

/** What a webhook verifier receives. Everything it needs and nothing more. */
export interface WebhookVerifyContext {
  /**
   * The exact bytes the provider sent, as text.
   *
   * Never re-serialized on the way here: a signature covers the body it was
   * computed over, and `JSON.parse` → `JSON.stringify` changes key order and
   * whitespace, which is enough to fail every HMAC.
   */
  rawBody: string;
  /** Case-insensitive header read. `null` when absent. */
  header(name: string): string | null;
  /**
   * The secret backlex minted for THIS subscription.
   *
   * Per subscription, not per connection: it is handed to a third party, and a
   * rotation has to be able to invalidate one endpoint without disturbing the
   * credentials the same connection uses to pull orders.
   */
  secret: string;
  /** Connection config — credentials, already decrypted. */
  config: Record<string, unknown>;
  str(key: string): string | null;
  /**
   * HMAC-SHA256 of `message` under `key`, lowercase hex.
   *
   * Handed over rather than imported per provider, for the same reason the
   * payment verifiers share one implementation: two copies of a signing
   * construction are free to drift, and the failure that follows reads as a
   * forged delivery rather than as our own bug.
   */
  hmacSha256Hex(key: string, message: string): Promise<string>;
  /** Compare without leaking the answer through timing. Use it for every digest. */
  safeEqual(a: string, b: string): boolean;
}

/** One row a delivery carries. The push twin of {@link SourceRecord}. */
export interface WebhookRecord {
  /**
   * This record's own event, when a delivery carries more than one kind.
   *
   * Trendyol posts an envelope of packages and each one carries its own status,
   * so a single event on the delivery would describe the first package and
   * misdescribe the rest — and the subscription's filter would keep or drop them
   * together. Falls back to {@link WebhookDelivery.event}, which is what a
   * one-event-per-delivery provider like EasyPost sends.
   */
  event?: string;
  /**
   * The provider's own id for the thing this delivery is about.
   *
   * On an `upsert` landing it is namespaced exactly as a pulled record's is, so
   * a webhook and a poll of the same order converge on ONE row instead of
   * racing to create two. On a `patch` landing it is the value looked for in the
   * subscription's match field — a tracking code, say — and the row that holds
   * it is the row that gets written.
   */
  externalId: string;
  /** Raw external field names → values. Mapped to collection fields by config. */
  data: Record<string, unknown>;
  /** Lines belonging to this record, for the providers that send them. */
  children?: Record<string, SourceChildRecord[]>;
}

/** What one delivery turned out to be. */
export interface WebhookDelivery {
  /**
   * The declared event key this delivery is. Recorded even when it carries no
   * records, because "the provider is calling and we are ignoring it" is a
   * different fact from "nothing arrived", and only one of them is a problem.
   */
  event: string;
  /** Empty for a ping, or for an event that says nothing about a row. */
  records: WebhookRecord[];
  /**
   * The provider's own id for this delivery, when it has one.
   *
   * It is what makes a retry a duplicate rather than a second write. A provider
   * that sends none gets a digest of the body instead — see the engine — which
   * is weaker (two genuine identical deliveries collapse) but never wrong in the
   * direction that matters: a replay cannot re-apply.
   */
  deliveryId?: string;
}

/** What a webhook parser receives. */
export interface WebhookParseContext {
  rawBody: string;
  header(name: string): string | null;
  /** Already-verified JSON body, when the body parsed as JSON. Else `null`. */
  json: unknown;
  config: Record<string, unknown>;
  str(key: string): string | null;
}

/** What a registration call receives. */
export interface WebhookRegisterContext {
  config: Record<string, unknown>;
  /** The public URL the provider must POST deliveries to. */
  url: string;
  /** The secret it must sign with, or send back, per {@link WebhookAuthKind}. */
  secret: string;
  /** Event keys this subscription wants. Empty means every declared event. */
  events: readonly string[];
  fetch: FetchLike;
  str(key: string): string | null;
}

/**
 * A provider that calls US when something changes.
 *
 * The fifth shape, and the first one where backlex is the server. It exists
 * because polling is the wrong instrument for two things this engine already
 * does: a parcel's progress (a tracker poll is a request per parcel per hour,
 * and still late), and a marketplace order's status (a 14-day window walked
 * every few minutes to notice one cancellation).
 *
 * It is deliberately NOT a new pipe. A delivery lands through the same sync row
 * a pull would have used — same collection, same mapping, same id namespace — so
 * a webhook is a faster way to feed a sync rather than a second, parallel path
 * that would duplicate every row and every mapping decision. A provider with no
 * `source` still gets a sync row; it just has nothing to poll.
 *
 * The poll is kept even where a webhook exists. Every provider's webhooks are
 * lossy — an endpoint that was down for an hour is an hour of events nobody will
 * re-send — and a sync that also polls repairs itself. Turning the interval down
 * is the operator's call, not ours.
 */
export interface IntegrationWebhook {
  /** What the operator does with the secret, for the UI to explain. */
  auth: WebhookAuthKind;
  /**
   * The header the secret or its signature arrives in.
   *
   * Named here so the engine can log a missing one usefully, and so a provider
   * that lets the operator choose (Trendyol's `x-api-key`) is documented in the
   * one place a reader looks.
   */
  header?: string;
  /** The event keys this provider will send, for the subscription's filter. */
  events: readonly { key: string; label: string }[];
  /**
   * How a delivery's records land.
   *
   * `upsert` — the delivery IS the record, and it lands as a pull would. A
   * marketplace order webhook.
   *
   * `patch` — the delivery is ABOUT a row we already have, and only the fields
   * it carries are written. A carrier's tracking update: the fulfillment was
   * created by a person and a booking task, and a webhook that upserted would
   * mint a second, emptier row beside it.
   *
   * One value per provider rather than per event, because no provider yet sends
   * both. When one does, this moves onto the event and the provider's default
   * stays here — the engine reads it through one accessor for that reason.
   */
  landing: "upsert" | "patch";
  /**
   * What the match field holds, for the form to label. `patch` only.
   *
   * The operator is choosing a column, and "tracking code" is the difference
   * between choosing the right one and choosing the shipment id that looks just
   * like it.
   */
  matchLabel?: string;
  /**
   * Is this delivery genuinely from the provider?
   *
   * Returning false rejects it with a 400 and records the rejection. It must not
   * throw for a bad signature — a throw is reserved for "we could not decide",
   * which the engine answers with a 5xx so the provider retries.
   */
  verify(ctx: WebhookVerifyContext): Promise<boolean> | boolean;
  /**
   * What did it say?
   *
   * `null` for a body this provider does not recognise, which is recorded as
   * ignored rather than failed — providers send pings, and new event kinds
   * appear without warning.
   */
  parse(ctx: WebhookParseContext): WebhookDelivery | null;
  /**
   * Tell the provider where to call, using the connection's own credentials.
   *
   * Optional, and worth having wherever it is possible: both providers that
   * ship with this support it, and the alternative is an operator pasting a URL
   * and a secret into an API neither of them exposes through a UI. Returns the
   * provider's id for the registration so it can be removed again.
   */
  register?(ctx: WebhookRegisterContext): Promise<{ id: string }>;
  /** Remove a registration this provider made. Best-effort by contract. */
  unregister?(ctx: WebhookRegisterContext & { id: string }): Promise<void>;
}

// ── Listings ─────────────────────────────────────────────────────────────────

/**
 * One node in a marketplace's own category tree.
 *
 * Flattened on purpose. Every marketplace here hands the tree back nested —
 * Trendyol as `subCategories`, n11 the same, Çiçeksepeti under
 * `parentCategoryId` — and each nests it differently enough that a shared
 * consumer would have to re-walk three shapes. `parentId` carries the same
 * information, and a flat list is what a searchable picker over ~4,000 nodes
 * actually wants.
 */
export interface ListingCategory {
  id: string;
  name: string;
  parentId: string | null;
  /**
   * A product may only be listed against a leaf, and all four marketplaces say
   * so in their own words ("en alt kırılım"). Derived by the provider from
   * whatever it uses to mean childless, so a consumer never has to know that
   * Trendyol sends `[]` and n11 sends `null`.
   */
  leaf: boolean;
}

/** One value a closed-set attribute will accept. */
export interface ListingAttributeValue {
  id: string;
  name: string;
}

/**
 * What a chosen category demands of a product.
 *
 * The four marketplaces spell these flags four ways — `required` /
 * `isMandatory`, `allowCustom` / `isCustomValue`, `varianter` / `isVariant` —
 * and one of them (Çiçeksepeti) encodes a third state in a Turkish `type`
 * string rather than a boolean. Normalising here is what lets ONE attribute
 * mapper serve all of them instead of four near-identical forms.
 */
export interface ListingAttribute {
  id: string;
  name: string;
  /** The listing is refused without it. */
  required: boolean;
  /** Free text is accepted, instead of or as well as a listed value. */
  allowCustom: boolean;
  /**
   * Two products differing only here are one product with two variants.
   *
   * Trendyol and n11 both express this the same way — same `productMainId`,
   * different value on a `varianter` attribute — which is why a variant is a
   * child ROW here rather than a second product.
   */
  variant: boolean;
  /** More than one value may be sent. */
  multiple: boolean;
  /**
   * The closed set. Empty when the attribute is free text only.
   *
   * Held inline because three of the four providers return values with the
   * attribute. Hepsiburada is the exception — it needs a second call per
   * attribute — so a provider is free to make that call itself rather than the
   * shape growing a lazy variant for one marketplace.
   */
  values: readonly ListingAttributeValue[];
}

/** One entry in a searchable registry a listing has to name — a brand. */
export interface ListingOption {
  id: string;
  name: string;
}

/** What the taxonomy reads receive. No settings: the operator is still filling
 *  the form the settings would come from, so only the connection exists yet. */
export interface ListingCatalogContext {
  /** Connection config — credentials, already decrypted. */
  config: Record<string, unknown>;
  fetch: FetchLike;
  str(key: string): string | null;
}

/**
 * One value bound to one of the category's attributes.
 *
 * Exactly one of `valueId` / `custom` is set. Which one is not the operator's
 * preference but the attribute's: a closed-set attribute is refused with free
 * text, and an attribute with no values has nothing to pick from.
 */
export interface ListingAttributeBinding {
  attributeId: string;
  valueId?: string;
  custom?: string;
}

/**
 * One sellable unit on its way out.
 *
 * A product with no variant collection has exactly one of these, built from the
 * product row itself — so a provider never branches on whether a workspace
 * models variants.
 */
export interface ListingVariant {
  /** The collection row this unit came from, for the writeback. */
  rowId: string;
  /**
   * What the provider will echo back in its verdict.
   *
   * The seller's own stock code, and the ONLY thing that ties an asynchronous
   * verdict to the row that asked for it: none of these marketplaces returns
   * our request id, and every one of them echoes the stock code. A provider
   * must send this as whatever field its API echoes.
   */
  reference: string;
  /** Mapped listing fields, already narrowed to the declared columns. */
  fields: DestinationRow;
  attributes: readonly ListingAttributeBinding[];
}

/** One product, with its variants and its category resolved. */
export interface ListingProduct {
  /** The product row's primary key. */
  rowId: string;
  /**
   * Groups this product's variants at the marketplace.
   *
   * Trendyol and n11 both call it `productMainId` and both use it to decide
   * that two barcodes are one product page. Derived from the row's primary key
   * so it is stable across runs — a changed value orphans the page.
   */
  groupId: string;
  /** The leaf category this product was mapped to. */
  categoryId: string;
  fields: DestinationRow;
  variants: readonly ListingVariant[];
}

/** What `publish` receives. */
export interface ListingPublishContext {
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
  /** Never empty — the engine skips the call when there is nothing to send. */
  products: readonly ListingProduct[];
  fetch: FetchLike;
  str(key: string): string | null;
  setting(key: string): string | null;
}

/**
 * What one `publish` call started.
 *
 * Every marketplace here answers a create with a queue ticket rather than a
 * result — Trendyol a `batchRequestId`, n11 a task `id`, Çiçeksepeti a
 * `batchId` — so there is no synchronous form to model. The ticket is stored
 * and polled; it is the only thing that can ever say whether a listing landed.
 */
export interface ListingBatch {
  /** The provider's own id for the queued work. */
  batchId: string;
  /**
   * Units this call already has the final answer for.
   *
   * Two shapes reach it. A marketplace that refuses part of a request before
   * queueing anything reports those refusals here, and the rest are polled —
   * Trendyol, n11 and Çiçeksepeti all do that. And a marketplace whose publish
   * is SYNCHRONOUS reports every unit here, accepted ones included: eBay
   * answers `createOffer`/`publishOffer` with a listing id or an error, so
   * there is no ticket to poll and `batchId` is empty.
   *
   * It was called `rejected` until eBay arrived, which is when the name started
   * to lie. What it always meant is "settled": nothing here is pending, so
   * nothing here is polled.
   */
  settled?: readonly ListingVerdict[];
}

/** What became of one unit. */
export interface ListingVerdict {
  /** {@link ListingVariant.reference} — how the engine finds the row again. */
  reference: string;
  /** `pending` keeps the batch open; the other two close that unit. */
  status: "pending" | "accepted" | "rejected";
  /** The marketplace's own id for the listing, when it returns one. */
  externalId?: string;
  /** Verbatim from the provider. Shown to the operator, never parsed. */
  errors?: readonly string[];
}

/** What `poll` receives. */
export interface ListingPollContext {
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
  batchId: string;
  fetch: FetchLike;
  str(key: string): string | null;
  setting(key: string): string | null;
}

/**
 * A provider that puts a product ON SALE, rather than moving one that sold.
 *
 * The sixth shape, and the first one that cannot be configured from a static
 * declaration. Every other shape's form is knowable when the provider is
 * written: a `source` declares its settings, a `destination` declares its
 * columns. A listing's form is a QUESTION ONLY THE PROVIDER CAN ANSWER — which
 * of ~4,000 categories, and then which of the ~24 attributes that category
 * demands, with which of the hundreds of values each attribute allows. None of
 * that fits `IntegrationConfigField.options`, and none of it is the same twice.
 *
 * So a listing provider is INTERROGATED at form-fill time ({@link categories},
 * {@link attributes}, {@link lookup}) and the operator's answers are stored as a
 * mapping per local category. That is the whole reason this is a shape rather
 * than a destination with more columns.
 *
 * It is deliberately NOT a `destination`. A destination mirrors rows out and
 * hears nothing back; a listing is refused, one unit at a time, minutes later,
 * with a reason a person has to read. The writeback is the feature.
 */
export interface IntegrationListing {
  /** Per-sync config — a shipment template name, a handling time. */
  settingFields?: readonly IntegrationConfigField[];
  /**
   * The closed set of listing fields a product row may be mapped onto.
   *
   * The same declaration a {@link IntegrationDestination} makes, and read the
   * same way, so `columnsForSettings` narrows both.
   */
  columns: readonly DestinationColumn[];
  /**
   * The same, for a variant row.
   *
   * Absent for a marketplace that has no per-unit fields worth mapping. When a
   * workspace models no variants the product row is mapped through BOTH lists,
   * which is what makes "no variant collection" a configuration rather than a
   * branch every provider would have to write.
   */
  variantColumns?: readonly DestinationColumn[];
  /**
   * Which declared variant column the provider's verdicts echo.
   *
   * The engine reads this column off each unit to build
   * {@link ListingVariant.reference}, and matches verdicts back on it. It has to
   * be declared because the answer differs per marketplace and only the
   * provider knows it — Trendyol echoes the `barcode` it was sent, Çiçeksepeti
   * echoes the `stockCode`. Guessing would mean every verdict from one of them
   * silently matched nothing, which reads as "still pending" forever.
   *
   * Must name a value in {@link variantColumns} (or {@link columns} when a
   * provider declares no variant columns); the registry test enforces it.
   */
  referenceColumn: string;
  /** The closed set of fields a verdict writes back onto the row. */
  outputs: readonly TaskOutput[];
  /**
   * Registries a listing has to name that are not categories — Trendyol's
   * brand list, which is a quarter of a million rows and therefore searched
   * rather than browsed.
   */
  lookups?: readonly { key: string; label: string }[];
  /** The whole tree, flattened. Cached by the engine; it changes rarely and is
   *  hundreds of kilobytes. */
  categories(ctx: ListingCatalogContext): Promise<ListingCategory[]>;
  /** What one leaf category demands. */
  attributes(ctx: ListingCatalogContext & { categoryId: string }): Promise<ListingAttribute[]>;
  /** Search one declared registry. Paged, because brand lists are not browsable. */
  lookup?(
    ctx: ListingCatalogContext & { lookup: string; query: string; cursor: string | null },
  ): Promise<{ items: ListingOption[]; cursor: string | null }>;
  /**
   * Send a batch. Throwing retries it; the engine's batch row is what stops a
   * retry listing the same product twice.
   */
  publish(ctx: ListingPublishContext): Promise<ListingBatch>;
  /**
   * Ask what became of a batch. Called on a schedule until nothing is `pending`.
   *
   * A verdict for a reference the batch never carried is dropped, so a provider
   * that reports a whole queue rather than one batch is safe to implement
   * literally.
   */
  poll(ctx: ListingPollContext): Promise<ListingVerdict[]>;
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
  /** Present only on providers that call us. Implies `webhook` in
   *  `capabilities`; the registry test enforces the two agree. */
  webhook?: IntegrationWebhook;
  /** Present only on providers that can put a product on sale. Implies
   *  `listing` in `capabilities`; the registry test enforces the two agree. */
  listing?: IntegrationListing;
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
